import { randomUUID } from "node:crypto";

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
  SessionId,
  SessionSnapshot,
  TurnId,
  TurnResult,
} from "./types.js";

interface MutableMessage {
  id: string;
  turnId: TurnId;
  role: "assistant" | "user" | "system";
  text: string;
  completed: boolean;
  sequence: number;
}

interface MutableInteraction {
  id: InteractionRequestId;
  turnId: TurnId;
  kind: "permission" | "input";
  status: "pending" | "resolved" | "expired";
  data: Record<string, unknown>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class InMemoryStore implements HarnessStore {
  #sessions = new Map<SessionId, SessionRecord>();
  #turns = new Map<TurnId, TurnRecord>();
  #events: HarnessEvent[] = [];
  #messages = new Map<string, MutableMessage>();
  #interactions = new Map<InteractionRequestId, MutableInteraction>();
  #metadata = new Map<string, unknown>();
  #sequence = 0;
  #tail: Promise<void> = Promise.resolve();
  #closed = false;

  async open(): Promise<void> {
    this.#closed = false;
  }

  async recover(): Promise<RecoveryReport> {
    return await this.#exclusive(() => {
      const failedTurnIds: TurnId[] = [];
      const expiredInteractionIds: InteractionRequestId[] = [];
      const pausedTurnIds: TurnId[] = [];

      for (const turn of this.#turns.values()) {
        if (turn.state === "active") {
          failedTurnIds.push(turn.id);
          this.#appendInternal({
            sessionId: turn.sessionId,
            turnId: turn.id,
            type: "turn.failed",
            data: {
              error: { code: "HOST_RESTARTED", message: "Harness host restarted during the turn" },
              mayHaveSideEffects: true,
            },
          });
        } else if (turn.state === "queued" && !turn.paused) {
          pausedTurnIds.push(turn.id);
          this.#turns.set(turn.id, { ...turn, paused: true });
        }
      }

