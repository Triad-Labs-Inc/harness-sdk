#!/usr/bin/env node

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";

type JsonObject = Record<string, unknown>;

const live = process.env.HARNESS_RUN_LIVE_PROBES === "1";
const executable = process.env.CODEX_EXECUTABLE ?? "codex";
const cwd = resolve(process.env.HARNESS_PROBE_CWD ?? process.cwd());
const fixturePath = process.env.HARNESS_PROBE_FIXTURE;

const sensitiveKey = /(?:token|secret|authorization|credential|email|path|cwd|root|rollout)/i;
const identifierKey = /(?:^id$|Id$|_id$|sessionId|threadId|turnId|itemId|requestId|uuid)/;
const uuidPattern = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const emailPattern = /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/g;

function sanitize(value: unknown, key = ""): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    if (sensitiveKey.test(key)) return "<redacted>";
    if (identifierKey.test(key)) return `<${key || "id"}>`;
    const redacted = value
      .replaceAll(process.env.HOME ?? "<no-home>", "<home>")
      .replaceAll(cwd, "<cwd>")
      .replace(uuidPattern, "<uuid>")
      .replace(emailPattern, "<email>");
    return redacted.length > 500 ? `${redacted.slice(0, 500)}<truncated>` : redacted;
  }
  if (Array.isArray(value)) return value.map((item) => sanitize(item, key));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as JsonObject).map(([childKey, child]) => [
        childKey,
        sanitize(child, childKey),
      ]),
    );
  }
  return `<${typeof value}>`;
}

class CodexProbe {
  readonly child: ChildProcessWithoutNullStreams;
  readonly fixtures: JsonObject[] = [];
  #nextId = 1;
  #pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  #notifications: JsonObject[] = [];
  #notificationWaiters: Array<{
    predicate(message: JsonObject): boolean;
    resolve(message: JsonObject): void;
    reject(error: Error): void;
    timer: NodeJS.Timeout;
  }> = [];
  #closed = false;

  constructor() {
    this.child = spawn(executable, ["app-server", "--stdio"], {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    createInterface({ input: this.child.stdout }).on("line", (line) => this.#onLine(line));
    createInterface({ input: this.child.stderr }).on("line", (line) => {
      this.#record("stderr", { line });
    });
    this.child.once("error", (error) => this.#failAll(error));
    this.child.once("exit", (code, signal) => {
      if (!this.#closed) this.#failAll(new Error(`app-server exited (${code ?? signal})`));
    });
  }

  async request(method: string, params: unknown, timeoutMs = 15_000): Promise<unknown> {
    const id = this.#nextId++;
    this.#write({ id, method, params });
    return await new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        rejectRequest(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolveRequest(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          rejectRequest(error);
        },
      });
    });
  }

  notify(method: string, params?: unknown): void {
    this.#write(params === undefined ? { method } : { method, params });
  }

  async waitFor(
    predicate: (message: JsonObject) => boolean,
    timeoutMs = 60_000,
  ): Promise<JsonObject> {
    const existing = this.#notifications.find(predicate);
    if (existing) return existing;
    return await new Promise((resolveWaiter, rejectWaiter) => {
      const waiter = {
        predicate,
        resolve: resolveWaiter,
        reject: rejectWaiter,
        timer: setTimeout(() => {
          this.#notificationWaiters = this.#notificationWaiters.filter((item) => item !== waiter);
          rejectWaiter(new Error(`notification wait timed out after ${timeoutMs}ms`));
        }, timeoutMs),
      };
      this.#notificationWaiters.push(waiter);
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.child.stdin.end();
    const exited = new Promise<void>((resolveExit) => this.child.once("exit", () => resolveExit()));
    const graceful = await Promise.race([
      exited.then(() => true),
      new Promise<false>((resolveTimeout) => setTimeout(() => resolveTimeout(false), 2_000)),
    ]);
    if (!graceful) {
      if (process.platform === "win32") this.child.kill("SIGTERM");
      else process.kill(-this.child.pid!, "SIGTERM");
      await Promise.race([
        exited,
        new Promise((resolveTimeout) => setTimeout(resolveTimeout, 2_000)),
      ]);
    }
    this.#record("lifecycle", { state: "closed", graceful });
  }

  async saveFixtures(): Promise<void> {
    if (!fixturePath) return;
    await mkdir(dirname(resolve(fixturePath)), { recursive: true });
    await writeFile(
      resolve(fixturePath),
      `${this.fixtures.map((fixture) => JSON.stringify(fixture)).join("\n")}\n`,
      "utf8",
    );
  }

  #write(message: JsonObject): void {
    this.#record("client", message);
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #onLine(line: string): void {
    let message: JsonObject;
    try {
      message = JSON.parse(line) as JsonObject;
    } catch {
      this.#record("invalid-json", { line });
      return;
    }
    this.#record("server", message);

    if (typeof message.id === "number" && typeof message.method !== "string") {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error && typeof message.error === "object") {
        pending.reject(new Error(JSON.stringify(sanitize(message.error))));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (typeof message.id !== "undefined" && typeof message.method === "string") {
      this.#rememberNotification(message);
      this.#answerServerRequest(message);
      return;
    }

    this.#rememberNotification(message);
  }

  #rememberNotification(message: JsonObject): void {
    this.#notifications.push(message);
    for (const waiter of [...this.#notificationWaiters]) {
      if (!waiter.predicate(message)) continue;
      clearTimeout(waiter.timer);
      this.#notificationWaiters = this.#notificationWaiters.filter((item) => item !== waiter);
      waiter.resolve(message);
    }
  }

  #answerServerRequest(message: JsonObject): void {
    const method = String(message.method);
    const params = (message.params ?? {}) as JsonObject;
    let result: unknown;
    if (method === "item/tool/requestUserInput") {
      const questions = Array.isArray(params.questions) ? (params.questions as JsonObject[]) : [];
      result = {
        answers: Object.fromEntries(
          questions.map((question) => {
            const options = Array.isArray(question.options)
              ? (question.options as JsonObject[])
              : [];
            const answer = String(options[0]?.label ?? "fixture answer");
            return [String(question.id), { answers: [answer] }];
          }),
        ),
      };
    } else if (
      method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval"
    ) {
      result = { decision: "accept" };
    } else if (method === "execCommandApproval" || method === "applyPatchApproval") {
      result = "accept";
    } else if (method === "currentTime/read") {
      result = { time: new Date().toISOString(), timezone: "UTC" };
    } else {
      this.#write({
        id: message.id,
        error: { code: -32601, message: "Unsupported probe request" },
      });
      return;
    }
    this.#write({ id: message.id, result });
  }

  #record(direction: string, message: JsonObject): void {
    const fixture = { direction, message: sanitize(message) as JsonObject };
    this.fixtures.push(fixture);
    console.log(JSON.stringify(fixture));
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    for (const waiter of this.#notificationWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.#notificationWaiters = [];
  }
}

