import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InMemoryStore, SQLiteStore, type SessionId, type TurnId } from "@triadlabs/harness";
import { describe, expect, it } from "vitest";

import { storageContract } from "./storage-contract.js";

storageContract("memory", () => new InMemoryStore());
storageContract("sqlite", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-store-"));
  return new SQLiteStore(join(directory, "harness.sqlite3"));
});

describe("SQLite transactional guarantees", () => {
  it("configures WAL, records migrations, and rolls back a failed projection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-store-atomic-"));
    const store = new SQLiteStore(join(directory, "harness.sqlite3"));
    await store.open();
    expect(store.db.prepare("PRAGMA journal_mode").get()).toMatchObject({ journal_mode: "wal" });
    expect(store.db.prepare("PRAGMA foreign_keys").get()).toMatchObject({ foreign_keys: 1 });
    expect(store.db.prepare("SELECT version FROM schema_migrations").all()).toEqual([
      { version: 1 },
    ]);

    const sessionId = "atomic-session" as SessionId;
    const turnId = "atomic-turn" as TurnId;
    const timestamp = "2026-08-09T00:00:00.000Z";
    await store.createSession({
      id: sessionId,
      provider: "fake",
      cwd: directory,
      state: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await store.acceptTurn({
      id: turnId,
      sessionId,
      state: "queued",
      text: "atomic",
      paused: false,
      createdAt: timestamp,
      request: { text: "atomic" },
    });
    await store.appendEvent({
      sessionId,
      turnId,
      type: "message.started",
      data: { messageId: "duplicate", role: "assistant" },
    });
    const before = await store.latestSequence();
    await expect(
      store.appendEvent({
        sessionId,
        turnId,
        type: "message.started",
        data: { messageId: "duplicate", role: "assistant" },
      }),
    ).rejects.toThrow();
    expect(await store.latestSequence()).toBe(before);
    expect((await store.history(sessionId, { limit: 100 })).events).toHaveLength(3);
    await store.close();
  });
});
