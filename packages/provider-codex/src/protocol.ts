import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

import spawn from "cross-spawn";

export type JsonObject = Record<string, unknown>;

export interface JsonRpcMessage extends JsonObject {
  readonly id?: string | number;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

export interface CodexProcessOptions {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly requestTimeoutMs: number;
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export class CodexRpcError extends Error {
  readonly method: string;
  readonly details: unknown;

  constructor(method: string, message: string, details?: unknown) {
    super(message);
    this.name = "CodexRpcError";
    this.method = method;
    this.details = details;
  }
}

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (isObject(error) && typeof error.message === "string") return error.message;
  return String(error);
}

export class CodexAppServerClient {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #timeoutMs: number;
  readonly #pending = new Map<string | number, PendingRequest>();
  readonly #listeners = new Set<(message: JsonRpcMessage) => void>();
  readonly #exitPromise: Promise<void>;
  #nextId = 1;
  #closed = false;
  #writeTail: Promise<void> = Promise.resolve();

  constructor(options: CodexProcessOptions) {
    this.#timeoutMs = options.requestTimeoutMs;
    this.#child = spawn(options.executable, [...options.args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    }) as ChildProcessWithoutNullStreams;
    this.#exitPromise = new Promise((resolve) => {
      this.#child.once("exit", () => {
        this.#failPending(new CodexRpcError("process", "Codex app-server exited"));
        for (const listener of this.#listeners) listener({ method: "harness/processExited" });
        resolve();
      });
      this.#child.once("error", (error) => {
        this.#failPending(error);
        for (const listener of this.#listeners)
          listener({ method: "harness/processExited", params: { message: error.message } });
        resolve();
      });
    });

    const lines = createInterface({ input: this.#child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.#readLine(line));
    this.#child.stderr.resume();
  }

  async initialize(): Promise<JsonObject> {
    const result = await this.request("initialize", {
      clientInfo: { name: "harness-sdk", title: "Harness SDK", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    await this.notify("initialized");
    return isObject(result) ? result : {};
  }

  onMessage(listener: (message: JsonRpcMessage) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    if (this.#closed) throw new CodexRpcError(method, "Codex app-server is closed");
    const id = this.#nextId++;
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new CodexRpcError(method, `Codex request timed out: ${method}`));
      }, this.#timeoutMs);
      timer.unref?.();
      this.#pending.set(id, { method, resolve, reject, timer });
    });
    try {
      await this.#write(params === undefined ? { id, method } : { id, method, params });
    } catch (error) {
      const pending = this.#pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.#pending.delete(id);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    return await result;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.#write(params === undefined ? { method } : { method, params });
  }

  async respond(id: string | number, result: unknown): Promise<void> {
    await this.#write({ id, result });
  }

  async respondError(id: string | number, code: number, message: string): Promise<void> {
    await this.#write({ id, error: { code, message } });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#child.stdin.end();
    if (await this.#waitForExit(1_500)) return;
    await this.#terminate("SIGTERM");
    if (await this.#waitForExit(1_000)) return;
    await this.#terminate("SIGKILL");
    await this.#waitForExit(1_000);
  }

  async #write(message: JsonRpcMessage): Promise<void> {
    const encoded = `${JSON.stringify(message)}\n`;
    const operation = this.#writeTail.then(
      () =>
        new Promise<void>((resolve, reject) => {
          this.#child.stdin.write(encoded, (error) => (error ? reject(error) : resolve()));
        }),
    );
    this.#writeTail = operation.catch(() => undefined);
    await operation;
  }

  #readLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      for (const listener of this.#listeners)
        listener({ method: "harness/malformed", params: { line } });
      return;
    }
    if (!isObject(message)) {
      for (const listener of this.#listeners)
        listener({ method: "harness/malformed", params: { value: message } });
      return;
    }
    const rpc = message as JsonRpcMessage;
    if (rpc.id !== undefined && rpc.method === undefined) {
      const pending = this.#pending.get(rpc.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(rpc.id);
      if (rpc.error !== undefined) {
        pending.reject(new CodexRpcError(pending.method, errorMessage(rpc.error), rpc.error));
      } else pending.resolve(rpc.result);
      return;
    }
    for (const listener of this.#listeners) listener(rpc);
  }

  #failPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  async #waitForExit(timeoutMs: number): Promise<boolean> {
    return await Promise.race([
      this.#exitPromise.then(() => true),
      new Promise<false>((resolve) => {
        const timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref?.();
      }),
    ]);
  }

  async #terminate(signal: NodeJS.Signals): Promise<void> {
    const pid = this.#child.pid;
    if (!pid) return;
    try {
      if (process.platform === "win32") {
        const started = await new Promise<boolean>((resolve) => {
          const killer = spawn(
            "taskkill",
            ["/pid", String(pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])],
            { stdio: "ignore", windowsHide: true },
          );
          killer.once("error", () => resolve(false));
          killer.once("exit", () => resolve(true));
        });
        if (!started) this.#child.kill(signal);
      } else process.kill(-pid, signal);
    } catch {
      try {
        this.#child.kill(signal);
      } catch {
        // The process already exited.
      }
    }
  }
}
