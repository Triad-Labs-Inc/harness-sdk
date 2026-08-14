import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import {
  HarnessClosedError,
  InteractionNotFoundError,
  ProviderUnavailableError,
  SessionDeletedError,
  SessionNotFoundError,
  SlowConsumerError,
  StorageError,
  UnsupportedAdapterVersionError,
  UnsupportedCapabilityError,
  ValidationError,
} from "./errors.js";
import { RotatingFileLogger, type HarnessLogger } from "./logger.js";
import { InMemoryStore } from "./memory-store.js";
import type {
  OpenSessionContext,
  ProviderAdapterV1,
  ProviderContext,
  ProviderEvent,
  ProviderRuntime,
} from "./provider.js";
import { Redactor } from "./redaction.js";
import { SQLiteStore } from "./sqlite-store.js";
import type { HarnessStore, SessionRecord, TurnRecord } from "./store.js";
import type {
  Harness,
  HarnessEvent,
  HarnessEventDraft,
  HistoryOptions,
  HistoryPage,
  InputResponse,
  InteractionRequestId,
  PermissionDecision,
  ProviderCapabilities,
  ProviderRegistration,
  ProviderStatus,
  RawEventPersistence,
  SendRequest,
  Session,
  SessionCreateOptions,
  SessionId,
  SessionManager,
  SessionSnapshot,
  Subscription,
  SubscriptionObserver,
  Turn,
  TurnId,
  TurnResult,
} from "./types.js";

export interface CreateHarnessOptions {
  readonly homeDir: string;
  readonly providers: Readonly<Record<string, ProviderAdapterV1>>;
  readonly store?: HarnessStore;
  readonly rawEvents?: RawEventPersistence;
  readonly logger?: HarnessLogger;
  readonly idleTimeoutMs?: number;
  readonly textDeltaCoalesceMs?: number;
  readonly subscriberBufferSize?: number;
  readonly resumeQueuesOnStartup?: boolean;
}

class AsyncLock {
  #tail = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.#tail;
    this.#tail = new Promise<void>((resolveRelease) => {
      release = resolveRelease;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

class Deferred<T> {
  readonly promise: Promise<T>;
  #resolve!: (value: T) => void;
  #settled = false;

  constructor() {
    this.promise = new Promise((resolvePromise) => {
      this.#resolve = resolvePromise;
    });
  }

  resolve(value: T): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#resolve(value);
  }
}

class BufferedSubscriber implements Subscription {
  readonly #observer: SubscriptionObserver;
  readonly #maxSize: number;
  readonly #remove: () => void;
  #queue: HarnessEvent[] = [];
  #queuedBytes = 0;
  #processing = false;
  #closed = false;
  #lastSequence: number;

  constructor(
    observer: SubscriptionObserver,
    maxSize: number,
    afterSequence: number,
    remove: () => void,
  ) {
    this.#observer = observer;
    this.#maxSize = maxSize;
    this.#lastSequence = afterSequence;
    this.#remove = remove;
  }

