import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createHarness,
  createMemoryStore,
  type HarnessEvent,
  type PermissionDecision,
  type ProviderAdapterV1,
  type Session,
  UnsupportedCapabilityError,
} from "@triadlabs/harness";
import { describe, expect, it } from "vitest";

export type ProviderContractScenario =
  | "stream"
  | "tools"
  | "permission_allow_once"
  | "permission_allow_session"
  | "permission_deny"
  | "permission_cancel"
  | "questions"
  | "interrupt"
  | "failed"
  | "crash"
  | "unknown"
  | "resume";

export type ProviderContractFactory = (
  scenario: ProviderContractScenario,
) => ProviderAdapterV1 | Promise<ProviderAdapterV1>;

async function fixture(
  factory: ProviderContractFactory,
  scenario: ProviderContractScenario,
  idleTimeoutMs = 600_000,
) {
  const homeDir = await mkdtemp(join(tmpdir(), `harness-provider-${scenario}-`));
  const adapter = await factory(scenario);
  const harness = await createHarness({
    homeDir,
    providers: { [adapter.id]: adapter },
    store: createMemoryStore(),
    idleTimeoutMs,
    textDeltaCoalesceMs: 0,
  });
  const session = await harness.sessions.create({ provider: adapter.id, cwd: homeDir });
  return { harness, session, adapter };
}

async function collect(session: Session): Promise<{
  events: HarnessEvent[];
  close(): Promise<void>;
}> {
  const snapshot = await session.snapshot();
  const events: HarnessEvent[] = [];
  const subscription = await session.subscribe(
    { afterSequence: snapshot.sequence },
    { onEvent: (event) => void events.push(event) },
  );
  return { events, close: () => subscription.close() };
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeout = 3_000,
): Promise<void> {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > timeout) throw new Error("Timed out waiting for provider event");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function decisionFor(scenario: ProviderContractScenario): PermissionDecision {
  switch (scenario) {
    case "permission_allow_session":
      return { decision: "allow_session" };
    case "permission_deny":
      return { decision: "deny", reason: "contract fixture" };
    case "permission_cancel":
      return { decision: "cancel_turn", reason: "contract fixture" };
    default:
      return { decision: "allow_once" };
  }
}