      for (const interaction of [...this.#interactions.values()]) {
        if (interaction.status !== "pending") continue;
        expiredInteractionIds.push(interaction.id);
        const turn = this.#turns.get(interaction.turnId);
        if (!turn) continue;
        if (interaction.kind === "permission") {
          this.#appendInternal({
            sessionId: turn.sessionId,
            turnId: turn.id,
            type: "permission.resolved",
            data: { requestId: interaction.id, decision: "expired" },
          });
        } else {
          this.#appendInternal({
            sessionId: turn.sessionId,
            turnId: turn.id,
            type: "input.resolved",
            data: { requestId: interaction.id, response: "expired" },
          });
        }
      }
      return { failedTurnIds, expiredInteractionIds, pausedTurnIds };
    });
  }

  async createSession(session: SessionRecord): Promise<HarnessEvent> {
    return await this.#exclusive(() => {
      this.#sessions.set(session.id, clone(session));
      return this.#appendInternal({
        sessionId: session.id,
        type: "session.created",
        data: { provider: session.provider, cwd: session.cwd },
      });
    });
  }

  async getSession(id: SessionId): Promise<SessionRecord | undefined> {
    return await this.#exclusive(() => {
      const session = this.#sessions.get(id);
      return session ? clone(session) : undefined;
    });
  }

  async listSessions(includeArchived: boolean): Promise<readonly SessionRecord[]> {
    return await this.#exclusive(() =>
      [...this.#sessions.values()]
        .filter((session) => includeArchived || session.state !== "archived")
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .map(clone),
    );
  }

  async archiveSession(id: SessionId): Promise<HarnessEvent> {
    return await this.#exclusive(() => {
      const session = this.#requireSession(id);
      this.#sessions.set(id, {
        ...session,
        state: "archived",
        updatedAt: new Date().toISOString(),
      });
      return this.#appendInternal({ sessionId: id, type: "session.archived", data: {} });
    });
  }

  async deleteSession(id: SessionId): Promise<void> {
    await this.#exclusive(() => {
      this.#requireSession(id);
      const turnIds = new Set(
        [...this.#turns.values()].filter((turn) => turn.sessionId === id).map((turn) => turn.id),
      );
      this.#sessions.delete(id);
      for (const turnId of turnIds) this.#turns.delete(turnId);
      for (const [messageId, message] of this.#messages) {
        if (turnIds.has(message.turnId)) this.#messages.delete(messageId);
      }
      for (const [requestId, interaction] of this.#interactions) {
        if (turnIds.has(interaction.turnId)) this.#interactions.delete(requestId);
      }
      this.#events = this.#events.filter((event) => event.sessionId !== id);
      for (const key of [...this.#metadata.keys()]) {
        if (key.startsWith(`${id}:`)) this.#metadata.delete(key);
      }
    });
  }

  async acceptTurn(turn: TurnRecord): Promise<HarnessEvent> {
    return await this.#exclusive(() => {
      this.#requireSession(turn.sessionId);
      this.#turns.set(turn.id, clone(turn));
      return this.#appendInternal({
        sessionId: turn.sessionId,
        turnId: turn.id,
        type: "turn.queued",
        data: { text: turn.text, paused: turn.paused },
      });
    });
  }

  async appendEvent(draft: HarnessEventDraft): Promise<HarnessEvent> {
    return await this.#exclusive(() => this.#appendInternal(draft));
  }

  async getTurn(id: TurnId): Promise<TurnRecord | undefined> {
    return await this.#exclusive(() => {
      const turn = this.#turns.get(id);
      return turn ? clone(turn) : undefined;
    });
  }

  async listQueuedTurns(sessionId: SessionId): Promise<readonly TurnRecord[]> {
    return await this.#exclusive(() =>
      [...this.#turns.values()]
        .filter((turn) => turn.sessionId === sessionId && turn.state === "queued")
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .map(clone),
    );
  }

  async setQueuedPaused(sessionId: SessionId, paused: boolean): Promise<void> {
    await this.#exclusive(() => {
      for (const [id, turn] of this.#turns) {
        if (turn.sessionId === sessionId && turn.state === "queued") {
          this.#turns.set(id, { ...turn, paused });
        }
      }
    });
  }

  async getInteraction(id: InteractionRequestId): Promise<InteractionSnapshot | undefined> {
    return await this.#exclusive(() => {
      const interaction = this.#interactions.get(id);
      return interaction ? clone(interaction) : undefined;
    });
  }

  async snapshot(sessionId: SessionId): Promise<SessionSnapshot> {
    return await this.#exclusive(() => {
      const session = this.#requireSession(sessionId);
      const turns = [...this.#turns.values()]
        .filter((turn) => turn.sessionId === sessionId)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      const turnIds = new Set(turns.map((turn) => turn.id));
      const messages: MessageSnapshot[] = [...this.#messages.values()]
        .filter((message) => turnIds.has(message.turnId))
        .sort((left, right) => left.sequence - right.sequence)
        .map(clone);
      const interactions: InteractionSnapshot[] = [...this.#interactions.values()]
        .filter((interaction) => turnIds.has(interaction.turnId))
        .map(clone);
      return {
        sequence: this.#sequence,
        session: clone(session),
        turns: turns.map(clone),
        messages,
        interactions,
      };
    });
  }

  async history(sessionId: SessionId, options: HistoryOptions = {}): Promise<HistoryPage> {
    return await this.#exclusive(() => {
      this.#requireSession(sessionId);
      const after = Math.max(0, options.afterSequence ?? 0);
      const limit = Math.max(1, Math.min(1_000, options.limit ?? 100));
      const matching = this.#events.filter(
        (event) => event.sessionId === sessionId && event.sequence > after,
      );
      const events = matching.slice(0, limit).map(clone);
      const last = events.at(-1);
      return {
        events,
        ...(last ? { nextSequence: last.sequence } : {}),
        hasMore: matching.length > events.length,
      };
    });
  }

  async latestSequence(): Promise<number> {
    return await this.#exclusive(() => this.#sequence);
  }

  async getProviderMetadata(sessionId: SessionId, key: string): Promise<unknown | undefined> {
    return await this.#exclusive(() => clone(this.#metadata.get(`${sessionId}:${key}`)));
  }

  async setProviderMetadata(sessionId: SessionId, key: string, value: unknown): Promise<void> {
    await this.#exclusive(() => {
      this.#requireSession(sessionId);
      this.#metadata.set(`${sessionId}:${key}`, clone(value));
    });
  }

  async close(): Promise<void> {
    await this.#exclusive(() => {
      this.#closed = true;
    });
  }

  #appendInternal(draft: HarnessEventDraft): HarnessEvent {
    if (this.#closed) throw new Error("Store is closed");
    const event = {
      id: randomUUID() as EventId,
      schemaVersion: 1 as const,
      sequence: ++this.#sequence,
      sessionId: draft.sessionId,
      ...(draft.turnId ? { turnId: draft.turnId } : {}),
      type: draft.type,
      timestamp: draft.timestamp ?? new Date().toISOString(),
      data: clone(draft.data),
      ...(draft.raw === undefined ? {} : { raw: clone(draft.raw) }),
    } as HarnessEvent;
    this.#events.push(event);
    this.#project(event);
    return clone(event);
  }

  #project(event: HarnessEvent): void {
    const turn = event.turnId ? this.#turns.get(event.turnId) : undefined;
    switch (event.type) {
      case "turn.started":
        if (turn)
          this.#turns.set(turn.id, {
            ...turn,
            state: "active",
            paused: false,
            startedAt: event.timestamp,
          });
        break;
      case "turn.completed":
        if (turn) this.#finishTurn(turn, event.timestamp, { status: "completed" });
        break;
      case "turn.failed":
        if (turn)
          this.#finishTurn(turn, event.timestamp, {
            status: "failed",
            error: clone(event.data.error),
            mayHaveSideEffects: event.data.mayHaveSideEffects,
          });
        break;
      case "turn.interrupted":
        if (turn)
          this.#finishTurn(
            turn,
            event.timestamp,
            event.data.reason
              ? { status: "interrupted", reason: event.data.reason }
              : { status: "interrupted" },
          );
        break;
      case "message.started":
        if (event.turnId)
          this.#messages.set(event.data.messageId, {
            id: event.data.messageId,
            turnId: event.turnId,
            role: event.data.role,
            text: "",
            completed: false,
            sequence: event.sequence,
          });
        break;
      case "message.delta": {
        const message = this.#messages.get(event.data.messageId);
        if (message) message.text += event.data.delta;
        break;
      }
      case "message.completed": {
        const message = this.#messages.get(event.data.messageId);
        if (message) {
          if (event.data.text !== undefined) message.text = event.data.text;
          message.completed = true;
        }
        break;
      }
      case "permission.requested":
        if (event.turnId)
          this.#interactions.set(event.data.requestId, {
            id: event.data.requestId,
            turnId: event.turnId,
            kind: "permission",
            status: "pending",
            data: clone(event.data),
          });
        break;
      case "input.requested":
        if (event.turnId)
          this.#interactions.set(event.data.requestId, {
            id: event.data.requestId,
            turnId: event.turnId,
            kind: "input",
            status: "pending",
            data: clone(event.data) as Record<string, unknown>,
          });
        break;
      case "permission.resolved": {
        const interaction = this.#interactions.get(event.data.requestId);
        if (interaction) {
          interaction.status = event.data.decision === "expired" ? "expired" : "resolved";
          interaction.data = { ...interaction.data, resolution: clone(event.data.decision) };
        }
        break;
      }
      case "input.resolved": {
        const interaction = this.#interactions.get(event.data.requestId);
        if (interaction) {
          interaction.status = event.data.response === "expired" ? "expired" : "resolved";
          interaction.data = { ...interaction.data, response: clone(event.data.response) };
        }
        break;
      }
      default:
        break;
    }
    const session = this.#sessions.get(event.sessionId);
    if (session) this.#sessions.set(session.id, { ...session, updatedAt: event.timestamp });
  }

  #finishTurn(turn: TurnRecord, completedAt: string, result: TurnResult): void {
    this.#turns.set(turn.id, {
      ...turn,
      state: result.status,
      paused: false,
      result,
      completedAt,
    });
  }

  #requireSession(id: SessionId): SessionRecord {
    const session = this.#sessions.get(id);
    if (!session) throw new SessionNotFoundError(id);
    return session;
  }

  async #exclusive<T>(operation: () => T | Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.#tail;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
