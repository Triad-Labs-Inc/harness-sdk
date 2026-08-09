import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { SessionNotFoundError } from "./errors.js";
import type { HarnessStore, RecoveryReport, SessionRecord, TurnRecord } from "./store.js";
import type {
  EventId,
  HarnessEvent,
  HarnessEventDraft,
  HistoryOptions,
  HistoryPage,
  InteractionRequestId,
  InteractionSnapshot,
  MessageSnapshot,
  SendRequest,
  SessionId,
  SessionSnapshot,
  SessionState,
  TurnId,
  TurnResult,
  TurnState,
} from "./types.js";

type Row = Record<string, unknown>;

const migration1 = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  cwd TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  state TEXT NOT NULL,
  text TEXT NOT NULL,
  request_json TEXT NOT NULL,
  paused INTEGER NOT NULL DEFAULT 0,
  result_json TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS turns_session_created ON turns(session_id, created_at);
CREATE TABLE IF NOT EXISTS events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id TEXT,
  type TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  data_json TEXT NOT NULL,
  raw_json TEXT
);
CREATE INDEX IF NOT EXISTS events_session_sequence ON events(session_id, sequence);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  completed INTEGER NOT NULL,
  sequence INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_session_sequence ON messages(session_id, sequence);
CREATE TABLE IF NOT EXISTS interaction_requests (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  data_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS interactions_session ON interaction_requests(session_id, status);
CREATE TABLE IF NOT EXISTS provider_metadata (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  PRIMARY KEY(session_id, key)
);
`;

function json(value: unknown): string {
  return JSON.stringify(value);
}

function parse<T>(value: unknown): T {
  return JSON.parse(String(value)) as T;
}

export class SQLiteStore implements HarnessStore {
  readonly path: string;
  #db?: DatabaseSync;
  #closed = false;

  constructor(path: string) {
    this.path = resolve(path);
  }

  async open(): Promise<void> {
    if (this.#db?.isOpen) return;
    await mkdir(dirname(this.path), { recursive: true });
    this.#db = new DatabaseSync(this.path, { timeout: 5_000 });
    this.#closed = false;
    this.#db.exec("PRAGMA foreign_keys = ON");
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA synchronous = FULL");
    this.#db.exec("PRAGMA busy_timeout = 5000");
    this.#transaction(() => {
      this.db.exec(migration1);
      this.db
        .prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(1, new Date().toISOString());
    });
  }

  async recover(): Promise<RecoveryReport> {
    return this.#transaction(() => {
      const active = this.db
        .prepare("SELECT id, session_id FROM turns WHERE state = 'active'")
        .all() as Row[];
      const pending = this.db
        .prepare(
          "SELECT id, session_id, turn_id, kind FROM interaction_requests WHERE status = 'pending'",
        )
        .all() as Row[];
      const queued = this.db
        .prepare("SELECT id FROM turns WHERE state = 'queued' AND paused = 0")
        .all() as Row[];

      for (const row of active) {
        this.#appendInternal({
          sessionId: String(row.session_id) as SessionId,
          turnId: String(row.id) as TurnId,
          type: "turn.failed",
          data: {
            error: { code: "HOST_RESTARTED", message: "Harness host restarted during the turn" },
            mayHaveSideEffects: true,
          },
        });
      }
      for (const row of pending) {
        const requestId = String(row.id) as InteractionRequestId;
        const base = {
          sessionId: String(row.session_id) as SessionId,
          turnId: String(row.turn_id) as TurnId,
        };
        if (row.kind === "permission") {
          this.#appendInternal({
            ...base,
            type: "permission.resolved",
            data: { requestId, decision: "expired" },
          });
        } else {
          this.#appendInternal({
            ...base,
            type: "input.resolved",
            data: { requestId, response: "expired" },
          });
        }
      }
      this.db.prepare("UPDATE turns SET paused = 1 WHERE state = 'queued'").run();
      return {
        failedTurnIds: active.map((row) => String(row.id) as TurnId),
        expiredInteractionIds: pending.map((row) => String(row.id) as InteractionRequestId),
        pausedTurnIds: queued.map((row) => String(row.id) as TurnId),
      };
    });
  }

  async createSession(session: SessionRecord): Promise<HarnessEvent> {
    return this.#transaction(() => {
      this.db
        .prepare(
          "INSERT INTO sessions(id, provider, cwd, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          session.id,
          session.provider,
          session.cwd,
          session.state,
          session.createdAt,
          session.updatedAt,
        );
      return this.#appendInternal({
        sessionId: session.id,
        type: "session.created",
        data: { provider: session.provider, cwd: session.cwd },
        timestamp: session.createdAt,
      });
    });
  }

  async getSession(id: SessionId): Promise<SessionRecord | undefined> {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Row | undefined;
    return row ? this.#session(row) : undefined;
  }

  async listSessions(includeArchived: boolean): Promise<readonly SessionRecord[]> {
    const rows = this.db
      .prepare(
        includeArchived
          ? "SELECT * FROM sessions ORDER BY updated_at DESC"
          : "SELECT * FROM sessions WHERE state != 'archived' ORDER BY updated_at DESC",
      )
      .all() as Row[];
    return rows.map((row) => this.#session(row));
  }

  async archiveSession(id: SessionId): Promise<HarnessEvent> {
    return this.#transaction(() => {
      this.#requireSession(id);
      const timestamp = new Date().toISOString();
      this.db
        .prepare("UPDATE sessions SET state = 'archived', updated_at = ? WHERE id = ?")
        .run(timestamp, id);
      return this.#appendInternal({
        sessionId: id,
        type: "session.archived",
        data: {},
        timestamp,
      });
    });
  }

  async deleteSession(id: SessionId): Promise<void> {
    this.#transaction(() => {
      this.#requireSession(id);
      this.db.prepare("DELETE FROM provider_metadata WHERE session_id = ?").run(id);
      this.db.prepare("DELETE FROM interaction_requests WHERE session_id = ?").run(id);
      this.db.prepare("DELETE FROM messages WHERE session_id = ?").run(id);
      this.db.prepare("DELETE FROM events WHERE session_id = ?").run(id);
      this.db.prepare("DELETE FROM turns WHERE session_id = ?").run(id);
      this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    });
  }

  async acceptTurn(turn: TurnRecord): Promise<HarnessEvent> {
    return this.#transaction(() => {
      this.#requireSession(turn.sessionId);
      this.db
        .prepare(
          `INSERT INTO turns(
            id, session_id, state, text, request_json, paused, result_json,
            created_at, started_at, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          turn.id,
          turn.sessionId,
          turn.state,
          turn.text,
          json(turn.request),
          turn.paused ? 1 : 0,
          turn.result ? json(turn.result) : null,
          turn.createdAt,
          turn.startedAt ?? null,
          turn.completedAt ?? null,
        );
      return this.#appendInternal({
        sessionId: turn.sessionId,
        turnId: turn.id,
        type: "turn.queued",
        data: { text: turn.text, paused: turn.paused },
        timestamp: turn.createdAt,
      });
    });
  }

  async appendEvent(draft: HarnessEventDraft): Promise<HarnessEvent> {
    return this.#transaction(() => this.#appendInternal(draft));
  }

  async getTurn(id: TurnId): Promise<TurnRecord | undefined> {
    const row = this.db.prepare("SELECT * FROM turns WHERE id = ?").get(id) as Row | undefined;
    return row ? this.#turn(row) : undefined;
  }

  async listQueuedTurns(sessionId: SessionId): Promise<readonly TurnRecord[]> {
    const rows = this.db
      .prepare("SELECT * FROM turns WHERE session_id = ? AND state = 'queued' ORDER BY created_at")
      .all(sessionId) as Row[];
    return rows.map((row) => this.#turn(row));
  }

  async setQueuedPaused(sessionId: SessionId, paused: boolean): Promise<void> {
    this.db
      .prepare("UPDATE turns SET paused = ? WHERE session_id = ? AND state = 'queued'")
      .run(paused ? 1 : 0, sessionId);
  }

  async getInteraction(id: InteractionRequestId): Promise<InteractionSnapshot | undefined> {
    const row = this.db.prepare("SELECT * FROM interaction_requests WHERE id = ?").get(id) as
      Row | undefined;
    return row ? this.#interaction(row) : undefined;
  }

  async snapshot(sessionId: SessionId): Promise<SessionSnapshot> {
    const session = await this.getSession(sessionId);
    if (!session) throw new SessionNotFoundError(sessionId);
    const turns = (
      this.db
        .prepare("SELECT * FROM turns WHERE session_id = ? ORDER BY created_at")
        .all(sessionId) as Row[]
    ).map((row) => this.#turn(row));
    const messages = (
      this.db
        .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY sequence")
        .all(sessionId) as Row[]
    ).map((row) => this.#message(row));
    const interactions = (
      this.db
        .prepare("SELECT * FROM interaction_requests WHERE session_id = ? ORDER BY rowid")
        .all(sessionId) as Row[]
    ).map((row) => this.#interaction(row));
    return {
      sequence: await this.latestSequence(),
      session,
      turns,
      messages,
      interactions,
    };
  }

  async history(sessionId: SessionId, options: HistoryOptions = {}): Promise<HistoryPage> {
    this.#requireSession(sessionId);
    const after = Math.max(0, options.afterSequence ?? 0);
    const limit = Math.max(1, Math.min(1_000, options.limit ?? 100));
    const rows = this.db
      .prepare(
        `SELECT * FROM events
         WHERE session_id = ? AND sequence > ?
         ORDER BY sequence
         LIMIT ?`,
      )
      .all(sessionId, after, limit + 1) as Row[];
    const hasMore = rows.length > limit;
    const events = rows.slice(0, limit).map((row) => this.#event(row));
    const last = events.at(-1);
    return {
      events,
      ...(last ? { nextSequence: last.sequence } : {}),
      hasMore,
    };
  }

  async latestSequence(): Promise<number> {
    const row = this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'events'").get() as
      Row | undefined;
    return Number(row?.seq ?? 0);
  }

  async getProviderMetadata(sessionId: SessionId, key: string): Promise<unknown | undefined> {
    const row = this.db
      .prepare("SELECT value_json FROM provider_metadata WHERE session_id = ? AND key = ?")
      .get(sessionId, key) as Row | undefined;
    return row ? parse(row.value_json) : undefined;
  }

  async setProviderMetadata(sessionId: SessionId, key: string, value: unknown): Promise<void> {
    this.#requireSession(sessionId);
    this.db
      .prepare(
        `INSERT INTO provider_metadata(session_id, key, value_json) VALUES (?, ?, ?)
         ON CONFLICT(session_id, key) DO UPDATE SET value_json = excluded.value_json`,
      )
      .run(sessionId, key, json(value));
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#db?.close();
  }

  get db(): DatabaseSync {
    if (!this.#db || !this.#db.isOpen || this.#closed) throw new Error("SQLite store is closed");
    return this.#db;
  }

  #appendInternal(draft: HarnessEventDraft): HarnessEvent {
    const id = randomUUID() as EventId;
    const timestamp = draft.timestamp ?? new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO events(
          id, schema_version, session_id, turn_id, type, timestamp, data_json, raw_json
        ) VALUES (?, 1, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        draft.sessionId,
        draft.turnId ?? null,
        draft.type,
        timestamp,
        json(draft.data),
        draft.raw === undefined ? null : json(draft.raw),
      );
    const sequence = Number(result.lastInsertRowid);
    const event = {
      id,
      schemaVersion: 1 as const,
      sequence,
      sessionId: draft.sessionId,
      ...(draft.turnId ? { turnId: draft.turnId } : {}),
      type: draft.type,
      timestamp,
      data: structuredClone(draft.data),
      ...(draft.raw === undefined ? {} : { raw: structuredClone(draft.raw) }),
    } as HarnessEvent;
    this.#project(event);
    this.db
      .prepare("UPDATE sessions SET updated_at = ? WHERE id = ?")
      .run(timestamp, draft.sessionId);
    return event;
  }

  #project(event: HarnessEvent): void {
    switch (event.type) {
      case "turn.started":
        this.db
          .prepare("UPDATE turns SET state = 'active', paused = 0, started_at = ? WHERE id = ?")
          .run(event.timestamp, event.turnId!);
        break;
      case "turn.completed":
        this.#finishTurn(event.turnId!, "completed", { status: "completed" }, event.timestamp);
        break;
      case "turn.failed":
        this.#finishTurn(
          event.turnId!,
          "failed",
          {
            status: "failed",
            error: event.data.error,
            mayHaveSideEffects: event.data.mayHaveSideEffects,
          },
          event.timestamp,
        );
        break;
      case "turn.interrupted":
        this.#finishTurn(
          event.turnId!,
          "interrupted",
          event.data.reason
            ? { status: "interrupted", reason: event.data.reason }
            : { status: "interrupted" },
          event.timestamp,
        );
        break;
      case "message.started":
        this.db
          .prepare(
            `INSERT INTO messages(id, session_id, turn_id, role, text, completed, sequence)
             VALUES (?, ?, ?, ?, '', 0, ?)`,
          )
          .run(
            event.data.messageId,
            event.sessionId,
            event.turnId!,
            event.data.role,
            event.sequence,
          );
        break;
      case "message.delta":
        this.db
          .prepare("UPDATE messages SET text = text || ? WHERE id = ?")
          .run(event.data.delta, event.data.messageId);
        break;
      case "message.completed":
        if (event.data.text === undefined) {
          this.db
            .prepare("UPDATE messages SET completed = 1 WHERE id = ?")
            .run(event.data.messageId);
        } else {
          this.db
            .prepare("UPDATE messages SET text = ?, completed = 1 WHERE id = ?")
            .run(event.data.text, event.data.messageId);
        }
        break;
      case "permission.requested":
        this.db
          .prepare(
            `INSERT INTO interaction_requests(id, session_id, turn_id, kind, status, data_json)
             VALUES (?, ?, ?, 'permission', 'pending', ?)`,
          )
          .run(event.data.requestId, event.sessionId, event.turnId!, json(event.data));
        break;
      case "input.requested":
        this.db
          .prepare(
            `INSERT INTO interaction_requests(id, session_id, turn_id, kind, status, data_json)
             VALUES (?, ?, ?, 'input', 'pending', ?)`,
          )
          .run(event.data.requestId, event.sessionId, event.turnId!, json(event.data));
        break;
      case "permission.resolved":
        this.#resolveInteraction(
          event.data.requestId,
          event.data.decision === "expired" ? "expired" : "resolved",
          { resolution: event.data.decision },
        );
        break;
      case "input.resolved":
        this.#resolveInteraction(
          event.data.requestId,
          event.data.response === "expired" ? "expired" : "resolved",
          { response: event.data.response },
        );
        break;
      default:
        break;
    }
  }

  #resolveInteraction(
    id: InteractionRequestId,
    status: "resolved" | "expired",
    extra: Record<string, unknown>,
  ): void {
    const row = this.db
      .prepare("SELECT data_json FROM interaction_requests WHERE id = ?")
      .get(id) as Row | undefined;
    if (!row) return;
    this.db
      .prepare("UPDATE interaction_requests SET status = ?, data_json = ? WHERE id = ?")
      .run(status, json({ ...parse<Record<string, unknown>>(row.data_json), ...extra }), id);
  }

  #finishTurn(id: TurnId, state: TurnState, result: TurnResult, completedAt: string): void {
    this.db
      .prepare(
        "UPDATE turns SET state = ?, paused = 0, result_json = ?, completed_at = ? WHERE id = ?",
      )
      .run(state, json(result), completedAt, id);
  }

  #session(row: Row): SessionRecord {
    return {
      id: String(row.id) as SessionId,
      provider: String(row.provider),
      cwd: String(row.cwd),
      state: String(row.state) as SessionState,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  #turn(row: Row): TurnRecord {
    return {
      id: String(row.id) as TurnId,
      sessionId: String(row.session_id) as SessionId,
      state: String(row.state) as TurnState,
      text: String(row.text),
      paused: Number(row.paused) === 1,
      ...(row.result_json ? { result: parse<TurnResult>(row.result_json) } : {}),
      createdAt: String(row.created_at),
      ...(row.started_at ? { startedAt: String(row.started_at) } : {}),
      ...(row.completed_at ? { completedAt: String(row.completed_at) } : {}),
      request: parse<SendRequest>(row.request_json),
    };
  }

  #message(row: Row): MessageSnapshot {
    return {
      id: String(row.id),
      turnId: String(row.turn_id) as TurnId,
      role: String(row.role) as MessageSnapshot["role"],
      text: String(row.text),
      completed: Number(row.completed) === 1,
      sequence: Number(row.sequence),
    };
  }

  #interaction(row: Row): InteractionSnapshot {
    return {
      id: String(row.id) as InteractionRequestId,
      turnId: String(row.turn_id) as TurnId,
      kind: String(row.kind) as "permission" | "input",
      status: String(row.status) as "pending" | "resolved" | "expired",
      data: parse<Record<string, unknown>>(row.data_json),
    };
  }

  #event(row: Row): HarnessEvent {
    return {
      id: String(row.id) as EventId,
      schemaVersion: 1,
      sequence: Number(row.sequence),
      sessionId: String(row.session_id) as SessionId,
      ...(row.turn_id ? { turnId: String(row.turn_id) as TurnId } : {}),
      type: String(row.type),
      timestamp: String(row.timestamp),
      data: parse(row.data_json),
      ...(row.raw_json ? { raw: parse(row.raw_json) } : {}),
    } as HarnessEvent;
  }

  #requireSession(id: SessionId): Row {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new SessionNotFoundError(id);
    return row;
  }

  #transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original operation error.
      }
      throw error;
    }
  }
}