  enqueue(event: HarnessEvent): void {
    if (this.#closed || event.sequence <= this.#lastSequence) return;
    const size = Buffer.byteLength(JSON.stringify(event));
    if (
      this.#queue.length + 1 > this.#maxSize ||
      this.#queuedBytes + size > this.#maxSize * 64_000
    ) {
      void this.fail(new SlowConsumerError(this.#lastSequence));
      return;
    }
    this.#queue.push(event);
    this.#queuedBytes += size;
    if (!this.#processing) void this.#pump();
  }

  async replay(event: HarnessEvent): Promise<void> {
    if (this.#closed || event.sequence <= this.#lastSequence) return;
    try {
      await this.#observer.onEvent(event);
      this.#lastSequence = event.sequence;
    } catch (error) {
      await this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  failSlowConsumer(): void {
    void this.fail(new SlowConsumerError(this.#lastSequence));
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#queue = [];
    this.#queuedBytes = 0;
    this.#remove();
  }

  async fail(error: Error): Promise<void> {
    if (this.#closed) return;
    await this.close();
    try {
      await this.#observer.onError?.(error);
    } catch {
      // Subscriber error handlers cannot affect the event pipeline.
    }
  }

  async #pump(): Promise<void> {
    this.#processing = true;
    try {
      while (!this.#closed) {
        const event = this.#queue.shift();
        if (!event) break;
        this.#queuedBytes -= Buffer.byteLength(JSON.stringify(event));
        try {
          await this.#observer.onEvent(event);
          this.#lastSequence = event.sequence;
        } catch (error) {
          await this.fail(error instanceof Error ? error : new Error(String(error)));
        }
      }
    } finally {
      this.#processing = false;
      if (!this.#closed && this.#queue.length > 0) void this.#pump();
    }
  }
}

interface CatchingSubscriber {
  subscriber: BufferedSubscriber;
  boundary: number;
  catching: boolean;
  live: HarnessEvent[];
  liveBytes: number;
}

class SubscriptionHub {
  readonly #store: HarnessStore;
  readonly #lock: AsyncLock;
  readonly #maxSize: number;
  #bySession = new Map<SessionId, Set<CatchingSubscriber>>();

  constructor(store: HarnessStore, lock: AsyncLock, maxSize: number) {
    this.#store = store;
    this.#lock = lock;
    this.#maxSize = maxSize;
  }

  publish(event: HarnessEvent): void {
    for (const entry of this.#bySession.get(event.sessionId) ?? []) {
      if (entry.catching && event.sequence > entry.boundary) {
        const size = Buffer.byteLength(JSON.stringify(event));
        if (
          entry.live.length + 1 > this.#maxSize ||
          entry.liveBytes + size > this.#maxSize * 64_000
        ) {
          entry.subscriber.failSlowConsumer();
          continue;
        }
        entry.live.push(event);
        entry.liveBytes += size;
      } else entry.subscriber.enqueue(event);
    }
  }

  async subscribe(
    sessionId: SessionId,
    afterSequence: number,
    observer: SubscriptionObserver,
  ): Promise<Subscription> {
    let entry!: CatchingSubscriber;
    await this.#lock.run(async () => {
      const boundary = await this.#store.latestSequence();
      const entries = this.#bySession.get(sessionId) ?? new Set<CatchingSubscriber>();
      const subscriber = new BufferedSubscriber(observer, this.#maxSize, afterSequence, () => {
        entries.delete(entry);
        if (entries.size === 0) this.#bySession.delete(sessionId);
      });
      entry = { subscriber, boundary, catching: true, live: [], liveBytes: 0 };
      entries.add(entry);
      this.#bySession.set(sessionId, entries);
    });

    let cursor = afterSequence;
    while (cursor < entry.boundary) {
      const page = await this.#store.history(sessionId, { afterSequence: cursor, limit: 500 });
      const replay = page.events.filter((event) => event.sequence <= entry.boundary);
      for (const event of replay) await entry.subscriber.replay(event);
      const last = replay.at(-1);
      if (!last) break;
      cursor = last.sequence;
    }

    await this.#lock.run(async () => {
      entry.catching = false;
      entry.live.sort((left, right) => left.sequence - right.sequence);
      for (const event of entry.live) entry.subscriber.enqueue(event);
      entry.live = [];
      entry.liveBytes = 0;
    });
    return entry.subscriber;
  }

  async closeSession(sessionId: SessionId, error: Error): Promise<void> {
    const entries = [...(this.#bySession.get(sessionId) ?? [])];
    await Promise.all(entries.map((entry) => entry.subscriber.fail(error)));
  }

  async closeAll(): Promise<void> {
    const entries = [...this.#bySession.values()].flatMap((group) => [...group]);
    await Promise.all(entries.map((entry) => entry.subscriber.close()));
  }
}

class TurnHandle implements Turn {
  readonly id: TurnId;
  readonly #deferred: Deferred<TurnResult>;

  constructor(id: TurnId, deferred: Deferred<TurnResult>) {
    this.id = id;
    this.#deferred = deferred;
  }

  done(): Promise<TurnResult> {
    return this.#deferred.promise;
  }
}

interface RuntimeTurn {
  record: TurnRecord;
  deferred: Deferred<TurnResult>;
}

interface PendingInteraction {
  kind: "permission" | "input";
  providerRequestId: string;
  turnId: TurnId;
}

interface PendingDelta {
  messageId: string;
  text: string;
  raw?: unknown;
  timer: NodeJS.Timeout;
}

class SessionCoordinator {
  readonly #host: HarnessImpl;
  readonly #session: SessionRecord;
  readonly #adapter: ProviderAdapterV1;
  #runtime: ProviderRuntime | undefined;
  #runtimeOpening: Promise<ProviderRuntime> | undefined;
  #queue: RuntimeTurn[] = [];
  #active: RuntimeTurn | undefined;
  #handles = new Map<TurnId, Deferred<TurnResult>>();
  #interactions = new Map<InteractionRequestId, PendingInteraction>();
  #running = false;
  #shuttingDown = false;
  #deleted = false;
  #idleTimer: NodeJS.Timeout | undefined;
  #pendingDelta: PendingDelta | undefined;
  #deltaFlush: Promise<void> | undefined;

  constructor(host: HarnessImpl, session: SessionRecord, adapter: ProviderAdapterV1) {
    this.#host = host;
    this.#session = session;
    this.#adapter = adapter;
  }

  async send(request: SendRequest): Promise<Turn> {
    this.#assertUsable();
    if (!request.text.trim()) throw new ValidationError("Turn text must not be empty");
    const status = await this.#host.providerStatus(this.#adapter);
    if (status.state !== "ready") {
      throw new ProviderUnavailableError(
        this.#adapter.id,
        status.state,
        "message" in status ? status.message : "Provider is not ready",
      );
    }
    const capabilities = await this.#host.providerCapabilities(this.#adapter);
    if (request.model !== undefined && !capabilities.modelOverride)
      throw new UnsupportedCapabilityError("model override", this.#adapter.id);
    if (request.reasoning !== undefined && !capabilities.reasoningOverride)
      throw new UnsupportedCapabilityError("reasoning override", this.#adapter.id);
    if (request.permissionMode !== undefined && !capabilities.permissions)
      throw new UnsupportedCapabilityError("permission mode", this.#adapter.id);

    const now = new Date().toISOString();
    const id = randomUUID() as TurnId;
    const record: TurnRecord = {
      id,
      sessionId: this.#session.id,
      state: "queued",
      text: request.text,
      paused: false,
      createdAt: now,
      request: structuredClone(request),
    };
    const deferred = new Deferred<TurnResult>();
    await this.#host.acceptTurn(record);
    this.#handles.set(id, deferred);
    this.#queue.push({ record, deferred });
    this.#clearIdleTimer();
    void this.#runNext();
    return new TurnHandle(id, deferred);
  }

  async steer(text: string): Promise<void> {
    this.#assertUsable();
    const capabilities = await this.#host.providerCapabilities(this.#adapter);
    if (!capabilities.steering) throw new UnsupportedCapabilityError("steering", this.#adapter.id);
    if (!text.trim()) throw new ValidationError("Steering text must not be empty");
    if (!this.#active || !this.#runtime?.steer)
      throw new ValidationError("There is no active turn to steer");
    await this.#runtime.steer({ text });
  }

  async interrupt(): Promise<void> {
    this.#assertUsable();
    const capabilities = await this.#host.providerCapabilities(this.#adapter);
    if (!capabilities.interruption)
      throw new UnsupportedCapabilityError("interruption", this.#adapter.id);
    if (!this.#active || !this.#runtime?.interrupt)
      throw new ValidationError("There is no active turn to interrupt");
    await this.#runtime.interrupt();
  }

  async respondToPermission(
    requestId: InteractionRequestId,
    decision: PermissionDecision,
  ): Promise<void> {
    this.#assertUsable();
    const pending = this.#interactions.get(requestId);
    if (!pending || pending.kind !== "permission" || !this.#runtime?.respondToPermission)
      throw new InteractionNotFoundError(requestId);
    await this.#host.append({
      sessionId: this.#session.id,
      turnId: pending.turnId,
      type: "permission.resolved",
      data: { requestId, decision },
    });
    this.#interactions.delete(requestId);
    await this.#runtime.respondToPermission({
      providerRequestId: pending.providerRequestId,
      decision,
    });
    if (decision.decision === "cancel_turn") await this.#runtime.interrupt?.();
  }

  async respondToInput(requestId: InteractionRequestId, response: InputResponse): Promise<void> {
    this.#assertUsable();
    const pending = this.#interactions.get(requestId);
    if (!pending || pending.kind !== "input" || !this.#runtime?.respondToInput)
      throw new InteractionNotFoundError(requestId);
    await this.#host.append({
      sessionId: this.#session.id,
      turnId: pending.turnId,
      type: "input.resolved",
      data: { requestId, response },
    });
    this.#interactions.delete(requestId);
    await this.#runtime.respondToInput({ providerRequestId: pending.providerRequestId, response });
  }

  async resumeQueue(): Promise<void> {
    this.#assertUsable();
    const queued = await this.#host.store.listQueuedTurns(this.#session.id);
    await this.#host.store.setQueuedPaused(this.#session.id, false);
    const known = new Set([
      ...this.#queue.map((turn) => turn.record.id),
      ...(this.#active ? [this.#active.record.id] : []),
    ]);
    for (const record of queued) {
      if (known.has(record.id)) continue;
      const deferred = this.#handles.get(record.id) ?? new Deferred<TurnResult>();
      this.#handles.set(record.id, deferred);
      this.#queue.push({ record: { ...record, paused: false }, deferred });
    }
    this.#clearIdleTimer();
    void this.#runNext();
  }

  async shutdown(reason = "Harness closed"): Promise<void> {
    if (this.#shuttingDown) return;
    this.#shuttingDown = true;
    this.#clearIdleTimer();
    await this.#flushDelta();
    const queuedById = new Map(
      this.#queue.splice(0).map((queued) => [queued.record.id, queued] as const),
    );
    for (const [id, deferred] of this.#handles) {
      if (id === this.#active?.record.id || queuedById.has(id)) continue;
      const record = await this.#host.store.getTurn(id);
      if (record?.state === "queued") queuedById.set(id, { record, deferred });
    }
    for (const queued of queuedById.values()) {
      const result: TurnResult = {
        status: "failed",
        error: { code: "HARNESS_CLOSED", message: reason },
        mayHaveSideEffects: false,
      };
      await this.#host.append({
        sessionId: this.#session.id,
        turnId: queued.record.id,
        type: "turn.failed",
        data: { error: result.error, mayHaveSideEffects: false },
      });
      queued.deferred.resolve(result);
    }
    const active = this.#active;
    if (active) {
      // Stop the consumer from committing a provider terminal concurrently
      // while shutdown establishes the authoritative outcome below.
      this.#active = undefined;
      await this.#expireInteractions(active.record.id);
      const runtime = this.#runtime ?? (await this.#runtimeOpening?.catch(() => undefined));
      let interruptError: unknown;
      try {
        await runtime?.interrupt?.();
      } catch (error) {
        interruptError = error;
      }
      const stored = await this.#host.store.getTurn(active.record.id);
      if (stored?.result) {
        active.deferred.resolve(stored.result);
      } else {
        const result: TurnResult = interruptError
          ? {
              status: "failed",
              error: {
                code: "PROVIDER_INTERRUPT_FAILED",
                message:
                  interruptError instanceof Error
                    ? this.#host.redactor.text(interruptError.message)
                    : "Provider interruption failed during shutdown",
              },
              mayHaveSideEffects: true,
            }
          : { status: "interrupted", reason };
        await this.#host.append(
          result.status === "failed"
            ? {
                sessionId: this.#session.id,
                turnId: active.record.id,
                type: "turn.failed",
                data: {
                  error: result.error,
                  mayHaveSideEffects: result.mayHaveSideEffects,
                },
              }
            : {
                sessionId: this.#session.id,
                turnId: active.record.id,
                type: "turn.interrupted",
                data: { reason },
              },
        );
        active.deferred.resolve(result);
      }
    }
    const runtime = this.#runtime ?? (await this.#runtimeOpening?.catch(() => undefined));
    await runtime?.close().catch(() => undefined);
    this.#runtime = undefined;
  }

  markDeleted(): void {
    this.#deleted = true;
  }

  async #runNext(): Promise<void> {
    if (this.#running || this.#active || this.#shuttingDown || this.#deleted) return;
    const next = this.#queue.shift();
    if (!next) {
      this.#scheduleIdle();
      return;
    }
    this.#running = true;
    this.#active = next;
    let terminal = false;
    try {
      await this.#host.append({
        sessionId: this.#session.id,
        turnId: next.record.id,
        type: "turn.started",
        data: {},
      });
      if (this.#shuttingDown || this.#active?.record.id !== next.record.id) return;
      const runtime = await this.#getRuntime();
      if (this.#shuttingDown || this.#active?.record.id !== next.record.id) return;
      for await (const event of runtime.startTurn({
        ...next.record.request,
        sessionId: this.#session.id,
        turnId: next.record.id,
      })) {
        if (this.#shuttingDown || this.#active?.record.id !== next.record.id) break;
        const result = await this.#handleProviderEvent(next, event);
        if (result) {
          terminal = true;
          next.deferred.resolve(result);
          break;
        }
      }
      await this.#flushDelta();
      if (!terminal && !this.#shuttingDown && this.#active?.record.id === next.record.id) {
        const result: TurnResult = {
          status: "failed",
          error: {
            code: "PROVIDER_STREAM_ENDED",
            message: "Provider stream ended without a result",
          },
          mayHaveSideEffects: true,
        };
        await this.#host.append({
          sessionId: this.#session.id,
          turnId: next.record.id,
          type: "turn.failed",
          data: { error: result.error, mayHaveSideEffects: true },
        });
        next.deferred.resolve(result);
      }
    } catch (error) {
      await this.#flushDelta();
      if (!this.#shuttingDown && this.#active?.record.id === next.record.id) {
        const message = this.#host.redactor.text(
          error instanceof Error ? error.message : String(error),
        );
        const storageFailure = error instanceof StorageError;
        const result: TurnResult = {
          status: "failed",
          error: {
            code: storageFailure ? "STORE_WRITE_FAILED" : "PROVIDER_CRASHED",
            message,
          },
          mayHaveSideEffects: true,
        };
        await this.#expireInteractions(next.record.id).catch(() => undefined);
        try {
          await this.#host.append({
            sessionId: this.#session.id,
            turnId: next.record.id,
            type: "turn.failed",
            data: { error: result.error, mayHaveSideEffects: true },
            raw: error instanceof Error ? { name: error.name, message } : { message },
          });
        } catch (terminalError) {
          await this.#host.log("error", "Failed to persist terminal turn failure", {
            turnId: next.record.id,
            error: terminalError instanceof Error ? terminalError.message : String(terminalError),
          });
        }
        next.deferred.resolve(result);
        await this.#runtime?.close().catch(() => undefined);
        this.#runtime = undefined;
        await this.#pauseQueuedAfterCrash();
      }
    } finally {
      if (this.#active?.record.id === next.record.id) this.#active = undefined;
      this.#running = false;
      if (!this.#shuttingDown) void this.#runNext();
    }
  }

  async #handleProviderEvent(
    turn: RuntimeTurn,
    event: ProviderEvent,
  ): Promise<TurnResult | undefined> {
    if (event.type === "message.delta") {
      await this.#queueDelta(turn.record.id, event);
      return undefined;
    }
    await this.#flushDelta();
    const raw = this.#host.rawFor(event.raw, event.type, event.type === "turn.failed");
    switch (event.type) {
      case "message.started":
        await this.#host.append({
          sessionId: this.#session.id,
          turnId: turn.record.id,
          type: "message.started",
          data: { messageId: event.messageId, role: event.role ?? "assistant" },
          ...(raw === undefined ? {} : { raw }),
        });
        return undefined;
      case "message.completed":
        await this.#host.append({
          sessionId: this.#session.id,
          turnId: turn.record.id,
          type: "message.completed",
          data: {
            messageId: event.messageId,
            ...(event.text === undefined ? {} : { text: event.text }),
          },
          ...(raw === undefined ? {} : { raw }),
        });
        return undefined;
      case "tool.started":
        await this.#host.append({
          sessionId: this.#session.id,
          turnId: turn.record.id,
          type: "tool.started",
          data: {
            toolId: event.toolId,
            name: event.name,
            ...(event.input === undefined ? {} : { input: event.input }),
          },
          ...(raw === undefined ? {} : { raw }),
        });
        return undefined;
      case "tool.updated":
        await this.#host.append({
          sessionId: this.#session.id,
          turnId: turn.record.id,
          type: "tool.updated",
          data: { toolId: event.toolId, update: event.update },
          ...(raw === undefined ? {} : { raw }),
        });
        return undefined;
      case "tool.completed":
        await this.#host.append({
          sessionId: this.#session.id,
          turnId: turn.record.id,
          type: "tool.completed",
          data: {
            toolId: event.toolId,
            ...(event.output === undefined ? {} : { output: event.output }),
            ...(event.isError === undefined ? {} : { isError: event.isError }),
          },
          ...(raw === undefined ? {} : { raw }),
        });
        return undefined;
      case "permission.requested": {
        const requestId = randomUUID() as InteractionRequestId;
        this.#interactions.set(requestId, {
          kind: "permission",
          providerRequestId: event.providerRequestId,
          turnId: turn.record.id,
        });
        await this.#host.append({
          sessionId: this.#session.id,
          turnId: turn.record.id,
          type: "permission.requested",
          data: {
            requestId,
            title: event.title,
            ...(event.toolName === undefined ? {} : { toolName: event.toolName }),
            ...(event.input === undefined ? {} : { input: event.input }),
          },
          ...(raw === undefined ? {} : { raw }),
        });
        return undefined;
      }
      case "input.requested": {
        const requestId = randomUUID() as InteractionRequestId;
        this.#interactions.set(requestId, {
          kind: "input",
          providerRequestId: event.providerRequestId,
          turnId: turn.record.id,
        });
        const request = {
          id: requestId,
          ...(event.title === undefined ? {} : { title: event.title }),
          questions: event.questions,
        };
        await this.#host.append({
          sessionId: this.#session.id,
          turnId: turn.record.id,
          type: "input.requested",
          data: { requestId, request },
          ...(raw === undefined ? {} : { raw }),
        });
        return undefined;
      }
      case "diagnostic":
        await this.#host.append({
          sessionId: this.#session.id,
          turnId: turn.record.id,
          type: "diagnostic",
          data: {
            level: event.level,
            message: this.#host.redactor.text(event.message),
            ...(event.code === undefined ? {} : { code: event.code }),
          },
          ...(raw === undefined ? {} : { raw }),
        });
        return undefined;
      case "turn.completed": {
        await this.#expireInteractions(turn.record.id);
        await this.#host.append({
          sessionId: this.#session.id,
          turnId: turn.record.id,
          type: "turn.completed",
          data: {},
          ...(raw === undefined ? {} : { raw }),
        });
        return { status: "completed" };
      }
      case "turn.interrupted": {
        await this.#expireInteractions(turn.record.id);
        await this.#host.append({
          sessionId: this.#session.id,
          turnId: turn.record.id,
          type: "turn.interrupted",
          data: event.reason ? { reason: event.reason } : {},
          ...(raw === undefined ? {} : { raw }),
        });
        return event.reason
          ? { status: "interrupted", reason: event.reason }
          : { status: "interrupted" };
      }
      case "turn.failed": {
        await this.#expireInteractions(turn.record.id);
        const result: TurnResult = {
          status: "failed",
          error: {
            code: event.code,
            message: this.#host.redactor.text(event.message),
          },
          mayHaveSideEffects: event.mayHaveSideEffects,
        };
        await this.#host.append({
          sessionId: this.#session.id,
          turnId: turn.record.id,
          type: "turn.failed",
          data: { error: result.error, mayHaveSideEffects: result.mayHaveSideEffects },
          ...(raw === undefined ? {} : { raw }),
        });
        return result;
      }
    }
  }

  async #queueDelta(turnId: TurnId, event: Extract<ProviderEvent, { type: "message.delta" }>) {
    if (this.#deltaFlush) await this.#deltaFlush;
    if (this.#pendingDelta && this.#pendingDelta.messageId === event.messageId) {
      this.#pendingDelta.text += event.delta;
      if (event.raw !== undefined) this.#pendingDelta.raw = event.raw;
      return;
    }
    await this.#flushDelta();
    const timer = setTimeout(() => void this.#flushDelta(), this.#host.textDeltaCoalesceMs);
    this.#pendingDelta = {
      messageId: event.messageId,
      text: event.delta,
      ...(event.raw === undefined ? {} : { raw: event.raw }),
      timer,
    };
    void turnId;
  }

  async #flushDelta(): Promise<void> {
    if (this.#deltaFlush) return await this.#deltaFlush;
    const pending = this.#pendingDelta;
    if (!pending || !this.#active) return;
    this.#pendingDelta = undefined;
    clearTimeout(pending.timer);
    const turnId = this.#active.record.id;
    const raw = this.#host.rawFor(pending.raw, "message.delta", false);
    this.#deltaFlush = this.#host
      .append({
        sessionId: this.#session.id,
        turnId,
        type: "message.delta",
        data: { messageId: pending.messageId, delta: pending.text },
        ...(raw === undefined ? {} : { raw }),
      })
      .then(() => undefined)
      .finally(() => {
        this.#deltaFlush = undefined;
      });
    await this.#deltaFlush;
  }

  async #getRuntime(): Promise<ProviderRuntime> {
    if (this.#runtime) return this.#runtime;
    if (this.#runtimeOpening) return await this.#runtimeOpening;
    const context: OpenSessionContext = {
      ...this.#host.providerContext,
      sessionId: this.#session.id,
      cwd: this.#session.cwd,
      getMetadata: (key) => this.#host.store.getProviderMetadata(this.#session.id, key),
      setMetadata: (key, value) =>
        this.#host.store.setProviderMetadata(this.#session.id, key, value),
    };
    const opening = this.#adapter
      .openSession(context)
      .then((runtime) => {
        this.#runtime = runtime;
        return runtime;
      })
      .finally(() => {
        if (this.#runtimeOpening === opening) this.#runtimeOpening = undefined;
      });
    this.#runtimeOpening = opening;
    return await opening;
  }

  async #expireInteractions(turnId: TurnId): Promise<void> {
    for (const [requestId, pending] of [...this.#interactions]) {
      if (pending.turnId !== turnId) continue;
      await this.#host.append({
        sessionId: this.#session.id,
        turnId,
        type: pending.kind === "permission" ? "permission.resolved" : "input.resolved",
        data:
          pending.kind === "permission"
            ? { requestId, decision: "expired" }
            : { requestId, response: "expired" },
      } as HarnessEventDraft);
      this.#interactions.delete(requestId);
    }
  }

  async #pauseQueuedAfterCrash(): Promise<void> {
    await this.#host.store.setQueuedPaused(this.#session.id, true);
    this.#queue = this.#queue.map((turn) => ({
      ...turn,
      record: { ...turn.record, paused: true },
    }));
    this.#queue = [];
  }

  #scheduleIdle(): void {
    if (!this.#runtime || this.#idleTimer || this.#interactions.size > 0) return;
    this.#idleTimer = setTimeout(() => {
      const runtime = this.#runtime;
      this.#runtime = undefined;
      this.#idleTimer = undefined;
      void runtime?.close();
    }, this.#host.idleTimeoutMs);
    this.#idleTimer.unref?.();
  }

  #clearIdleTimer(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = undefined;
  }

  #assertUsable(): void {
    this.#host.assertOpen();
    if (this.#deleted) throw new SessionDeletedError(this.#session.id);
  }
}