async function main(): Promise<void> {
  const probe = new CodexProbe();
  try {
    await probe.request("initialize", {
      clientInfo: { name: "harness-sdk-probe", title: "Harness SDK Probe", version: "0.0.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    probe.notify("initialized");
    await probe.request("account/read", { refreshToken: false });

    const started = (await probe.request("thread/start", {
      cwd,
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      // Ephemeral threads intentionally have no rollout and cannot be resumed.
      ephemeral: false,
      historyMode: "paginated",
    })) as { thread: { id: string }; model: string };
    const threadId = started.thread.id;

    if (live) {
      const first = (await probe.request("turn/start", {
        threadId,
        collaborationMode: {
          mode: "plan",
          settings: {
            model: started.model,
            reasoning_effort: "low",
            developer_instructions: null,
          },
        },
        input: [
          {
            type: "text",
            text: "Use request_user_input to ask which fixture label to use, then reply with the selected label.",
            text_elements: [],
          },
        ],
      })) as { turn: { id: string } };
      await probe.waitFor(
        (message) =>
          message.method === "turn/started" &&
          (message.params as JsonObject | undefined)?.turn &&
          ((message.params as JsonObject).turn as JsonObject).id === first.turn.id,
      );
      await probe.request("turn/steer", {
        threadId,
        expectedTurnId: first.turn.id,
        input: [
          { type: "text", text: "Keep the final reply to one short line.", text_elements: [] },
        ],
      });
      await probe.waitFor((message) => message.method === "item/tool/requestUserInput");
      await probe.waitFor(
        (message) =>
          message.method === "turn/completed" &&
          (message.params as JsonObject | undefined)?.turn &&
          ((message.params as JsonObject).turn as JsonObject).id === first.turn.id,
      );

      // A new thread has no resumable rollout until its first turn materializes one.
      await probe.request("thread/resume", { threadId, cwd, excludeTurns: false });

      const second = (await probe.request("turn/start", {
        threadId,
        collaborationMode: {
          mode: "default",
          settings: {
            model: started.model,
            reasoning_effort: "low",
            developer_instructions: null,
          },
        },
        input: [
          {
            type: "text",
            text: "Run `sleep 30` once with escalated permissions, wait for it to finish, then reply done.",
            text_elements: [],
          },
        ],
      })) as { turn: { id: string } };
      await probe.waitFor(
        (message) =>
          message.method === "turn/started" &&
          (message.params as JsonObject | undefined)?.turn &&
          ((message.params as JsonObject).turn as JsonObject).id === second.turn.id,
      );
      const approvalOrCompletion = await probe.waitFor(
        (message) =>
          message.method === "item/commandExecution/requestApproval" ||
          (message.method === "turn/completed" &&
            (message.params as JsonObject | undefined)?.turn &&
            ((message.params as JsonObject).turn as JsonObject).id === second.turn.id),
      );
      if (approvalOrCompletion.method !== "item/commandExecution/requestApproval") {
        throw new Error("Codex completed the probe turn without requesting approval");
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
      await probe.request("turn/interrupt", { threadId, turnId: second.turn.id });
      await probe.waitFor(
        (message) =>
          message.method === "turn/completed" &&
          (message.params as JsonObject | undefined)?.turn &&
          ((message.params as JsonObject).turn as JsonObject).id === second.turn.id,
      );
    }
  } finally {
    await probe.close();
    await probe.saveFixtures();
  }
}

await main();
