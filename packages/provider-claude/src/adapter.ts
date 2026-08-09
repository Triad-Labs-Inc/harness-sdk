import { access } from "node:fs/promises";
import { constants } from "node:fs";

import {
  query as agentQuery,
  type Options as AgentOptions,
  type PermissionResult,
  type Query,
  type SDKControlInitializeResponse,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  InputQuestion,
  OpenSessionContext,
  PermissionDecision,
  ProviderAdapterV1,
  ProviderCapabilities,
  ProviderContext,
  ProviderEvent,
  ProviderInputResponse,
  ProviderPermissionResponse,
  ProviderRuntime,
  ProviderStatus,
  ProviderTurnRequest,
} from "@harness-sdk/core";

type Resolvable<T> = T | (() => T | Promise<T>);
type SettingSource = "user" | "project" | "local";

export type ClaudeQueryFactory = (parameters: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: AgentOptions;
}) => Query;

export interface ClaudeProviderOptions {
  readonly executable?: Resolvable<string>;
  readonly environment?: () => NodeJS.ProcessEnv | Promise<NodeJS.ProcessEnv>;
  readonly settingSources?: readonly SettingSource[];
  readonly statusTimeoutMs?: number;
  readonly queryFactory?: ClaudeQueryFactory;
}

interface JsonObject {
  [key: string]: unknown;
}

interface ActiveTurn {
  readonly queue: AsyncEventQueue;
  readonly abortController: AbortController;
  query?: Query;
  terminal: boolean;
  interrupted: boolean;
  lastErrorCode?: string;
  partialMessageId: string | undefined;
  readonly streamedMessages: Set<string>;
  readonly startedTools: Set<string>;
}

interface PendingPermission {
  readonly kind: "permission";
  readonly input: JsonObject;
  readonly suggestions?: unknown[];
  resolve(result: PermissionResult): void;
}

interface PendingInput {
  readonly kind: "input";
  readonly input: JsonObject;
  readonly questions: readonly { id: string; nativeText: string }[];
  resolve(result: PermissionResult): void;
}

type PendingInteraction = PendingPermission | PendingInput;

class AsyncEventQueue implements AsyncIterable<ProviderEvent> {
  #events: ProviderEvent[] = [];
  #waiters: Array<{
    resolve(value: IteratorResult<ProviderEvent>): void;
    reject(error: Error): void;
  }> = [];
  #ended = false;
  #error?: Error;

  push(event: ProviderEvent): void {
    if (this.#ended) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ done: false, value: event });
    else this.#events.push(event);
  }

  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) waiter.resolve({ done: true, value: undefined });
  }

  fail(error: Error): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#error = error;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<ProviderEvent> {
    return {
      next: async () => {
        const event = this.#events.shift();
        if (event) return { done: false, value: event };
        if (this.#error) throw this.#error;
        if (this.#ended) return { done: true, value: undefined };
        return await new Promise<IteratorResult<ProviderEvent>>((resolve, reject) => {
          this.#waiters.push({ resolve, reject });
        });
      },
    };
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function object(value: unknown): JsonObject {
  return isObject(value) ? value : {};
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function boolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

const CLAUDE_SDK_VERSION = "@anthropic-ai/claude-agent-sdk 0.3.226";
const DEFAULT_STATUS_TIMEOUT_MS = 25_000;

class ClaudeStatusTimeoutError extends Error {
  constructor() {
    super("Claude authentication status probe timed out");
    this.name = "ClaudeStatusTimeoutError";
  }
}

async function resolveValue<T>(value: Resolvable<T> | undefined): Promise<T | undefined> {
  if (value === undefined) return undefined;
  return typeof value === "function" ? await (value as () => T | Promise<T>)() : value;
}

async function resolvedEnvironment(
  options: ClaudeProviderOptions,
  context: ProviderContext,
): Promise<NodeJS.ProcessEnv> {
  const extra = (await options.environment?.()) ?? {};
  const env = { ...process.env, ...extra, CLAUDE_AGENT_SDK_CLIENT_APP: "harness-sdk/0.1.0" };
  context.registerSecrets(
    Object.values(env).filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    ),
  );
  return env;
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}

function idleStatusPrompt(signal: AbortSignal): AsyncIterable<SDKUserMessage> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
      return {
        next: async () => {
          await waitForAbort(signal);
          return { done: true, value: undefined };
        },
      };
    },
  };
}

