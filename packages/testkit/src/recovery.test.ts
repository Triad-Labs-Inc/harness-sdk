import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createHarness,
  SQLiteStore,
  type InteractionRequestId,
  type SessionId,
  type SessionRecord,
  type TurnId,
  type TurnRecord,
} from "@triadlabs/harness";
import { describe, expect, it } from "vitest";

import { fakeProvider, FakeProviderController } from "./fake-provider.js";

describe("SQLite host recovery", () => {
  it("reopens completed sessions and durable history through the public API", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "harness-public-reopen-"));
    const firstController = new FakeProviderController();
    firstController.enqueue(
      firstController.script({ type: "text", chunks: ["durable"] }, { type: "complete" }),
    );
    const firstHarness = await createHarness({
      homeDir,
      providers: { fake: fakeProvider(firstController) },
    });
    const created = await firstHarness.sessions.create({ provider: "fake", cwd: homeDir });
    await (await created.send({ text: "persist me" })).done();
    const before = await created.history({ limit: 100 });
    await firstHarness.close();

    const reopened = await createHarness({
      homeDir,
      providers: { fake: fakeProvider(new FakeProviderController()) },
    });
    const loaded = await reopened.sessions.load(created.id);
    const after = await loaded.history({ limit: 100 });
    expect(after.events).toEqual(before.events);
    expect((await loaded.snapshot()).messages[0]?.text).toBe("durable");
    await reopened.close();
  });

  it("fails active work, expires interactions, and requires explicit queue resumption", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "harness-host-recovery-"));
    const databasePath = join(homeDir, "harness.sqlite3");
    const sessionId = randomUUID() as SessionId;
    const activeId = randomUUID() as TurnId;
    const queuedId = randomUUID() as TurnId;
    const requestId = randomUUID() as InteractionRequestId;
    const timestamp = "2026-08-09T00:00:00.000Z";
    const session: SessionRecord = {
      id: sessionId,
      provider: "fake",
      cwd: homeDir,
      state: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const turn = (id: TurnId, text: string): TurnRecord => ({
      id,
      sessionId,
      state: "queued",
      text,
      paused: false,
      createdAt: timestamp,
      request: { text },
    });

    const crashedStore = new SQLiteStore(databasePath);
    await crashedStore.open();
    await crashedStore.createSession(session);
    await crashedStore.acceptTurn(turn(activeId, "accepted active turn"));
    await crashedStore.appendEvent({ sessionId, turnId: activeId, type: "turn.started", data: {} });
    await crashedStore.appendEvent({
      sessionId,
      turnId: activeId,
      type: "permission.requested",
      data: { requestId, title: "Allow fixture?" },
    });
    await crashedStore.acceptTurn(turn(queuedId, "accepted queued turn"));
    await crashedStore.close();

    const controller = new FakeProviderController();
    controller.enqueue(controller.script({ type: "complete" }));
    const harness = await createHarness({
      homeDir,
      providers: { fake: fakeProvider(controller) },
    });
    const loaded = await harness.sessions.load(sessionId);
    let snapshot = await loaded.snapshot();
    expect(snapshot.turns.find((item) => item.id === activeId)?.result).toMatchObject({
      status: "failed",
      error: { code: "HOST_RESTARTED" },
      mayHaveSideEffects: true,
    });
    expect(snapshot.turns.find((item) => item.id === queuedId)?.paused).toBe(true);
    expect(snapshot.interactions.find((item) => item.id === requestId)?.status).toBe("expired");
    expect(controller.starts).toHaveLength(0);

    await loaded.resumeQueue();
    while (controller.starts.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    while (controller.active > 0) await new Promise((resolve) => setTimeout(resolve, 1));
    snapshot = await loaded.snapshot();
    expect(snapshot.turns.find((item) => item.id === queuedId)?.result).toEqual({
      status: "completed",
    });
    await harness.close();
  });
});
