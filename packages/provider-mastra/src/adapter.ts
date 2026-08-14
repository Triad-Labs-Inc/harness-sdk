import { createHash, randomUUID } from "node:crypto";

import { MastraClient, MastraClientError } from "@mastra/client-js";
import type {
  OpenSessionContext,
  ProviderAdapterV1,
  ProviderCapabilities,
  ProviderContext,
  ProviderEvent,
  ProviderRuntime,
  ProviderStatus,
  ProviderTurnRequest,
} from "@triadlabs/harness-sdk";

export const MASTRA_PROVIDER_ID = "mastra";
const DEFAULT_STATUS_TIMEOUT_MS = 10_000;
const DEFAULT_INTERRUPT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_STREAM_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_CHUNK_BYTES = 1024 * 1024;
const DEFAULT_MAX_CONTROL_RESPONSE_BYTES = 1024 * 1024;
const PROVIDER_EVENT_BUFFER_SIZE = 128;
const MAX_ERROR_MESSAGE_LENGTH = 2_000;

export interface MastraProviderOptions {
  /** Stable Harness registry identifier. Defaults to `mastra`. */
  readonly id?: string;
  readonly baseUrl: string;
  readonly agentId: string;
  /** Runtime bearer token. This is not the Mastra Platform deployment token. */
  readonly authToken?: string;
  /** Stable server-side user/resource ID. A per-session ID is generated if omitted. */
  readonly resourceId?: string;
  readonly fetch?: typeof fetch;
  readonly statusTimeoutMs?: number;
  readonly interruptTimeoutMs?: number;
  readonly maxStreamBytes?: number;
  readonly maxChunkBytes?: number;
  readonly maxControlResponseBytes?: number;
}

interface NormalizedOptions {
  readonly id: string;
  readonly baseUrl: string;
  readonly agentId: string;
  readonly connectionFingerprint: string;
  readonly authToken?: string;
  readonly resourceId?: string;
  readonly fetch?: typeof fetch;
  readonly statusTimeoutMs: number;
  readonly interruptTimeoutMs: number;
  readonly maxStreamBytes: number;
  readonly maxChunkBytes: number;
  readonly maxControlResponseBytes: number;
}

interface MetadataKeys {
  readonly threadId: string;
  readonly resourceId: string;
  readonly connectionFingerprint: string;
  readonly activeTurn: string;
  readonly unsafeThread: string;
}

type TerminalEvent = Extract<
  ProviderEvent,
  { type: "turn.completed" | "turn.interrupted" | "turn.failed" }
>;

export interface MastraProjectionState {
  readonly messages: Set<string>;
  readonly completedMessages: Set<string>;
  readonly tools: Set<string>;
  readonly completedTools: Set<string>;
  terminal?: TerminalEvent;
}

interface SessionIdentity {
  readonly threadId: string;
  readonly resourceId: string;
}

interface ActiveTurn {
  readonly controller: AbortController;
  readonly queue: AsyncQueue<ProviderEvent>;
  consumePromise?: Promise<void>;
  consumeSettled?: boolean;
  remoteTerminalObserved?: boolean;
  terminalDequeued?: boolean;
  interruptPromise?: Promise<boolean>;
  interruptConfirmed?: boolean;
}