function hasClaudeAuthentication(initialization: SDKControlInitializeResponse): boolean {
  const account = object(initialization.account);
  const credentialMetadata = [
    account.email,
    account.organization,
    account.subscriptionType,
    account.tokenSource,
    account.apiKeySource,
  ];
  if (credentialMetadata.some((value) => typeof value === "string" && value.trim().length > 0)) {
    return true;
  }
  const apiProvider = string(account.apiProvider);
  return apiProvider !== undefined && apiProvider !== "firstParty";
}

async function probeClaudeAuthentication(
  options: ClaudeProviderOptions,
  environment: NodeJS.ProcessEnv,
  executable: string | undefined,
  cwd: string,
): Promise<boolean> {
  const abortController = new AbortController();
  const queryFactory = options.queryFactory ?? agentQuery;
  const statusQuery = queryFactory({
    prompt: idleStatusPrompt(abortController.signal),
    options: {
      abortController,
      cwd,
      env: { ...environment, ENABLE_CLAUDEAI_MCP_SERVERS: "false" },
      persistSession: false,
      settingSources: [...(options.settingSources ?? ["user", "project", "local"])],
      allowedTools: [],
      mcpServers: {},
      strictMcpConfig: true,
      stderr: () => undefined,
      ...(executable === undefined ? {} : { pathToClaudeCodeExecutable: executable }),
    },
  });
  const timeoutMs = Math.max(1, options.statusTimeoutMs ?? DEFAULT_STATUS_TIMEOUT_MS);
  let timeout: NodeJS.Timeout | undefined;
  try {
    const initialization = await Promise.race([
      statusQuery.initializationResult(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new ClaudeStatusTimeoutError()), timeoutMs);
      }),
    ]);
    return hasClaudeAuthentication(initialization);
  } finally {
    if (timeout) clearTimeout(timeout);
    abortController.abort();
    statusQuery.close();
  }
}

function errorCode(error: unknown): string | undefined {
  return isObject(error) ? string(error.code) : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
}

function isMissingClaudeExecutable(error: unknown): boolean {
  const code = errorCode(error);
  if (code === "ENOENT" || code === "EACCES") return true;
  const message = errorMessage(error);
  return (
    message.includes("native binary not found") ||
    message.includes("claude code executable") ||
    message.includes("spawn claude enoent")
  );
}

function isClaudeAuthenticationError(error: unknown): boolean {
  const message = errorMessage(error);
  return (
    message.includes("not logged in") ||
    message.includes("not authenticated") ||
    message.includes("authentication_error") ||
    message.includes("authentication failed") ||
    message.includes("invalid api key")
  );
}

const capabilities: ProviderCapabilities = {
  steering: false,
  interruption: true,
  permissions: true,
  questions: true,
  sessionResume: true,
  modelOverride: true,
  reasoningOverride: true,
  rawEvents: true,
};

class ClaudeRuntime implements ProviderRuntime {
  readonly #context: OpenSessionContext;
  readonly #options: ClaudeProviderOptions;
  readonly #queryFactory: ClaudeQueryFactory;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #executable: string | undefined;
  readonly #interactions = new Map<string, PendingInteraction>();
  #active: ActiveTurn | undefined;
  #nativeSessionId: string | undefined;
  #closed = false;

  private constructor(
    context: OpenSessionContext,
    options: ClaudeProviderOptions,
    environment: NodeJS.ProcessEnv,
    executable: string | undefined,
    nativeSessionId: string | undefined,
  ) {
    this.#context = context;
    this.#options = options;
    this.#queryFactory = options.queryFactory ?? agentQuery;
    this.#environment = environment;
    this.#executable = executable;
    this.#nativeSessionId = nativeSessionId;
  }

  static async open(
    context: OpenSessionContext,
    options: ClaudeProviderOptions,
  ): Promise<ClaudeRuntime> {
    const environment = await resolvedEnvironment(options, context);
    const executable = await resolveValue(options.executable);
    const stored = await context.getMetadata("claude.sessionId");
    return new ClaudeRuntime(
      context,
      options,
      environment,
      executable,
      typeof stored === "string" ? stored : undefined,
    );
  }

