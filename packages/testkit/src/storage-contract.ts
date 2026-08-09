import type {
  HarnessStore,
  InteractionRequestId,
  SessionId,
  SessionRecord,
  TurnId,
  TurnRecord,
} from "@harness-sdk/core";
import { describe, expect, it } from "vitest";

export type StorageContractFactory = () => Promise<HarnessStore> | HarnessStore;

const sid = (value: string) => value as SessionId;
const tid = (value: string) => value as TurnId;
const rid = (value: string) => value as InteractionRequestId;

function session(id: SessionId, provider = "fake"): SessionRecord {
  const timestamp = "2026-01-01T00:00:00.000Z";
  return {
    id,
    provider,
    cwd: "/fixture",
    state: "active",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function turn(id: TurnId, sessionId: SessionId, text = "fixture"): TurnRecord {
  return {
    id,
    sessionId,
    state: "queued",
    text,
    paused: false,
    createdAt: "2026-01-01T00:00:01.000Z",
    request: { text },
  };
}

export function storageContract(name: string, factory: StorageContractFactory): void {
  describe(`${name} storage contract`, () => {
    it("assigns durable store-wide sequences and paginates history", async () => {
      const store = await factory();
      await store.open();
      const firstSession = sid("session-a");
      const secondSession = sid("session-b");
      const createdA = await store.createSession(session(firstSession));
      const createdB = await store.createSession(session(secondSession));
      const accepted = await store.acceptTurn(turn(tid("turn-a"), firstSession));
      const diagnostic = await store.appendEvent({
        sessionId: secondSession,
        type: "diagnostic",
        data: { level: "info", message: "fixture" },
      });
      expect([
        createdA.sequence,
        createdB.sequence,
        accepted.sequence,
        diagnostic.sequence,
      ]).toEqual([1, 2, 3, 4]);
      const firstPage = await store.history(firstSession, { limit: 1 });
      expect(firstPage.events).toHaveLength(1);
      expect(firstPage.hasMore).toBe(true);
      const secondPage = await store.history(firstSession, {
        afterSequence: firstPage.nextSequence!,
        limit: 10,
      });
      expect(secondPage.events.map((event) => event.type)).toEqual(["turn.queued"]);
      await store.close();
    });

    it("updates event projections atomically", async () => {
      const store = await factory();
      await store.open();
      const sessionId = sid("session-projection");
      const turnId = tid("turn-projection");
      const requestId = rid("request-projection");
      await store.createSession(session(sessionId));
      await store.acceptTurn(turn(turnId, sessionId));
      await store.appendEvent({ sessionId, turnId, type: "turn.started", data: {} });
      await store.appendEvent({
        sessionId,
        turnId,
        type: "message.started",
        data: { messageId: "message-1", role: "assistant" },
      });
      await store.appendEvent({
        sessionId,
        turnId,
        type: "message.delta",
        data: { messageId: "message-1", delta: "hello" },
      });
      await store.appendEvent({
        sessionId,
        turnId,
        type: "message.completed",
        data: { messageId: "message-1" },
      });
      await store.appendEvent({
        sessionId,
        turnId,
        type: "permission.requested",
        data: { requestId, title: "Allow?" },
      });
      await store.appendEvent({
        sessionId,
        turnId,
        type: "permission.resolved",
        data: { requestId, decision: { decision: "deny", reason: "fixture" } },
      });
      await store.appendEvent({ sessionId, turnId, type: "turn.completed", data: {} });
      const snapshot = await store.snapshot(sessionId);
      expect(snapshot.turns[0]?.result).toEqual({ status: "completed" });
      expect(snapshot.messages).toEqual([
        expect.objectContaining({ id: "message-1", text: "hello", completed: true }),
      ]);
      expect(snapshot.interactions[0]).toEqual(
        expect.objectContaining({ id: requestId, status: "resolved" }),
      );
      expect(snapshot.sequence).toBe(await store.latestSequence());
      await store.close();
    });

    it("recovers active work, expires callbacks, and pauses queued turns", async () => {
      const store = await factory();
      await store.open();
      const sessionId = sid("session-recovery");
      const activeId = tid("turn-active");
      const queuedId = tid("turn-queued");
      const requestId = rid("request-recovery");
      await store.createSession(session(sessionId));
      await store.acceptTurn(turn(activeId, sessionId, "active"));
      await store.appendEvent({ sessionId, turnId: activeId, type: "turn.started", data: {} });
      await store.appendEvent({
        sessionId,
        turnId: activeId,
        type: "input.requested",
        data: {
          requestId,
          request: {
            id: requestId,
            questions: [{ id: "q", prompt: "Question?", allowFreeText: true }],
          },
        },
      });
      await store.acceptTurn(turn(queuedId, sessionId, "queued"));
      await store.close();

      await store.open();
      const recovery = await store.recover();
      expect(recovery.failedTurnIds).toContain(activeId);
      expect(recovery.expiredInteractionIds).toContain(requestId);
      expect(recovery.pausedTurnIds).toContain(queuedId);
      const snapshot = await store.snapshot(sessionId);
      expect(snapshot.turns.find((item) => item.id === activeId)?.result).toMatchObject({
        status: "failed",
        error: { code: "HOST_RESTARTED" },
        mayHaveSideEffects: true,
      });
      expect(snapshot.turns.find((item) => item.id === queuedId)?.paused).toBe(true);
      expect(snapshot.interactions.find((item) => item.id === requestId)?.status).toBe("expired");
      await store.close();
    });

    it("preserves the sequence high-water mark across hard deletion", async () => {
      const store = await factory();
      await store.open();
      const first = sid("session-delete");
      await store.createSession(session(first));
      const before = await store.latestSequence();
      await store.deleteSession(first);
      expect(await store.latestSequence()).toBe(before);
      const created = await store.createSession(session(sid("session-after-delete")));
      expect(created.sequence).toBeGreaterThan(before);
      await store.close();
    });

    it("stores opaque provider metadata without exposing store internals", async () => {
      const store = await factory();
      await store.open();
      const sessionId = sid("session-metadata");
      await store.createSession(session(sessionId));
      await store.setProviderMetadata(sessionId, "resume", { nativeId: "native" });
      expect(await store.getProviderMetadata(sessionId, "resume")).toEqual({ nativeId: "native" });
      await store.close();
    });
  });
}