export function providerContract(name: string, factory: ProviderContractFactory): void {
  describe(`${name} provider contract`, () => {
    it("reports ready status and explicit capabilities", async () => {
      const { harness, adapter } = await fixture(factory, "stream");
      await expect(harness.providers[adapter.id]!.status()).resolves.toMatchObject({
        state: "ready",
      });
      const capabilities = await harness.providers[adapter.id]!.capabilities();
      expect(capabilities).toMatchObject({
        interruption: true,
        permissions: true,
        questions: true,
        sessionResume: true,
        modelOverride: true,
        reasoningOverride: true,
        rawEvents: true,
      });
      expect(Object.keys(capabilities).sort()).toEqual(
        [
          "steering",
          "interruption",
          "permissions",
          "questions",
          "sessionResume",
          "modelOverride",
          "reasoningOverride",
          "rawEvents",
        ].sort(),
      );
      expect(Object.values(capabilities).every((value) => typeof value === "boolean")).toBe(true);
      await harness.close();
    });

    it("streams ordered output and completes", async () => {
      const { harness, session } = await fixture(factory, "stream");
      const observed = await collect(session);
      const result = await (await session.send({ text: "stream" })).done();
      await waitFor(() => observed.events.some((event) => event.type === "turn.completed"));
      expect(result).toEqual({ status: "completed" });
      expect(observed.events.map((event) => event.type)).toEqual(
        expect.arrayContaining([
          "turn.queued",
          "turn.started",
          "message.started",
          "message.delta",
          "message.completed",
          "turn.completed",
        ]),
      );
      const sequences = observed.events.map((event) => event.sequence);
      expect(sequences).toEqual([...sequences].sort((left, right) => left - right));
      expect((await session.snapshot()).messages).toEqual([
        expect.objectContaining({ role: "assistant", text: "onetwo", completed: true }),
      ]);
      await observed.close();
      await harness.close();
    });

    it("normalizes tool lifecycle events", async () => {
      const { harness, session } = await fixture(factory, "tools");
      await expect((await session.send({ text: "tools" })).done()).resolves.toEqual({
        status: "completed",
      });
      const history = await session.history({ limit: 100 });
      expect(history.events.filter((event) => event.type === "tool.started")).toHaveLength(1);
      expect(history.events.filter((event) => event.type === "tool.completed")).toHaveLength(1);
      await harness.close();
    });

    for (const scenario of [
      "permission_allow_once",
      "permission_allow_session",
      "permission_deny",
      "permission_cancel",
    ] as const) {
      it(`translates ${scenario.replace("permission_", "")} permission decisions`, async () => {
        const { harness, session } = await fixture(factory, scenario);
        const snapshot = await session.snapshot();
        const subscription = await session.subscribe(
          { afterSequence: snapshot.sequence },
          {
            onEvent: async (event) => {
              if (event.type === "permission.requested") {
                await session.respondToPermission(event.data.requestId, decisionFor(scenario));
              }
            },
          },
        );
        const result = await (await session.send({ text: scenario })).done();
        if (scenario === "permission_cancel") expect(result.status).toBe("interrupted");
        else expect(result.status).toBe("completed");
        const final = await session.snapshot();
        expect(final.interactions[0]?.status).toBe("resolved");
        await subscription.close();
        await harness.close();
      });
    }

    it("translates single, multiple, and free-text questions", async () => {
      const { harness, session } = await fixture(factory, "questions");
      const snapshot = await session.snapshot();
      const subscription = await session.subscribe(
        { afterSequence: snapshot.sequence },
        {
          onEvent: async (event) => {
            if (event.type === "input.requested") {
              const questions = event.data.request.questions;
              expect(questions).toHaveLength(3);
              expect(questions[1]?.multiple).toBe(true);
              expect(questions[2]?.allowFreeText).toBe(true);
              await session.respondToInput(event.data.requestId, {
                answers: {
                  [questions[0]!.id]: ["yes"],
                  [questions[1]!.id]: ["one", "two"],
                  [questions[2]!.id]: ["typed response"],
                },
              });
            }
          },
        },
      );
      await expect((await session.send({ text: "questions" })).done()).resolves.toEqual({
        status: "completed",
      });
      await subscription.close();
      await harness.close();
    });

    it("interrupts an active turn without replay", async () => {
      const { harness, session } = await fixture(factory, "interrupt");
      const turn = await session.send({ text: "interrupt" });
      await waitFor(async () => {
        try {
          await session.interrupt();
          return true;
        } catch {
          return false;
        }
      });
      await expect(turn.done()).resolves.toMatchObject({ status: "interrupted" });
      await harness.close();
    });

    it("enforces the advertised steering capability", async () => {
      const { harness, session, adapter } = await fixture(factory, "interrupt");
      const advertised = await harness.providers[adapter.id]!.capabilities();
      if (!advertised.steering) {
        await expect(session.steer({ text: "unsupported" })).rejects.toBeInstanceOf(
          UnsupportedCapabilityError,
        );
        await harness.close();
        return;
      }
      const turn = await session.send({ text: "interrupt" });
      await waitFor(async () => {
        try {
          await session.steer({ text: "contract steering" });
          return true;
        } catch {
          return false;
        }
      });
      await session.interrupt();
      await turn.done();
      await harness.close();
    });

    it("fails a crashed accepted turn with possible side effects", async () => {
      const { harness, session } = await fixture(factory, "crash");
      await expect((await session.send({ text: "crash" })).done()).resolves.toMatchObject({
        status: "failed",
        error: { code: "PROVIDER_CRASHED" },
        mayHaveSideEffects: true,
      });
      await harness.close();
    });

    it("normalizes a provider-reported failed turn", async () => {
      const { harness, session } = await fixture(factory, "failed");
      const result = await (await session.send({ text: "failed" })).done();
      expect(result).toMatchObject({ status: "failed", mayHaveSideEffects: true });
      if (result.status === "failed") expect(result.error.code).not.toBe("PROVIDER_CRASHED");
      await harness.close();
    });

    it("tolerates unknown provider messages", async () => {
      const { harness, session } = await fixture(factory, "unknown");
      await expect((await session.send({ text: "unknown" })).done()).resolves.toEqual({
        status: "completed",
      });
      const history = await session.history({ limit: 100 });
      expect(history.events).toContainEqual(
        expect.objectContaining({ type: "diagnostic", data: expect.any(Object) }),
      );
      await harness.close();
    });

    it("can reopen a suspended provider session", async () => {
      const { harness, session } = await fixture(factory, "resume", 5);
      await expect((await session.send({ text: "resume-first" })).done()).resolves.toEqual({
        status: "completed",
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      await expect((await session.send({ text: "resume-second" })).done()).resolves.toEqual({
        status: "completed",
      });
      await harness.close();
    });
  });
}