  async *startTurn(request: ProviderTurnRequest): AsyncIterable<ProviderEvent> {
    if (this.#closed) throw new Error("Claude runtime is closed");
    if (this.#active) throw new Error("Claude runtime already has an active turn");
    const active: ActiveTurn = {
      queue: new AsyncEventQueue(),
      abortController: new AbortController(),
      terminal: false,
      interrupted: false,
      partialMessageId: undefined,
      streamedMessages: new Set(),
      startedTools: new Set(),
    };
    this.#active = active;
    void this.#consume(active, request);
    try {
      for await (const event of active.queue) yield event;
    } finally {
      if (this.#active === active) this.#active = undefined;
      this.#interactions.clear();
    }
  }

  async interrupt(): Promise<void> {
    const active = this.#active;
    if (!active) return;
    active.interrupted = true;
    for (const [id, pending] of this.#interactions) {
      pending.resolve({ behavior: "deny", message: "Interrupted", interrupt: true });
      this.#interactions.delete(id);
    }
    await active.query?.interrupt();
  }

  async respondToPermission(response: ProviderPermissionResponse): Promise<void> {
    const pending = this.#interactions.get(response.providerRequestId);
    if (!pending || pending.kind !== "permission")
      throw new Error("Unknown Claude permission request");
    this.#interactions.delete(response.providerRequestId);
    pending.resolve(permissionResult(response.decision, pending.input, pending.suggestions));
    if (response.decision.decision === "cancel_turn") await this.interrupt();
  }

  async respondToInput(response: ProviderInputResponse): Promise<void> {
    const pending = this.#interactions.get(response.providerRequestId);
    if (!pending || pending.kind !== "input") throw new Error("Unknown Claude input request");
    this.#interactions.delete(response.providerRequestId);
    const answers = Object.fromEntries(
      pending.questions.map((question) => [
        question.nativeText,
        [...(response.response.answers[question.id] ?? [])].join(", "),
      ]),
    );
    pending.resolve({ behavior: "allow", updatedInput: { ...pending.input, answers } });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const active = this.#active;
    if (!active) return;
    active.interrupted = true;
    active.abortController.abort();
    active.query?.close();
    active.queue.fail(new Error("Claude runtime closed"));
  }

  async #consume(active: ActiveTurn, request: ProviderTurnRequest): Promise<void> {
    try {
      const permissionMode =
        request.permissionMode === "full_access" ? "bypassPermissions" : "default";
      const sdkOptions: AgentOptions = {
        abortController: active.abortController,
        cwd: this.#context.cwd,
        env: this.#environment,
        includePartialMessages: true,
        persistSession: true,
        settingSources: [...(this.#options.settingSources ?? ["user", "project", "local"])],
        permissionMode,
        ...(permissionMode === "bypassPermissions"
          ? { allowDangerouslySkipPermissions: true }
          : {}),
        ...(this.#executable === undefined ? {} : { pathToClaudeCodeExecutable: this.#executable }),
        ...(this.#nativeSessionId === undefined ? {} : { resume: this.#nativeSessionId }),
        ...(request.model === undefined ? {} : { model: request.model }),
        ...(request.reasoning === undefined
          ? {}
          : { effort: request.reasoning as NonNullable<AgentOptions["effort"]> }),
        canUseTool: async (toolName, input, callbackOptions) =>
          await this.#canUseTool(active, toolName, input, callbackOptions),
      };
      const query = this.#queryFactory({ prompt: request.text, options: sdkOptions });
      active.query = query;
      for await (const message of query) await this.#handleMessage(active, message);
      if (!active.terminal) {
        active.terminal = true;
        if (active.interrupted) {
          active.queue.push({ type: "turn.interrupted", reason: "Interrupted by application" });
        } else {
          active.queue.push({
            type: "turn.failed",
            code: "CLAUDE_STREAM_ENDED",
            message: "Claude stream ended without a result",
            mayHaveSideEffects: true,
          });
        }
        active.queue.end();
      }
    } catch (error) {
      active.queue.fail(error instanceof Error ? error : new Error(String(error)));
    } finally {
      active.query?.close();
    }
  }

  async #canUseTool(
    active: ActiveTurn,
    toolName: string,
    input: Record<string, unknown>,
    callbackOptions: {
      signal: AbortSignal;
      suggestions?: unknown[];
      decisionReason?: string;
      title?: string;
      displayName?: string;
      toolUseID: string;
      requestId: string;
    },
  ): Promise<PermissionResult> {
    if (toolName === "AskUserQuestion") {
      const normalized = normalizeQuestions(input);
      const result = new Promise<PermissionResult>((resolve) => {
        this.#interactions.set(callbackOptions.requestId, {
          kind: "input",
          input,
          questions: normalized.mapping,
          resolve,
        });
      });
      active.queue.push({
        type: "input.requested",
        providerRequestId: callbackOptions.requestId,
        title: callbackOptions.title ?? "Claude needs input",
        questions: normalized.questions,
        raw: { toolName, input, requestId: callbackOptions.requestId },
      });
      return await result;
    }

    const result = new Promise<PermissionResult>((resolve) => {
      this.#interactions.set(callbackOptions.requestId, {
        kind: "permission",
        input,
        ...(callbackOptions.suggestions === undefined
          ? {}
          : { suggestions: callbackOptions.suggestions }),
        resolve,
      });
    });
    active.queue.push({
      type: "permission.requested",
      providerRequestId: callbackOptions.requestId,
      title:
        callbackOptions.title ??
        callbackOptions.decisionReason ??
        callbackOptions.displayName ??
        `Claude requests permission to use ${toolName}`,
      toolName,
      input,
      raw: { toolName, input, requestId: callbackOptions.requestId },
    });
    return await result;
  }

  async #handleMessage(active: ActiveTurn, message: unknown): Promise<void> {
    const native = object(message);
    const sessionId = string(native.session_id);
    if (sessionId && sessionId !== this.#nativeSessionId) {
      this.#nativeSessionId = sessionId;
      await this.#context.setMetadata("claude.sessionId", sessionId);
    }
    switch (string(native.type)) {
      case "stream_event":
        this.#handleStreamEvent(active, object(native.event), native);
        return;
      case "assistant":
        if (string(native.error))
          active.lastErrorCode = `CLAUDE_${string(native.error)!.toUpperCase()}`;
        this.#handleAssistant(active, object(native.message), native);
        return;
      case "user":
        this.#handleUser(active, object(native.message), native);
        return;
      case "tool_progress": {
        const toolId = string(native.tool_use_id);
        if (toolId)
          active.queue.push({ type: "tool.updated", toolId, update: native, raw: message });
        return;
      }
      case "result":
        this.#handleResult(active, native, message);
        return;
      case "auth_status":
        if (string(native.error)) {
          active.queue.push({
            type: "diagnostic",
            level: "error",
            message: string(native.error)!,
            code: "CLAUDE_AUTH_STATUS",
            raw: message,
          });
        }
        return;
      case "system":
      case "tool_use_summary":
      case "rate_limit_event":
        return;
      default:
        active.queue.push({
          type: "diagnostic",
          level: "info",
          message: `Ignored unknown Claude SDK message: ${string(native.type) ?? "malformed"}`,
          code: "CLAUDE_UNKNOWN_MESSAGE",
          raw: message,
        });
    }
  }

