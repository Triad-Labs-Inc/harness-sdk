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
} from "@triadlabs/harness-sdk";

import {
  CodexAppServerClient,
  CodexRpcError,
  isObject,
  type JsonObject,
  type JsonRpcMessage,
} from "./protocol.js";

type Resolvable<T> = T | (() => T | Promise<T>);

export interface CodexProviderOptions {
  readonly executable?: Resolvable<string>;
  readonly environment?: () => NodeJS.ProcessEnv | Promise<NodeJS.ProcessEnv>;
  readonly appServerArgs?: readonly string[];
  readonly requestTimeoutMs?: number;
  readonly approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never";
  readonly sandbox?: "read-only" | "workspace-write" | "danger-full-access";
}

interface ActiveTurn {
  readonly queue: AsyncEventQueue;
  readonly nativeIdReady: Promise<string>;
  resolveNativeId(value: string): void;
  nativeTurnId?: string;
  notificationReady?: Promise<string>;
  resolveNotificationReady(value: string): void;
  readonly ended: Promise<void>;
  resolveEnded(): void;
  interruptRequested: boolean;
}

interface PendingNativeInteraction {
  readonly id: string | number;
  readonly kind: "permission" | "input";
  readonly questionIds?: readonly string[];
}

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

function deferredString(): {
  promise: Promise<string>;
  resolve(value: string): void;
} {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function deferredVoid(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function object(value: unknown): JsonObject {
  return isObject(value) ? value : {};
}

function itemName(item: JsonObject): string | undefined {
  const type = string(item.type);
  switch (type) {
    case "commandExecution":
      return "shell";
    case "fileChange":
      return "file_change";
    case "mcpToolCall":
      return [string(item.server), string(item.tool)].filter(Boolean).join(".") || "mcp_tool";
    case "dynamicToolCall":
      return string(item.tool) ?? "dynamic_tool";
    case "collabAgentToolCall":
      return string(item.tool) ?? "collaboration";
    case "webSearch":
      return "web_search";
    case "imageGeneration":
      return "image_generation";
    default:
      return undefined;
  }
}

function permissionDecision(decision: PermissionDecision): string {
  switch (decision.decision) {
    case "allow_once":
      return "accept";
    case "allow_session":
      return "acceptForSession";
    case "deny":
      return "decline";
    case "cancel_turn":
      return "cancel";
  }
}

function turnErrorMessage(turn: JsonObject): string {
  const error = object(turn.error);
  return string(error.message) ?? "Codex turn failed";
}

const capabilities: ProviderCapabilities = {
  steering: true,
  interruption: true,
  permissions: true,
  questions: true,
  sessionResume: true,
  modelOverride: true,
  reasoningOverride: true,
  rawEvents: true,
};

async function resolveValue<T>(value: Resolvable<T> | undefined, fallback: T): Promise<T> {
  if (value === undefined) return fallback;
  return typeof value === "function" ? await (value as () => T | Promise<T>)() : value;
}

async function processOptions(
  options: CodexProviderOptions,
  context: ProviderContext,
  cwd: string,
): Promise<ConstructorParameters<typeof CodexAppServerClient>[0]> {
  const executable = await resolveValue(options.executable, "codex");
  const extra = (await options.environment?.()) ?? {};
  const env = { ...process.env, ...extra };
  context.registerSecrets(
    Object.values(env).filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    ),
  );
  return {
    executable,
    args: options.appServerArgs ?? ["app-server"],
    cwd,
    env,
    requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
  };
}

class CodexRuntime implements ProviderRuntime {
  readonly #client: CodexAppServerClient;
  readonly #threadId: string;
  readonly #removeListener: () => void;
  readonly #interactions = new Map<string, PendingNativeInteraction>();
  #active: ActiveTurn | undefined;
  #closed = false;

  private constructor(client: CodexAppServerClient, threadId: string) {
    this.#client = client;
    this.#threadId = threadId;
    this.#removeListener = client.onMessage((message) => this.#onMessage(message));
  }

  static async open(
    context: OpenSessionContext,
    options: CodexProviderOptions,
  ): Promise<CodexRuntime> {
    const client = new CodexAppServerClient(await processOptions(options, context, context.cwd));
    try {
      await client.initialize();
      const stored = await context.getMetadata("codex.threadId");
      let threadId: string;
      if (typeof stored === "string" && stored.length > 0) {
        const resumed = object(
          await client.request("thread/resume", {
            threadId: stored,
            cwd: context.cwd,
            approvalPolicy: options.approvalPolicy ?? "on-request",
            sandbox: options.sandbox ?? "workspace-write",
            excludeTurns: true,
          }),
        );
        threadId = string(object(resumed.thread).id) ?? stored;
      } else {
        const started = object(
          await client.request("thread/start", {
            cwd: context.cwd,
            approvalPolicy: options.approvalPolicy ?? "on-request",
            sandbox: options.sandbox ?? "workspace-write",
            ephemeral: false,
            historyMode: "paginated",
          }),
        );
        threadId = string(object(started.thread).id) ?? "";
        if (!threadId) throw new CodexRpcError("thread/start", "Codex returned no thread ID");
        await context.setMetadata("codex.threadId", threadId);
      }
      return new CodexRuntime(client, threadId);
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  async *startTurn(request: ProviderTurnRequest): AsyncIterable<ProviderEvent> {
    if (this.#closed) throw new Error("Codex runtime is closed");
    if (this.#active) throw new Error("Codex runtime already has an active turn");
    const native = deferredString();
    const notification = deferredString();
    const ended = deferredVoid();
    const active: ActiveTurn = {
      queue: new AsyncEventQueue(),
      nativeIdReady: native.promise,
      resolveNativeId: native.resolve,
      notificationReady: notification.promise,
      resolveNotificationReady: notification.resolve,
      ended: ended.promise,
      resolveEnded: ended.resolve,
      interruptRequested: false,
    };
    this.#active = active;
    try {
      const result = object(
        await this.#client.request("turn/start", {
          threadId: this.#threadId,
          input: [{ type: "text", text: request.text, text_elements: [] }],
          ...(request.model === undefined ? {} : { model: request.model }),
          ...(request.reasoning === undefined ? {} : { effort: request.reasoning }),
          ...(request.permissionMode === "full_access"
            ? { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } }
            : request.permissionMode === "supervised"
              ? {
                  approvalPolicy: "on-request",
                  sandboxPolicy: { type: "workspaceWrite", writableRoots: [] },
                }
              : {}),
        }),
      );
      const nativeTurnId = string(object(result.turn).id);
      if (!nativeTurnId) throw new CodexRpcError("turn/start", "Codex returned no turn ID");
      this.#setNativeTurnId(active, nativeTurnId, false);
      if (active.interruptRequested && active.nativeTurnId) await this.#interruptActive(active);
      for await (const event of active.queue) yield event;
    } finally {
      active.resolveEnded();
      if (this.#active === active) this.#active = undefined;
      this.#interactions.clear();
    }
  }

  async steer(request: { text: string }): Promise<void> {
    const active = this.#active;
    if (!active) throw new Error("There is no active Codex turn");
    const nativeTurnId = await Promise.race([
      active.notificationReady!,
      active.ended.then(() => {
        throw new Error("Codex turn ended before steering became ready");
      }),
    ]);
    await this.#client.request("turn/steer", {
      threadId: this.#threadId,
      expectedTurnId: nativeTurnId,
      input: [{ type: "text", text: request.text, text_elements: [] }],
    });
  }

  async interrupt(): Promise<void> {
    const active = this.#active;
    if (!active) return;
    active.interruptRequested = true;
    const nativeTurnId =
      active.nativeTurnId ??
      (await Promise.race([
        active.nativeIdReady,
        active.ended.then(() => {
          throw new Error("Codex turn ended before interruption became ready");
        }),
      ]));
    await this.#client.request("turn/interrupt", {
      threadId: this.#threadId,
      turnId: nativeTurnId,
    });
  }

  async respondToPermission(response: ProviderPermissionResponse): Promise<void> {
    const pending = this.#interactions.get(response.providerRequestId);
    if (!pending || pending.kind !== "permission")
      throw new Error("Unknown Codex permission request");
    this.#interactions.delete(response.providerRequestId);
    await this.#client.respond(pending.id, { decision: permissionDecision(response.decision) });
  }

  async respondToInput(response: ProviderInputResponse): Promise<void> {
    const pending = this.#interactions.get(response.providerRequestId);
    if (!pending || pending.kind !== "input") throw new Error("Unknown Codex input request");
    this.#interactions.delete(response.providerRequestId);
    const answers = Object.fromEntries(
      (pending.questionIds ?? []).map((questionId) => [
        questionId,
        { answers: [...(response.response.answers[questionId] ?? [])] },
      ]),
    );
    await this.#client.respond(pending.id, { answers });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#active?.queue.fail(new Error("Codex runtime closed"));
    this.#removeListener();
    await this.#client.close();
  }

  #onMessage(message: JsonRpcMessage): void {
    const method = message.method;
    if (!method) return;
    if (method === "harness/processExited") {
      this.#active?.resolveEnded();
      this.#active?.queue.fail(new Error("Codex app-server exited unexpectedly"));
      return;
    }
    if (message.id !== undefined) {
      this.#onServerRequest(message);
      return;
    }
    const active = this.#active;
    if (!active) return;
    const params = object(message.params);
    const nativeThreadId = string(params.threadId);
    if (nativeThreadId && nativeThreadId !== this.#threadId) return;
    switch (method) {
      case "turn/started": {
        const id = string(object(params.turn).id);
        if (id) this.#setNativeTurnId(active, id, true);
        return;
      }
      case "item/agentMessage/delta": {
        const messageId = string(params.itemId);
        const delta = string(params.delta);
        if (messageId && delta !== undefined)
          active.queue.push({ type: "message.delta", messageId, delta, raw: message });
        return;
      }
      case "item/started":
        this.#itemStarted(active, object(params.item), message);
        return;
      case "item/completed":
        this.#itemCompleted(active, object(params.item), message);
        return;
      case "item/commandExecution/outputDelta":
      case "item/fileChange/outputDelta":
      case "item/fileChange/patchUpdated":
      case "item/mcpToolCall/progress": {
        const toolId = string(params.itemId);
        if (toolId)
          active.queue.push({ type: "tool.updated", toolId, update: params, raw: message });
        return;
      }
      case "turn/completed": {
        const turn = object(params.turn);
        const status = string(turn.status);
        if (status === "completed") active.queue.push({ type: "turn.completed", raw: message });
        else if (status === "interrupted")
          active.queue.push({
            type: "turn.interrupted",
            reason: "Interrupted by Codex",
            raw: message,
          });
        else
          active.queue.push({
            type: "turn.failed",
            code: "CODEX_TURN_FAILED",
            message: turnErrorMessage(turn),
            mayHaveSideEffects: true,
            raw: message,
          });
        active.queue.end();
        active.resolveEnded();
        return;
      }
      case "error":
      case "warning":
      case "guardianWarning":
      case "deprecationNotice":
      case "configWarning":
      case "harness/malformed":
        active.queue.push({
          type: "diagnostic",
          level: method === "error" || method === "harness/malformed" ? "error" : "warning",
          message: string(params.message) ?? `Codex emitted ${method}`,
          code: method === "harness/malformed" ? "CODEX_MALFORMED_MESSAGE" : "CODEX_DIAGNOSTIC",
          raw: message,
        });
        return;
      default:
        if (!ignoredNotification(method))
          active.queue.push({
            type: "diagnostic",
            level: "info",
            message: `Ignored unknown Codex notification: ${method}`,
            code: "CODEX_UNKNOWN_MESSAGE",
            raw: message,
          });
    }
  }

  #onServerRequest(message: JsonRpcMessage): void {
    const active = this.#active;
    if (!active || message.id === undefined || !message.method) return;
    const params = object(message.params);
    const nativeThreadId = string(params.threadId);
    if (nativeThreadId && nativeThreadId !== this.#threadId) return;
    const providerRequestId = String(message.id);
    if (
      message.method === "item/commandExecution/requestApproval" ||
      message.method === "item/fileChange/requestApproval" ||
      message.method === "item/permissions/requestApproval" ||
      message.method === "execCommandApproval" ||
      message.method === "applyPatchApproval"
    ) {
      this.#interactions.set(providerRequestId, { id: message.id, kind: "permission" });
      active.queue.push({
        type: "permission.requested",
        providerRequestId,
        title: string(params.reason) ?? string(params.title) ?? "Codex requests permission",
        toolName:
          message.method.includes("file") || message.method.includes("Patch")
            ? "file_change"
            : "shell",
        input: params,
        raw: message,
      });
      return;
    }
    if (message.method === "item/tool/requestUserInput") {
      const questions = Array.isArray(params.questions)
        ? params.questions.filter(isObject).map(normalizeQuestion)
        : [];
      this.#interactions.set(providerRequestId, {
        id: message.id,
        kind: "input",
        questionIds: questions.map((question) => question.id),
      });
      active.queue.push({
        type: "input.requested",
        providerRequestId,
        title: "Codex needs input",
        questions,
        raw: message,
      });
      return;
    }
    void this.#client.respondError(
      message.id,
      -32601,
      `Unsupported server request: ${message.method}`,
    );
    active.queue.push({
      type: "diagnostic",
      level: "warning",
      message: `Rejected unknown Codex server request: ${message.method}`,
      code: "CODEX_UNKNOWN_SERVER_REQUEST",
      raw: message,
    });
  }

  #itemStarted(active: ActiveTurn, item: JsonObject, raw: JsonRpcMessage): void {
    const id = string(item.id);
    const type = string(item.type);
    if (!id || !type) return;
    if (type === "agentMessage") {
      active.queue.push({ type: "message.started", messageId: id, role: "assistant", raw });
      return;
    }
    const name = itemName(item);
    if (name) active.queue.push({ type: "tool.started", toolId: id, name, input: item, raw });
  }

  #itemCompleted(active: ActiveTurn, item: JsonObject, raw: JsonRpcMessage): void {
    const id = string(item.id);
    const type = string(item.type);
    if (!id || !type) return;
    if (type === "agentMessage") {
      active.queue.push({
        type: "message.completed",
        messageId: id,
        ...(string(item.text) === undefined ? {} : { text: string(item.text)! }),
        raw,
      });
      return;
    }
    const name = itemName(item);
    if (name) {
      const status = string(item.status);
      active.queue.push({
        type: "tool.completed",
        toolId: id,
        output: item,
        ...(status === undefined ? {} : { isError: ["failed", "declined"].includes(status) }),
        raw,
      });
    }
  }

  #setNativeTurnId(active: ActiveTurn, id: string, notificationReady: boolean): void {
    if (!active.nativeTurnId) {
      active.nativeTurnId = id;
      active.resolveNativeId(id);
    }
    if (notificationReady) active.resolveNotificationReady(id);
  }

  async #interruptActive(active: ActiveTurn): Promise<void> {
    const nativeTurnId = active.nativeTurnId ?? (await active.nativeIdReady);
    await this.#client.request("turn/interrupt", {
      threadId: this.#threadId,
      turnId: nativeTurnId,
    });
  }
}

