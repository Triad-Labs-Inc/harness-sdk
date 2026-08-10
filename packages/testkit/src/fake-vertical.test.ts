import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHarness, createMemoryStore, type HarnessEvent } from "@triadlabs/harness";
import { describe, expect, it } from "vitest";

import { fakeProvider, FakeProviderController } from "./fake-provider.js";

async function waitFor(predicate: () => boolean, timeout = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("fake provider vertical slice", () => {
  it("sends, streams, persists, subscribes, resolves interactions, queues, and interrupts", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "harness-fake-"));
    const controller = new FakeProviderController();
    controller.enqueue(
      controller.script(
        { type: "text", chunks: ["hel", "lo"] },
        { type: "permission", id: "permission-1", toolName: "write" },
        {
          type: "input",
          id: "input-1",
          questions: [
            {
              id: "database",
              prompt: "Database?",
              options: [{ value: "sqlite", label: "SQLite" }],
              allowFreeText: true,
            },
          ],
        },
        { type: "delay", ms: 30 },
        { type: "complete" },
      ),
      controller.script({ type: "text", chunks: ["second"] }, { type: "complete" }),
      controller.script({ type: "delay", ms: 5_000 }, { type: "complete" }),
    );
    const harness = await createHarness({
      homeDir,
      providers: { fake: fakeProvider(controller) },
      store: createMemoryStore(),
      textDeltaCoalesceMs: 5,
    });
    const session = await harness.sessions.create({ provider: "fake", cwd: homeDir });
    const snapshot = await session.snapshot();
    const delivered: HarnessEvent[] = [];
    const subscription = await session.subscribe(
      { afterSequence: snapshot.sequence },
      {
        onEvent: async (event) => {
          const persisted = await session.history({ afterSequence: event.sequence - 1, limit: 1 });
          expect(persisted.events[0]?.id).toBe(event.id);
          delivered.push(event);
          if (event.type === "permission.requested") {
            await session.respondToPermission(event.data.requestId, { decision: "allow_once" });
          }
          if (event.type === "input.requested") {
            await session.respondToInput(event.data.requestId, {
              answers: { database: ["sqlite"] },
            });
          }
        },
      },
    );

    const first = await session.send({ text: "first" });
    const second = await session.send({ text: "second" });
    await waitFor(() => controller.starts.length === 1);
    expect((await session.snapshot()).turns.map((turn) => turn.state)).toContain("queued");
    await session.steer({ text: "stay deterministic" });
    await expect(first.done()).resolves.toEqual({ status: "completed" });
    await expect(second.done()).resolves.toEqual({ status: "completed" });

    expect(controller.maxActive).toBe(1);
    expect(controller.steering).toEqual(["stay deterministic"]);
    expect(controller.permissionResponses[0]?.decision).toEqual({ decision: "allow_once" });
    expect(controller.inputResponses[0]?.response.answers).toEqual({ database: ["sqlite"] });
    expect(
      delivered.some((event) => event.type === "message.delta" && event.data.delta === "hello"),
    ).toBe(true);
    expect(delivered.every((event) => event.raw === undefined)).toBe(true);

    const replayed: HarnessEvent[] = [];
    const replay = await session.subscribe(
      { afterSequence: snapshot.sequence },
      { onEvent: (event) => void replayed.push(event) },
    );
    await waitFor(() => replayed.some((event) => event.type === "turn.completed"));
    expect(replayed.map((event) => event.sequence)).toEqual(
      [...replayed.map((event) => event.sequence)].sort((left, right) => left - right),
    );

    const interrupted = await session.send({ text: "interrupt me" });
    await waitFor(() => controller.starts.length === 3);
    await session.interrupt();
    await expect(interrupted.done()).resolves.toMatchObject({ status: "interrupted" });

    await replay.close();
    await subscription.close();
    await harness.close();
    await harness.close();
    expect(controller.closed).toBe(1);
  });
});