  #handleStreamEvent(active: ActiveTurn, event: JsonObject, raw: unknown): void {
    switch (string(event.type)) {
      case "message_start": {
        const id = string(object(event.message).id);
        if (!id) return;
        active.partialMessageId = id;
        active.streamedMessages.add(id);
        active.queue.push({ type: "message.started", messageId: id, role: "assistant", raw });
        return;
      }
      case "content_block_start": {
        const block = object(event.content_block);
        if (string(block.type) !== "tool_use") return;
        const id = string(block.id);
        const name = string(block.name);
        if (id && name && !active.startedTools.has(id)) {
          active.startedTools.add(id);
          active.queue.push({ type: "tool.started", toolId: id, name, input: block.input, raw });
        }
        return;
      }
      case "content_block_delta": {
        const delta = object(event.delta);
        const text = string(delta.text);
        if (active.partialMessageId && text !== undefined) {
          active.queue.push({
            type: "message.delta",
            messageId: active.partialMessageId,
            delta: text,
            raw,
          });
        }
        return;
      }
      case "message_stop":
        if (active.partialMessageId) {
          active.queue.push({
            type: "message.completed",
            messageId: active.partialMessageId,
            raw,
          });
          active.partialMessageId = undefined;
        }
    }
  }

  #handleAssistant(active: ActiveTurn, assistant: JsonObject, raw: unknown): void {
    const id = string(assistant.id) ?? string(object(raw).uuid) ?? "claude-message";
    const content = Array.isArray(assistant.content) ? assistant.content.filter(isObject) : [];
    const streamed = active.streamedMessages.has(id);
    if (!streamed)
      active.queue.push({ type: "message.started", messageId: id, role: "assistant", raw });
    let text = "";
    for (const block of content) {
      if (string(block.type) === "text" && string(block.text) !== undefined) {
        text += string(block.text)!;
        if (!streamed)
          active.queue.push({
            type: "message.delta",
            messageId: id,
            delta: string(block.text)!,
            raw,
          });
      } else if (string(block.type) === "tool_use") {
        const toolId = string(block.id);
        const name = string(block.name);
        if (toolId && name && !active.startedTools.has(toolId)) {
          active.startedTools.add(toolId);
          active.queue.push({ type: "tool.started", toolId, name, input: block.input, raw });
        }
      }
    }
    if (!streamed)
      active.queue.push({
        type: "message.completed",
        messageId: id,
        ...(text ? { text } : {}),
        raw,
      });
  }

  #handleUser(active: ActiveTurn, user: JsonObject, raw: unknown): void {
    const content = Array.isArray(user.content) ? user.content.filter(isObject) : [];
    for (const block of content) {
      if (string(block.type) !== "tool_result") continue;
      const toolId = string(block.tool_use_id);
      if (!toolId) continue;
      active.queue.push({
        type: "tool.completed",
        toolId,
        output: block.content,
        ...(boolean(block.is_error) === undefined ? {} : { isError: boolean(block.is_error)! }),
        raw,
      });
    }
  }

  #handleResult(active: ActiveTurn, result: JsonObject, raw: unknown): void {
    if (active.terminal) return;
    active.terminal = true;
    if (active.interrupted) {
      active.queue.push({ type: "turn.interrupted", reason: "Interrupted by application", raw });
    } else if (result.is_error === true || string(result.subtype) !== "success") {
      const errors = Array.isArray(result.errors)
        ? result.errors.filter((value) => typeof value === "string")
        : [];
      active.queue.push({
        type: "turn.failed",
        code: active.lastErrorCode ?? `CLAUDE_${(string(result.subtype) ?? "ERROR").toUpperCase()}`,
        message: string(result.result) ?? (errors.join("; ") || "Claude turn failed"),
        mayHaveSideEffects: true,
        raw,
      });
    } else active.queue.push({ type: "turn.completed", raw });
    active.queue.end();
  }
}