class AsyncQueue<T> implements AsyncIterableIterator<T> {
  readonly #values: T[] = [];
  readonly #readers: Array<{
    resolve(result: IteratorResult<T>): void;
    reject(error: unknown): void;
  }> = [];
  readonly #writers: Array<() => void> = [];
  readonly #capacity: number;
  #error?: unknown;
  #closed = false;

  constructor(capacity: number) {
    this.#capacity = capacity;
  }

  async push(value: T): Promise<void> {
    while (!this.#closed && this.#values.length >= this.#capacity) {
      await new Promise<void>((resolve) => this.#writers.push(resolve));
    }
    if (this.#closed) return;
    const reader = this.#readers.shift();
    if (reader) reader.resolve({ done: false, value });
    else this.#values.push(value);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const writer of this.#writers.splice(0)) writer();
    for (const reader of this.#readers.splice(0)) {
      reader.resolve({ done: true, value: undefined });
    }
  }

  fail(error: unknown): void {
    if (this.#closed) return;
    this.#error = error;
    this.#values.splice(0);
    this.#closed = true;
    for (const writer of this.#writers.splice(0)) writer();
    for (const reader of this.#readers.splice(0)) reader.reject(error);
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.#values.shift();
    if (value !== undefined) {
      this.#writers.shift()?.();
      return Promise.resolve({ done: false, value });
    }
    if (this.#error !== undefined) return Promise.reject(this.#error);
    if (this.#closed) {
      return Promise.resolve({ done: true, value: undefined });
    }
    return new Promise((resolve, reject) => this.#readers.push({ resolve, reject }));
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }
}

function normalizeOptions(options: MastraProviderOptions): NormalizedOptions {
  const parsed = new URL(options.baseUrl);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Mastra baseUrl must use HTTP or HTTPS");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Mastra credentials must not be embedded in baseUrl");
  }
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");

  const id = options.id?.trim() ?? MASTRA_PROVIDER_ID;
  if (!id) throw new Error("Mastra provider id must not be empty");

  const agentId = options.agentId.trim();
  if (!agentId) throw new Error("Mastra agentId must not be empty");
  const authToken = options.authToken?.trim();
  const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (authToken && parsed.protocol !== "https:" && !loopbackHosts.has(parsed.hostname)) {
    throw new Error("Mastra authToken requires HTTPS unless baseUrl is loopback");
  }

  const statusTimeoutMs = positiveTimeout(
    options.statusTimeoutMs,
    DEFAULT_STATUS_TIMEOUT_MS,
    "statusTimeoutMs",
  );
  const interruptTimeoutMs = positiveTimeout(
    options.interruptTimeoutMs,
    DEFAULT_INTERRUPT_TIMEOUT_MS,
    "interruptTimeoutMs",
  );
  const maxStreamBytes = positiveTimeout(
    options.maxStreamBytes,
    DEFAULT_MAX_STREAM_BYTES,
    "maxStreamBytes",
  );
  const maxChunkBytes = positiveTimeout(
    options.maxChunkBytes,
    DEFAULT_MAX_CHUNK_BYTES,
    "maxChunkBytes",
  );
  const maxControlResponseBytes = positiveTimeout(
    options.maxControlResponseBytes,
    DEFAULT_MAX_CONTROL_RESPONSE_BYTES,
    "maxControlResponseBytes",
  );

  const baseUrl = parsed.toString().replace(/\/$/, "");
  return {
    id,
    baseUrl,
    agentId,
    connectionFingerprint: createHash("sha256").update(`${baseUrl}\0${agentId}`).digest("hex"),
    statusTimeoutMs,
    interruptTimeoutMs,
    maxStreamBytes,
    maxChunkBytes,
    maxControlResponseBytes,
    ...(authToken ? { authToken } : {}),
    ...(options.resourceId?.trim() ? { resourceId: options.resourceId.trim() } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  };
}

function metadataKeys(providerId: string): MetadataKeys {
  const namespace =
    providerId === MASTRA_PROVIDER_ID ? "mastra" : `mastra.${encodeURIComponent(providerId)}`;
  return {
    threadId: `${namespace}.thread-id`,
    resourceId: `${namespace}.resource-id`,
    connectionFingerprint: `${namespace}.connection-fingerprint`,
    activeTurn: `${namespace}.active-turn`,
    unsafeThread: `${namespace}.unsafe-thread`,
  };
}

async function bindConnection(
  context: OpenSessionContext,
  options: NormalizedOptions,
  keys: MetadataKeys,
): Promise<void> {
  const stored = await context.getMetadata(keys.connectionFingerprint);
  if (stored === undefined) {
    await context.setMetadata(keys.connectionFingerprint, options.connectionFingerprint);
    return;
  }
  if (stored !== options.connectionFingerprint) {
    throw new Error("This Harness session is bound to a different Mastra server or agent");
  }
}

function positiveTimeout(value: number | undefined, fallback: number, label: string): number {
  const timeout = value ?? fallback;
  if (!Number.isSafeInteger(timeout) || timeout <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return timeout;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function boundedMessage(value: string): string {
  const normalized = value.trim() || "Mastra returned an unspecified error";
  return normalized.length <= MAX_ERROR_MESSAGE_LENGTH
    ? normalized
    : `${normalized.slice(0, MAX_ERROR_MESSAGE_LENGTH)}…`;
}

/** Extracts only a bounded human-readable message, never arbitrary remote data. */
function errorMessage(error: unknown): string {
  if (error instanceof MastraClientError) {
    const statusText = error.statusText.trim();
    return boundedMessage(
      `Mastra returned HTTP ${error.status}${statusText ? ` ${statusText}` : ""}`,
    );
  }
  if (error instanceof Error) return boundedMessage(error.message);
  if (typeof error === "string") return boundedMessage(error);
  const candidate = object(error);
  if (typeof candidate?.message === "string") {
    const code = typeof candidate.code === "string" ? `[${candidate.code}] ` : "";
    return boundedMessage(`${code}${candidate.message}`);
  }
  const nested = candidate?.error;
  if (typeof nested === "string") return boundedMessage(nested);
  const nestedObject = object(nested);
  if (typeof nestedObject?.message === "string") {
    return boundedMessage(nestedObject.message);
  }
  return "Mastra returned an unspecified error";
}

function startMessage(state: MastraProjectionState, messageId: string): ProviderEvent[] {
  if (state.messages.has(messageId)) return [];
  state.messages.add(messageId);
  return [{ type: "message.started", messageId, role: "assistant" }];
}

function startTool(
  state: MastraProjectionState,
  toolId: string,
  name: string,
  input?: unknown,
): ProviderEvent[] {
  if (state.tools.has(toolId)) return [];
  state.tools.add(toolId);
  return [
    {
      type: "tool.started",
      toolId,
      name,
      ...(input === undefined ? {} : { input }),
    },
  ];
}

export function createMastraProjectionState(): MastraProjectionState {
  return {
    messages: new Set(),
    completedMessages: new Set(),
    tools: new Set(),
    completedTools: new Set(),
  };
}

/**
 * Maps only the stable fields Harness needs. Deliberately never returns `raw`:
 * Mastra finish chunks can contain cookies and upstream response identifiers.
 */
export function projectMastraChunk(
  chunk: unknown,
  state: MastraProjectionState,
): readonly ProviderEvent[] {
  const envelope = object(chunk);
  const type = string(envelope?.type);
  const payload = object(envelope?.payload);
  if (!type || state.terminal) return [];

  switch (type) {
    case "text-start": {
      const messageId = string(payload?.id);
      return messageId ? startMessage(state, messageId) : [];
    }
    case "text-delta": {
      const messageId = string(payload?.id);
      const delta = typeof payload?.text === "string" ? payload.text : undefined;
      if (!messageId || delta === undefined) return [];
      return [...startMessage(state, messageId), { type: "message.delta", messageId, delta }];
    }
    case "text-end": {
      const messageId = string(payload?.id);
      if (!messageId || state.completedMessages.has(messageId)) return [];
      state.completedMessages.add(messageId);
      return [...startMessage(state, messageId), { type: "message.completed", messageId }];
    }
    case "tool-call": {
      const toolId = string(payload?.toolCallId);
      const name = string(payload?.toolName);
      if (!toolId || !name) return [];
      if (state.tools.has(toolId)) {
        return payload?.args === undefined
          ? []
          : [{ type: "tool.updated", toolId, update: { input: payload.args } }];
      }
      return startTool(state, toolId, name, payload?.args);
    }
    case "tool-call-input-streaming-start": {
      const toolId = string(payload?.toolCallId);
      const name = string(payload?.toolName);
      return toolId && name ? startTool(state, toolId, name) : [];
    }
    case "tool-call-delta": {
      const toolId = string(payload?.toolCallId);
      if (!toolId) return [];
      const name = string(payload?.toolName);
      if (!state.tools.has(toolId) && !name) return [];
      return [
        ...(name ? startTool(state, toolId, name) : []),
        {
          type: "tool.updated",
          toolId,
          update: {
            ...(typeof payload?.argsTextDelta === "string"
              ? { argsTextDelta: payload.argsTextDelta }
              : {}),
          },
        },
      ];
    }
    case "tool-call-input-streaming-end":
    case "step-start":
    case "step-finish":
      return [];
    case "tool-output":
    case "tool-result": {
      const toolId = string(payload?.toolCallId);
      const name = string(payload?.toolName) ?? "tool";
      if (!toolId || state.completedTools.has(toolId)) return [];
      state.completedTools.add(toolId);
      return [
        ...startTool(state, toolId, name, payload?.args),
        {
          type: "tool.completed",
          toolId,
          output: payload?.output ?? payload?.result,
          isError: payload?.isError === true,
        },
      ];
    }
    case "tool-output-denied":
    case "tool-error": {
      const toolId = string(payload?.toolCallId);
      const name = string(payload?.toolName) ?? "tool";
      if (!toolId || state.completedTools.has(toolId)) return [];
      state.completedTools.add(toolId);
      return [
        ...startTool(state, toolId, name, payload?.args),
        {
          type: "tool.completed",
          toolId,
          output:
            type === "tool-output-denied"
              ? "Tool call denied by the remote provider"
              : errorMessage(payload?.error),
          isError: true,
        },
      ];
    }
    case "tool-call-approval":
    case "tool-call-suspended":
      state.terminal = {
        type: "turn.failed",
        code: "MASTRA_INTERACTION_UNSUPPORTED",
        message: "The Mastra agent paused for an interaction that this adapter cannot resume.",
        mayHaveSideEffects: true,
      };
      return [];
    case "error":
      state.terminal = {
        type: "turn.failed",
        code: "MASTRA_CLOUD_ERROR",
        message: errorMessage(payload?.error ?? payload),
        mayHaveSideEffects: true,
      };
      return [];
    case "tripwire":
      if (payload?.retry === true) {
        return [
          {
            type: "diagnostic",
            level: "info",
            code: "MASTRA_RETRY",
            message: "A Mastra processor requested another attempt",
          },
        ];
      }
      state.terminal = {
        type: "turn.failed",
        code: "MASTRA_TRIPWIRE",
        message: string(payload?.reason) ?? "A Mastra output processor stopped the turn.",
        mayHaveSideEffects: true,
      };
      return [];
    case "abort":
      state.terminal = {
        type: "turn.interrupted",
        reason: "Mastra aborted the turn",
      };
      return [];
    case "finish": {
      const stepResult = object(payload?.stepResult);
      const finishReason = string(
        stepResult?.reason ?? payload?.finishReason ?? payload?.reason ?? payload?.finish_reason,
      );
      if (finishReason === "retry") return [];
      state.terminal =
        finishReason === "error"
          ? {
              type: "turn.failed",
              code: "MASTRA_CLOUD_ERROR",
              message: "Mastra finished the turn with an error",
              mayHaveSideEffects: true,
            }
          : finishReason === "tripwire"
            ? {
                type: "turn.failed",
                code: "MASTRA_TRIPWIRE",
                message: "A Mastra processor stopped the turn",
                mayHaveSideEffects: true,
              }
            : { type: "turn.completed" };
      return [];
    }
    default:
      return [
        {
          type: "diagnostic",
          level: "info",
          code: "MASTRA_UNKNOWN_CHUNK",
          message: boundedMessage(`Ignoring unknown Mastra stream chunk type: ${type}`),
        },
      ];
  }
}

function clientFor(
  options: NormalizedOptions,
  abortSignal?: AbortSignal,
  maxResponseBytes?: number,
): MastraClient {
  const baseFetch = options.fetch ?? globalThis.fetch;
  return new MastraClient({
    baseUrl: options.baseUrl,
    // A POST may reach the remote agent before the connection fails. Retrying it
    // could duplicate tool side effects, so Harness owns recovery explicitly.
    retries: 0,
    ...(options.authToken ? { headers: { Authorization: `Bearer ${options.authToken}` } } : {}),
    ...(abortSignal ? { abortSignal } : {}),
    ...(maxResponseBytes
      ? { fetch: responseLimitedFetch(baseFetch, maxResponseBytes) }
      : options.fetch
        ? { fetch: options.fetch }
        : {}),
  });
}

function responseLimitedFetch(baseFetch: typeof fetch, maxBytes: number): typeof fetch {
  return (async (input, init) => {
    const response = await baseFetch(input, init);
    if (!response.body) return response;

    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      await response.body.cancel();
      throw new Error(`Mastra response exceeded the ${maxBytes}-byte stream limit`);
    }

    let received = 0;
    const limitedBody = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          received += chunk.byteLength;
          if (received > maxBytes) {
            controller.error(
              new Error(`Mastra response exceeded the ${maxBytes}-byte stream limit`),
            );
            return;
          }
          controller.enqueue(chunk);
        },
      }),
    );
    return new Response(limitedBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }) as typeof fetch;
}

function chunkByteLength(chunk: unknown): number {
  const serialized = JSON.stringify(chunk);
  return serialized === undefined ? 0 : Buffer.byteLength(serialized, "utf8");
}

async function sessionIdentity(
  context: OpenSessionContext,
  options: NormalizedOptions,
  keys: MetadataKeys,
): Promise<SessionIdentity> {
  const storedThreadId = await context.getMetadata(keys.threadId);
  const storedResourceId = await context.getMetadata(keys.resourceId);
  if (
    options.resourceId &&
    typeof storedResourceId === "string" &&
    storedResourceId &&
    storedResourceId !== options.resourceId
  ) {
    throw new Error("This Harness session is bound to a different Mastra resource ID");
  }
  const threadId =
    typeof storedThreadId === "string" && storedThreadId ? storedThreadId : context.sessionId;
  const resourceId =
    options.resourceId ??
    (typeof storedResourceId === "string" && storedResourceId ? storedResourceId : randomUUID());

  if (storedThreadId !== threadId) {
    await context.setMetadata(keys.threadId, threadId);
  }
  if (storedResourceId !== resourceId) {
    await context.setMetadata(keys.resourceId, resourceId);
  }
  return { threadId, resourceId };
}

class MastraRuntime implements ProviderRuntime {
  readonly #options: NormalizedOptions;
  readonly #identity: SessionIdentity;
  readonly #context: OpenSessionContext;
  readonly #keys: MetadataKeys;
  #active: ActiveTurn | undefined;
  #unsafeAfterInterrupt: string | undefined;
  #closed = false;

  constructor(
    options: NormalizedOptions,
    identity: SessionIdentity,
    context: OpenSessionContext,
    keys: MetadataKeys,
    unsafeAfterInterrupt?: string,
  ) {
    this.#options = options;
    this.#identity = identity;
    this.#context = context;
    this.#keys = keys;
    if (unsafeAfterInterrupt) this.#unsafeAfterInterrupt = unsafeAfterInterrupt;
  }

  async *startTurn(request: ProviderTurnRequest): AsyncIterable<ProviderEvent> {
    if (this.#closed) {
      yield {
        type: "turn.failed",
        code: "MASTRA_RUNTIME_CLOSED",
        message: "The Mastra runtime is closed",
        mayHaveSideEffects: false,
      };
      return;
    }
    if (this.#unsafeAfterInterrupt) {
      throw new Error(this.#unsafeAfterInterrupt);
    }
    if (this.#active) {
      yield {
        type: "turn.failed",
        code: "MASTRA_TURN_ALREADY_ACTIVE",
        message: "This Mastra session already has an active turn",
        mayHaveSideEffects: false,
      };
      return;
    }

    const queue = new AsyncQueue<ProviderEvent>(PROVIDER_EVENT_BUFFER_SIZE);
    const active: ActiveTurn = {
      controller: new AbortController(),
      queue,
    };
    this.#active = active;
    active.consumePromise = this.#consume(request, active, queue).finally(() => {
      active.consumeSettled = true;
      if (this.#active === active) this.#active = undefined;
    });
    void active.consumePromise;

    try {
      while (true) {
        const next = await queue.next();
        if (next.done) break;
        if (
          next.value.type === "turn.completed" ||
          next.value.type === "turn.interrupted" ||
          next.value.type === "turn.failed"
        ) {
          active.terminalDequeued = true;
        }
        yield next.value;
      }
    } finally {
      const abandonedBeforeTerminal = !active.terminalDequeued && !active.consumeSettled;
      if (abandonedBeforeTerminal && !active.remoteTerminalObserved) {
        await this.#interruptActive(active).catch(() => undefined);
      }
      if (abandonedBeforeTerminal) {
        active.controller.abort();
        // Release a producer waiting on the bounded queue after its consumer
        // has gone away. #consume retains ownership of #active until it exits.
        active.queue.close();
      }
    }
  }

  async #consume(
    request: ProviderTurnRequest,
    active: ActiveTurn,
    queue: AsyncQueue<ProviderEvent>,
  ): Promise<void> {
    const state = createMastraProjectionState();
    let requiresRemoteReconciliation = false;
    let activeMarkerPersisted = false;
    let remoteRequestStarted = false;

    try {
      await this.#context.setMetadata(this.#keys.activeTurn, request.turnId);
      activeMarkerPersisted = true;
      if (active.interruptPromise) {
        await active.interruptPromise;
        state.terminal = {
          type: "turn.interrupted",
          reason: "Interrupted before the remote turn started",
        };
        return;
      }
      const agent = clientFor(
        this.#options,
        active.controller.signal,
        this.#options.maxStreamBytes,
      ).getAgent(this.#options.agentId);
      remoteRequestStarted = true;
      const response = await agent.stream(request.text, {
        runId: request.turnId,
        memory: {
          thread: this.#identity.threadId,
          resource: this.#identity.resourceId,
        },
        ...(request.model ? { model: request.model } : {}),
      });

      if (!response.ok) {
        throw new Error(`Mastra returned ${response.status} ${response.statusText}`);
      }

      await response.processDataStream({
        onChunk: async (chunk) => {
          if (chunkByteLength(chunk) > this.#options.maxChunkBytes) {
            throw new Error(`Mastra chunk exceeded the ${this.#options.maxChunkBytes}-byte limit`);
          }
          for (const event of projectMastraChunk(chunk, state)) {
            await queue.push(event);
          }
          if (
            state.terminal &&
            !(
              state.terminal.type === "turn.failed" &&
              state.terminal.code === "MASTRA_INTERACTION_UNSUPPORTED"
            )
          ) {
            active.remoteTerminalObserved = true;
          }
        },
      });
    } catch (error) {
      if (!active.interruptPromise) {
        requiresRemoteReconciliation = remoteRequestStarted;
        state.terminal ??= remoteRequestStarted
          ? {
              type: "turn.failed",
              code: "MASTRA_CLOUD_REQUEST_FAILED",
              message: errorMessage(error),
              mayHaveSideEffects: true,
            }
          : {
              type: "turn.failed",
              code: "MASTRA_STATE_PERSIST_FAILED",
              message: `Could not persist Mastra turn state: ${errorMessage(error)}`,
              mayHaveSideEffects: false,
            };
      }
    } finally {
      if (!state.terminal && !active.interruptPromise) {
        requiresRemoteReconciliation = true;
        state.terminal = {
          type: "turn.failed",
          code: "MASTRA_STREAM_INCOMPLETE",
          message: "Mastra ended without a terminal event",
          mayHaveSideEffects: true,
        };
      }
      if (
        requiresRemoteReconciliation ||
        (state.terminal?.type === "turn.failed" &&
          state.terminal.code === "MASTRA_INTERACTION_UNSUPPORTED")
      ) {
        // A suspension or local stream failure is not proof the remote run
        // stopped. Abort it before releasing Harness, or poison the durable
        // thread when the server cannot confirm cancellation.
        await this.#ensureRemoteAbort(active).catch(() => false);
      }
      if (active.interruptPromise) {
        await active.interruptPromise.catch(() => false);
      }
      if (
        activeMarkerPersisted &&
        !this.#unsafeAfterInterrupt &&
        (!remoteRequestStarted || active.remoteTerminalObserved || active.interruptConfirmed)
      ) {
        try {
          await this.#context.setMetadata(this.#keys.activeTurn, null);
        } catch (error) {
          this.#unsafeAfterInterrupt = `Mastra turn state could not be finalized: ${errorMessage(error)}`;
        }
      }
      if (this.#unsafeAfterInterrupt) {
        queue.fail(new Error(this.#unsafeAfterInterrupt));
      } else {
        if ((active.interruptConfirmed || active.controller.signal.aborted) && !state.terminal) {
          state.terminal = {
            type: "turn.interrupted",
            reason: "Interrupted by the user",
          };
        }
        const terminal = state.terminal ?? {
          type: "turn.failed" as const,
          code: "MASTRA_STREAM_INCOMPLETE",
          message: "Mastra ended without a terminal event",
          mayHaveSideEffects: true,
        };
        await queue.push(terminal);
        queue.close();
      }
    }
  }

  async interrupt(): Promise<void> {
    const active = this.#active;
    if (!active) return;
    await this.#interruptActive(active);
  }

  async #ensureRemoteAbort(active: ActiveTurn): Promise<boolean> {
    active.interruptPromise ??= this.#requestRemoteAbort().then(
      async (confirmed) => {
        if (!confirmed) {
          await this.#markUnsafe(
            "Mastra did not confirm remote cancellation; the turn may still have side effects",
          );
        } else {
          active.interruptConfirmed = true;
        }
        return confirmed;
      },
      async (error: unknown) => {
        const reason = `Mastra cancellation could not be confirmed: ${errorMessage(error)}`;
        await this.#markUnsafe(reason);
        throw new Error(reason);
      },
    );
    return await active.interruptPromise;
  }

  async #interruptActive(active: ActiveTurn): Promise<void> {
    try {
      const confirmed = await this.#ensureRemoteAbort(active);
      if (!confirmed) throw new Error(this.#unsafeAfterInterrupt);
    } catch (error) {
      active.controller.abort();
      const failure = new Error(
        this.#unsafeAfterInterrupt ?? `Mastra cancellation failed: ${errorMessage(error)}`,
      );
      active.queue.fail(failure);
      throw failure;
    }

    // Close the local stream only after the thread-wide remote abort is settled.
    active.controller.abort();
  }

  async #markUnsafe(reason: string): Promise<void> {
    this.#unsafeAfterInterrupt = reason;
    await this.#context.setMetadata(this.#keys.unsafeThread, reason);
  }

  async #requestRemoteAbort(): Promise<boolean> {
    const remoteController = new AbortController();
    let timeout: NodeJS.Timeout | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        remoteController.abort();
        reject(new Error(`Mastra cancellation exceeded ${this.#options.interruptTimeoutMs}ms`));
      }, this.#options.interruptTimeoutMs);
    });

    try {
      const request = clientFor(
        this.#options,
        remoteController.signal,
        this.#options.maxControlResponseBytes,
      )
        .getAgent(this.#options.agentId)
        .abortThread({
          threadId: this.#identity.threadId,
          resourceId: this.#identity.resourceId,
        });
      const result = await Promise.race([request, timedOut]);
      return result.aborted === true;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    const active = this.#active;
    if (!active) return;
    if (this.#unsafeAfterInterrupt) {
      active.controller.abort();
      active.queue.fail(new Error(this.#unsafeAfterInterrupt));
      if (this.#active === active) this.#active = undefined;
      return;
    }
    try {
      await this.#interruptActive(active);
    } finally {
      active.controller.abort();
      active.queue.close();
      if (this.#active === active) this.#active = undefined;
    }
  }
}

function registerAuthToken(context: ProviderContext, options: NormalizedOptions): void {
  if (options.authToken) context.registerSecrets([options.authToken]);
}

export function createMastraProvider(rawOptions: MastraProviderOptions): ProviderAdapterV1 {
  const options = normalizeOptions(rawOptions);
  const capabilities: ProviderCapabilities = {
    steering: false,
    interruption: true,
    permissions: false,
    questions: false,
    sessionResume: true,
    modelOverride: true,
    reasoningOverride: false,
    rawEvents: false,
  };

  return {
    apiVersion: 1,
    id: options.id,
    async status(context): Promise<ProviderStatus> {
      registerAuthToken(context, options);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.statusTimeoutMs);
      timeout.unref?.();
      try {
        const client = clientFor(options, controller.signal, options.maxControlResponseBytes);
        const [details, card] = await Promise.all([
          client.getAgent(options.agentId).details(),
          client
            .getA2A(options.agentId)
            .getAgentCard()
            .catch(() => undefined),
        ]);
        const protocol = card?.protocolVersion ? `A2A ${card.protocolVersion}` : "native API";
        const model = details.modelId ? ` · ${details.modelId}` : "";
        return {
          state: "ready",
          version: `${details.name}${model} · ${protocol}`,
        };
      } catch (error) {
        if (error instanceof MastraClientError && (error.status === 401 || error.status === 403)) {
          return {
            state: "not_authenticated",
            message: "Mastra rejected the configured runtime token",
          };
        }
        return {
          state: "unavailable",
          message: `Cannot reach Mastra agent ${options.agentId}: ${errorMessage(error)}`,
        };
      } finally {
        // Promise.all can reject while the optional agent-card request is still
        // pending. Always cancel sibling readiness work before releasing status().
        controller.abort();
        clearTimeout(timeout);
      }
    },
    async capabilities(context): Promise<ProviderCapabilities> {
      registerAuthToken(context, options);
      return capabilities;
    },
    async openSession(context): Promise<ProviderRuntime> {
      registerAuthToken(context, options);
      const keys = metadataKeys(options.id);
      await bindConnection(context, options, keys);
      const identity = await sessionIdentity(context, options, keys);
      const unsafeThread = await context.getMetadata(keys.unsafeThread);
      const activeTurn = await context.getMetadata(keys.activeTurn);
      const persistedUnsafeReason =
        typeof unsafeThread === "string" && unsafeThread ? unsafeThread : undefined;
      const recoveredUnsafeReason =
        !persistedUnsafeReason && typeof activeTurn === "string" && activeTurn
          ? `Mastra turn ${activeTurn} was active when the host stopped; the remote thread is blocked because its execution state is unknown`
          : undefined;
      if (recoveredUnsafeReason) {
        await context.setMetadata(keys.unsafeThread, recoveredUnsafeReason);
      }
      return new MastraRuntime(
        options,
        identity,
        context,
        keys,
        persistedUnsafeReason ?? recoveredUnsafeReason,
      );
    },
  };
}