class SessionImpl implements Session {
  readonly id: SessionId;
  readonly provider: string;
  readonly cwd: string;
  readonly #host: HarnessImpl;
  readonly #coordinator: SessionCoordinator;

  constructor(host: HarnessImpl, record: SessionRecord, coordinator: SessionCoordinator) {
    this.#host = host;
    this.#coordinator = coordinator;
    this.id = record.id;
    this.provider = record.provider;
    this.cwd = record.cwd;
  }

  send(request: SendRequest): Promise<Turn> {
    return this.#coordinator.send(request);
  }

  steer(request: { text: string }): Promise<void> {
    return this.#coordinator.steer(request.text);
  }

  interrupt(): Promise<void> {
    return this.#coordinator.interrupt();
  }

  respondToPermission(
    requestId: InteractionRequestId,
    decision: PermissionDecision,
  ): Promise<void> {
    return this.#coordinator.respondToPermission(requestId, decision);
  }

  respondToInput(requestId: InteractionRequestId, response: InputResponse): Promise<void> {
    return this.#coordinator.respondToInput(requestId, response);
  }

  snapshot(): Promise<SessionSnapshot> {
    return this.#host.store.snapshot(this.id);
  }

  history(options?: HistoryOptions): Promise<HistoryPage> {
    return this.#host.store.history(this.id, options);
  }