function permissionResult(
  decision: PermissionDecision,
  input: JsonObject,
  suggestions: readonly unknown[] | undefined,
): PermissionResult {
  switch (decision.decision) {
    case "allow_once":
      return { behavior: "allow", updatedInput: input };
    case "allow_session":
      return {
        behavior: "allow",
        updatedInput: input,
        ...(suggestions === undefined ? {} : { updatedPermissions: suggestions as never[] }),
      };
    case "deny":
      return { behavior: "deny", message: decision.reason ?? "Denied by application" };
    case "cancel_turn":
      return {
        behavior: "deny",
        message: decision.reason ?? "Cancelled by application",
        interrupt: true,
      };
  }
}

function normalizeQuestions(input: JsonObject): {
  questions: InputQuestion[];
  mapping: Array<{ id: string; nativeText: string }>;
} {
  const native = Array.isArray(input.questions) ? input.questions.filter(isObject) : [];
  const mapping: Array<{ id: string; nativeText: string }> = [];
  const questions = native.map((question, index): InputQuestion => {
    const nativeText = string(question.question) ?? `Question ${index + 1}`;
    const id = string(question.id) ?? `question-${index + 1}`;
    mapping.push({ id, nativeText });
    const nativeOptions = Array.isArray(question.options) ? question.options.filter(isObject) : [];
    const options = nativeOptions.map((option) => {
      const label = string(option.label) ?? "option";
      const description = string(option.description);
      return {
        value: label,
        label,
        ...(description === undefined ? {} : { description }),
      };
    });
    return {
      id,
      prompt: nativeText,
      ...(options.length === 0 ? {} : { options }),
      multiple: question.multiSelect === true,
      allowFreeText: true,
    };
  });
  return { questions, mapping };
}

export function createClaudeProvider(options: ClaudeProviderOptions = {}): ProviderAdapterV1 {
  return {
    apiVersion: 1,
    id: "claude",
    async status(context: ProviderContext): Promise<ProviderStatus> {
      try {
        const env = await resolvedEnvironment(options, context);
        const executable = await resolveValue(options.executable);
        if (executable) await access(executable, constants.X_OK);
        const authenticated = await probeClaudeAuthentication(
          options,
          env,
          executable,
          context.homeDir,
        );
        if (!authenticated) {
          return {
            state: "not_authenticated",
            message:
              "Claude Code is not authenticated; run `claude auth login` or supply API credentials",
          };
        }
        return { state: "ready", version: CLAUDE_SDK_VERSION };
      } catch (error) {
        if (isMissingClaudeExecutable(error)) {
          return { state: "not_installed", message: "Claude Code executable is unavailable" };
        }
        if (isClaudeAuthenticationError(error)) {
          return {
            state: "not_authenticated",
            message:
              "Claude Code authentication is unavailable; run `claude auth login` or check API credentials",
          };
        }
        return { state: "unavailable", message: "Claude Agent SDK is unavailable" };
      }
    },
    async capabilities(): Promise<ProviderCapabilities> {
      return capabilities;
    },
    async openSession(context: OpenSessionContext): Promise<ProviderRuntime> {
      return await ClaudeRuntime.open(context, options);
    },
  };
}
