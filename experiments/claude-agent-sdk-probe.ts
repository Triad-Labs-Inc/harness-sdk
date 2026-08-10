#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

type JsonObject = Record<string, unknown>;
type Query = AsyncGenerator<JsonObject, void> & { close(): void; interrupt(): Promise<unknown> };
type QueryFunction = (params: { prompt: string; options: JsonObject }) => Query;

const live = process.env.HARNESS_RUN_LIVE_PROBES === "1";
const allowLocalLogin = process.env.HARNESS_PROBE_ALLOW_LOCAL_CLAUDE_LOGIN === "1";
const cwd = resolve(process.env.HARNESS_PROBE_CWD ?? process.cwd());
const fixturePath = process.env.HARNESS_PROBE_FIXTURE;
const sdkEntry = process.env.CLAUDE_AGENT_SDK_ENTRY;
const claudeExecutable = process.env.CLAUDE_EXECUTABLE;
const fixtures: JsonObject[] = [];

const sensitiveKey = /(?:token|secret|authorization|credential|email|path|cwd|root|apiKey)/i;
const identifierKey = /(?:^id$|Id$|_id$|session_id|sessionId|uuid|request_id)/;
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

function record(kind: string, value: unknown): void {
  const fixture = { kind, value: sanitize(value) };
  fixtures.push(fixture);
  console.log(JSON.stringify(fixture));
}

async function loadQuery(): Promise<QueryFunction> {
  const moduleSpecifier = sdkEntry
    ? pathToFileURL(resolve(sdkEntry)).href
    : "@anthropic-ai/claude-agent-sdk";
  const sdk = (await import(moduleSpecifier)) as { query: QueryFunction };
  record("sdk", { entry: sdkEntry ? "explicit" : "package", query: typeof sdk.query });
  return sdk.query;
}

function createOptions(abortController: AbortController, resume?: string): JsonObject {
  return {
    abortController,
    cwd,
    resume,
    permissionMode: "default",
    settingSources: [],
    tools: ["AskUserQuestion", "Bash"],
    includePartialMessages: true,
    ...(claudeExecutable ? { pathToClaudeCodeExecutable: resolve(claudeExecutable) } : {}),
    canUseTool: async (toolName: string, input: JsonObject, context: JsonObject) => {
      record("canUseTool", { toolName, input, context });
      if (toolName === "AskUserQuestion") {
        const questions = Array.isArray(input.questions) ? (input.questions as JsonObject[]) : [];
        return {
          behavior: "allow",
          updatedInput: {
            questions,
            answers: Object.fromEntries(
              questions.map((question) => {
                const options = Array.isArray(question.options)
                  ? (question.options as JsonObject[])
                  : [];
                return [String(question.question), String(options[0]?.label ?? "fixture answer")];
              }),
            ),
          },
        };
      }
      return { behavior: "allow", updatedInput: input };
    },
  };
}

async function consume(query: Query): Promise<string | undefined> {
  let sessionId: string | undefined;
  try {
    for await (const message of query) {
      record("message", message);
      if (typeof message.session_id === "string") sessionId = message.session_id;
    }
    return sessionId;
  } finally {
    query.close();
    record("lifecycle", { state: "closed" });
  }
}

async function main(): Promise<void> {
  const query = await loadQuery();
  record("authentication-contract", {
    apiKeySupported: true,
    apiKeyPresent: Boolean(process.env.ANTHROPIC_API_KEY),
    localClaudeLoginEnabledForProbe: allowLocalLogin,
  });

  if (!live) return;
  if (!process.env.ANTHROPIC_API_KEY && !allowLocalLogin) {
    throw new Error(
      "Live Claude probes require ANTHROPIC_API_KEY or HARNESS_PROBE_ALLOW_LOCAL_CLAUDE_LOGIN=1.",
    );
  }

  const firstController = new AbortController();
  const sessionId = await consume(
    query({
      prompt:
        "Use AskUserQuestion to ask which fixture label to use. After the answer, run `printf harness-claude-probe` once, then reply with the selected label.",
      options: createOptions(firstController),
    }),
  );
  if (!sessionId) throw new Error("Claude stream did not expose a session_id");

  const resumeController = new AbortController();
  const resumedSessionId = await consume(
    query({
      prompt: "Reply with exactly RESUMED.",
      options: createOptions(resumeController, sessionId),
    }),
  );
  if (resumedSessionId !== sessionId) {
    throw new Error("Claude resume changed session_id unexpectedly");
  }

  const cancelController = new AbortController();
  const cancelling = query({
    prompt: "Run `sleep 30` once, wait for it to finish, then reply done.",
    options: createOptions(cancelController, sessionId),
  });
  const cancellationTimer = setTimeout(() => cancelController.abort(), 750);
  try {
    await consume(cancelling);
  } catch (error) {
    record("cancellation", { name: (error as Error).name, message: (error as Error).message });
  } finally {
    clearTimeout(cancellationTimer);
    cancelling.close();
  }
}

try {
  await main();
} finally {
  if (fixturePath) {
    await mkdir(dirname(resolve(fixturePath)), { recursive: true });
    await writeFile(
      resolve(fixturePath),
      `${fixtures.map((fixture) => JSON.stringify(fixture)).join("\n")}\n`,
      "utf8",
    );
  }
}