  subscribe(
    options: { afterSequence?: number },
    observer: SubscriptionObserver,
  ): Promise<Subscription> {
    return this.#host.subscribe(this.id, options.afterSequence ?? 0, observer);
  }

  resumeQueue(): Promise<void> {
    return this.#coordinator.resumeQueue();
  }

  async archive(): Promise<void> {
    await this.#host.archive(this.id);
  }

  async delete(): Promise<void> {
    await this.#host.delete(this.id);
  }
}

export class HarnessImpl implements Harness {
  readonly homeDir: string;
  readonly store: HarnessStore;
  readonly rawEvents: RawEventPersistence;
  readonly idleTimeoutMs: number;
  readonly textDeltaCoalesceMs: number;
  readonly redactor = new Redactor();
  readonly providerContext: ProviderContext;
  readonly sessions: SessionManager;
  readonly providers: Readonly<Record<string, ProviderRegistration>>;
  readonly #adapters: Readonly<Record<string, ProviderAdapterV1>>;
  readonly #lock = new AsyncLock();
  readonly #hub: SubscriptionHub;
  readonly #logger: HarnessLogger;
  #coordinators = new Map<SessionId, SessionCoordinator>();
  #status = new Map<string, ProviderStatus>();
  #capabilities = new Map<string, ProviderCapabilities>();
  #closing?: Promise<void>;
  #closed = false;