function normalizeQuestion(question: JsonObject): InputQuestion {
  const id = string(question.id) ?? "question";
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
    prompt: string(question.question) ?? string(question.header) ?? "Codex question",
    ...(options.length === 0 ? {} : { options }),
    multiple: question.multiple === true || question.multiSelect === true,
    allowFreeText: question.isOther === true,
  };
}

function ignoredNotification(method: string): boolean {
  return (
    method.startsWith("thread/") ||
    method.startsWith("mcpServer/") ||
    method.startsWith("account/") ||
    method.startsWith("hook/") ||
    method.startsWith("rawResponse") ||
    method.startsWith("model/") ||
    method.startsWith("serverRequest/") ||
    method.startsWith("item/reasoning/") ||
    method === "remoteControl/status/changed"
  );
}

function statusFromError(error: unknown): ProviderStatus {
  const message = error instanceof Error ? error.message : String(error);
  const code = isObject(error) ? string(error.code) : undefined;
  if (code === "ENOENT" || message.includes("ENOENT")) {
    return { state: "not_installed", message: "Codex executable was not found" };
  }
  if (/auth|login|credential/i.test(message)) {
    return { state: "not_authenticated", message: "Codex is not authenticated" };
  }
  return { state: "unavailable", message: "Codex app-server is unavailable" };
}

export function createCodexProvider(options: CodexProviderOptions = {}): ProviderAdapterV1 {
  return {
    apiVersion: 1,
    id: "codex",
    async status(context: ProviderContext): Promise<ProviderStatus> {
      let client: CodexAppServerClient | undefined;
      try {
        client = new CodexAppServerClient(await processOptions(options, context, context.homeDir));
        const initialized = await client.initialize();
        const result = object(await client.request("account/read", { refreshToken: false }));
        if (!isObject(result.account)) {
          return { state: "not_authenticated", message: "Codex account is not authenticated" };
        }
        return {
          state: "ready",
          ...(string(initialized.userAgent) ? { version: string(initialized.userAgent)! } : {}),
        };
      } catch (error) {
        return statusFromError(error);
      } finally {
        await client?.close().catch(() => undefined);
      }
    },
    async capabilities(): Promise<ProviderCapabilities> {
      return capabilities;
    },
    async openSession(context: OpenSessionContext): Promise<ProviderRuntime> {
      return await CodexRuntime.open(context, options);
    },
  };
}