  constructor(options: CreateHarnessOptions, store: HarnessStore, logger?: HarnessLogger) {
    this.homeDir = resolve(options.homeDir);
    this.store = store;
    this.rawEvents = options.rawEvents ?? "none";
    this.idleTimeoutMs = options.idleTimeoutMs ?? 600_000;
    this.textDeltaCoalesceMs = options.textDeltaCoalesceMs ?? 25;
    this.#adapters = options.providers;
    this.providerContext = {
      homeDir: this.homeDir,
      registerSecrets: (values) => this.redactor.register(values),
    };
    this.#logger = logger ?? new RotatingFileLogger(this.homeDir, this.redactor);
    this.#hub = new SubscriptionHub(store, this.#lock, options.subscriberBufferSize ?? 1_000);
    this.sessions = {
      create: (options) => this.createSession(options),
      load: (id) => this.loadSession(id),
      list: (options) => this.store.listSessions(options?.includeArchived ?? false),
    };
    this.providers = Object.fromEntries(
      Object.entries(this.#adapters).map(([name, adapter]) => [
        name,
        {
          status: () => this.providerStatus(adapter, true),
          capabilities: () => this.providerCapabilities(adapter, true),
        },
      ]),
    );
  }

  async initialize(resumeQueuesOnStartup: boolean): Promise<void> {
    await this.store.open();
    const recovery = await this.store.recover();
    await this.#logger.log("info", "Harness opened", {
      failedTurns: recovery.failedTurnIds.length,
      expiredInteractions: recovery.expiredInteractionIds.length,
      pausedTurns: recovery.pausedTurnIds.length,
    });
    if (resumeQueuesOnStartup) {
      const sessions = await this.store.listSessions(true);
      for (const session of sessions) {
        const queued = await this.store.listQueuedTurns(session.id);
        if (queued.length > 0) await (await this.loadSession(session.id)).resumeQueue();
      }
    }
  }

  assertOpen(): void {
    if (this.#closed || this.#closing) throw new HarnessClosedError();
  }

  async providerStatus(adapter: ProviderAdapterV1, refresh = false): Promise<ProviderStatus> {
    this.assertOpen();
    const cached = this.#status.get(adapter.id);
    if (cached && !refresh) return cached;
    const status = await adapter.status(this.providerContext);
    this.#status.set(adapter.id, status);
    return status;
  }

  async providerCapabilities(
    adapter: ProviderAdapterV1,
    refresh = false,
  ): Promise<ProviderCapabilities> {
    this.assertOpen();
    const cached = this.#capabilities.get(adapter.id);
    if (cached && !refresh) return cached;
    const capabilities = await adapter.capabilities(this.providerContext);
    this.#capabilities.set(adapter.id, capabilities);
    return capabilities;
  }

  async append(draft: HarnessEventDraft): Promise<HarnessEvent> {
    return await this.#lock.run(async () => {
      let event: HarnessEvent;
      try {
        const safeDraft = this.redactor.value(draft);
        event = await this.store.appendEvent(safeDraft);
      } catch (error) {
        throw new StorageError("append event", error);
      }
      this.#hub.publish(event);
      return event;
    });
  }

  async acceptTurn(record: TurnRecord): Promise<HarnessEvent> {
    return await this.#lock.run(async () => {
      let event: HarnessEvent;
      try {
        event = await this.store.acceptTurn(this.redactor.value(record));
      } catch (error) {
        throw new StorageError("accept turn", error);
      }
      this.#hub.publish(event);
      return event;
    });
  }

  async log(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    data?: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.#logger.log(level, message, data);
  }

  rawFor(raw: unknown, type: string, isError: boolean): unknown | undefined {
    if (raw === undefined || this.rawEvents === "none") return undefined;
    if (this.rawEvents === "errors" && !isError && type !== "diagnostic") return undefined;
    return this.redactor.value(raw);
  }

  subscribe(
    sessionId: SessionId,
    afterSequence: number,
    observer: SubscriptionObserver,
  ): Promise<Subscription> {
    this.assertOpen();
    return this.#hub.subscribe(sessionId, afterSequence, observer);
  }

  async createSession(options: SessionCreateOptions): Promise<Session> {
    this.assertOpen();
    const adapter = this.#adapters[options.provider];
    if (!adapter) throw new ValidationError(`Provider ${options.provider} is not registered`);
    const cwd = resolve(options.cwd ?? resolve(this.homeDir, "workspace"));
    await mkdir(cwd, { recursive: true });
    const now = new Date().toISOString();
    const record: SessionRecord = {
      id: randomUUID() as SessionId,
      provider: options.provider,
      cwd,
      state: "active",
      createdAt: now,
      updatedAt: now,
    };
    await this.#lock.run(async () => {
      const event = await this.store.createSession(record);
      this.#hub.publish(event);
    });
    return this.#materialize(record, adapter);
  }

  async loadSession(id: SessionId): Promise<Session> {
    this.assertOpen();
    const record = await this.store.getSession(id);
    if (!record) throw new SessionNotFoundError(id);
    const adapter = this.#adapters[record.provider];
    if (!adapter) throw new ValidationError(`Provider ${record.provider} is not registered`);
    return this.#materialize(record, adapter);
  }

  async archive(id: SessionId): Promise<void> {
    this.assertOpen();
    await this.#lock.run(async () => {
      const event = await this.store.archiveSession(id);
      this.#hub.publish(event);
    });
  }

  async delete(id: SessionId): Promise<void> {
    this.assertOpen();
    const coordinator = this.#coordinators.get(id);
    await coordinator?.shutdown("Session deleted");
    await this.#lock.run(async () => {
      await this.store.deleteSession(id);
    });
    coordinator?.markDeleted();
    this.#coordinators.delete(id);
    await this.#hub.closeSession(id, new SessionDeletedError(id));
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    if (this.#closed) return Promise.resolve();
    this.#closing = (async () => {
      await Promise.all(
        [...this.#coordinators.values()].map((coordinator) => coordinator.shutdown()),
      );
      await this.#hub.closeAll();
      await this.#logger.log("info", "Harness closed");
      await this.store.close();
      await this.#logger.close?.();
      this.#closed = true;
    })();
    return this.#closing;
  }

  #materialize(record: SessionRecord, adapter: ProviderAdapterV1): Session {
    let coordinator = this.#coordinators.get(record.id);
    if (!coordinator) {
      coordinator = new SessionCoordinator(this, record, adapter);
      this.#coordinators.set(record.id, coordinator);
    }
    return new SessionImpl(this, record, coordinator);
  }
}

export async function createHarness(options: CreateHarnessOptions): Promise<Harness> {
  if (!options.homeDir) throw new ValidationError("homeDir is required");
  for (const [name, adapter] of Object.entries(options.providers)) {
    if (adapter.apiVersion !== 1)
      throw new UnsupportedAdapterVersionError(name, adapter.apiVersion);
    if (adapter.id !== name) {
      throw new ValidationError(
        `Provider registration key ${name} must match adapter id ${adapter.id}`,
      );
    }
  }
  const homeDir = resolve(options.homeDir);
  await mkdir(homeDir, { recursive: true });
  await mkdir(resolve(homeDir, "workspace"), { recursive: true });
  const store = options.store ?? new SQLiteStore(resolve(homeDir, "harness.sqlite3"));
  const harness = new HarnessImpl(options, store, options.logger);
  await harness.initialize(options.resumeQueuesOnStartup ?? false);
  return harness;
}

export function createMemoryStore(): HarnessStore {
  return new InMemoryStore();
}
