import type {
  AccountInfo,
  PermissionResult,
  Query,
  SDKControlInitializeResponse,
} from "@anthropic-ai/claude-agent-sdk";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHarness, createMemoryStore } from "@harness-sdk/core";
import { providerContract, type ProviderContractScenario } from "@harness-sdk/testkit";
import { expect, it } from "vitest";

import { createClaudeProvider, type ClaudeQueryFactory } from "./adapter.js";

class Signal {
  readonly promise: Promise<void>;
  #resolve!: () => void;

  constructor() {
    this.promise = new Promise((resolve) => {
      this.#resolve = resolve;
    });
  }

  fire(): void {
    this.#resolve();
  }
}

function result(sessionId: string, isError = false): Record<string, unknown> {
  return {
    type: "result",
    subtype: isError ? "error_during_execution" : "success",
    is_error: isError,
    result: isError ? "fixture error" : "fixture complete",
    errors: isError ? ["fixture error"] : [],
    session_id: sessionId,
    uuid: "result-uuid",
  };
}

function initialization(account: AccountInfo): SDKControlInitializeResponse {
  return {
    commands: [],
    agents: [],
    output_style: "default",
    available_output_styles: ["default"],
    models: [],
    account,
  };
}

function fixtureQuery(scenario: ProviderContractScenario): ClaudeQueryFactory {
  return ({ prompt, options = {} }) => {
    const signal = new Signal();
    const sessionId = "00000000-0000-4000-8000-000000000001";
    const messages = (async function* () {
      yield {
        type: "system",
        subtype: "init",
        session_id: sessionId,
        claude_code_version: "fixture",
      };
      if (scenario === "crash") throw new Error("Injected Claude SDK crash");
      if (scenario === "failed") {
        yield result(sessionId, true);
        return;
      }
      if (scenario === "unknown") {
        yield { type: "future_additive_message", session_id: sessionId };
        yield result(sessionId);
        return;
      }
      if (scenario === "interrupt") {
        await signal.promise;
        yield result(sessionId, true);
        return;
      }
      if (scenario === "tools") {
        yield {
          type: "assistant",
          session_id: sessionId,
          uuid: "assistant-tool-uuid",
          message: {
            id: "assistant-tool-message",
            role: "assistant",
            content: [{ type: "tool_use", id: "fixture-tool", name: "Bash", input: {} }],
          },
        };
        yield {
          type: "user",
          session_id: sessionId,
          uuid: "user-tool-uuid",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "fixture-tool",
                content: "done",
                is_error: false,
              },
            ],
          },
        };
        yield result(sessionId);
        return;
      }
      if (scenario.startsWith("permission_")) {
        const permission = await options.canUseTool!(
          "Bash",
          { command: "fixture" },
          {
            signal: new AbortController().signal,
            suggestions: [
              {
                type: "addRules",
                rules: [{ toolName: "Bash", ruleContent: "fixture" }],
                behavior: "allow",
                destination: "session",
              },
            ],
            title: "Allow fixture?",
            toolUseID: "tool-use",
            requestId: "permission-request",
          },
        );
        if ((permission as PermissionResult).behavior === "deny" && permission?.interrupt) {
          await signal.promise;
          yield result(sessionId, true);
          return;
        }
        yield result(sessionId);
        return;
      }
      if (scenario === "questions") {
        await options.canUseTool!(
          "AskUserQuestion",
          {
            questions: [
              {
                id: "q-single",
                question: "Single?",
                header: "Single",
                options: [{ label: "yes", description: "Yes" }],
                multiSelect: false,
              },
              {
                id: "q-multi",
                question: "Multiple?",
                header: "Multiple",
                options: [
                  { label: "one", description: "One" },
                  { label: "two", description: "Two" },
                ],
                multiSelect: true,
              },
              {
                id: "q-free",
                question: "Free?",
                header: "Free",
                options: [],
                multiSelect: false,
              },
            ],
          },
          {
            signal: new AbortController().signal,
            toolUseID: "question-use",
            requestId: "question-request",
          },
        );
        yield result(sessionId);
        return;
      }
      if (prompt === "stream") {
        yield {
          type: "stream_event",
          session_id: sessionId,
          uuid: "stream-start",
          event: { type: "message_start", message: { id: "assistant-message" } },
        };
        for (const text of ["one", "two"]) {
          yield {
            type: "stream_event",
            session_id: sessionId,
            uuid: `stream-${text}`,
            event: { type: "content_block_delta", delta: { type: "text_delta", text } },
          };
        }
        yield {
          type: "assistant",
          session_id: sessionId,
          uuid: "assistant-uuid",
          message: {
            id: "assistant-message",
            role: "assistant",
            content: [
              { type: "text", text: "one" },
              { type: "text", text: "two" },
            ],
          },
        };
        yield {
          type: "stream_event",
          session_id: sessionId,
          uuid: "stream-stop",
          event: { type: "message_stop" },
        };
      }
      yield result(sessionId);
    })();

    return Object.assign(messages, {
      async initializationResult() {
        return initialization({
          email: "fixture@example.invalid",
          subscriptionType: "max",
          tokenSource: "oauth",
          apiProvider: "firstParty",
        });
      },
      async interrupt() {
        signal.fire();
        return undefined;
      },
      close() {
        signal.fire();
      },
    }) as unknown as Query;
  };
}

function statusQuery(account: AccountInfo): ClaudeQueryFactory {
  return () => {
    const messages = (async function* () {})();
    return Object.assign(messages, {
      async initializationResult() {
        return initialization(account);
      },
      async interrupt() {
        return undefined;
      },
      close() {},
    }) as unknown as Query;
  };
}

function adapterFor(scenario: ProviderContractScenario) {
  return createClaudeProvider({
    queryFactory: fixtureQuery(scenario),
    environment: async () => ({ ANTHROPIC_API_KEY: "fixture-secret" }),
    settingSources: [],
  });
}

providerContract("Claude SDK fixture", adapterFor);

it("passes explicit default setting sources and the captured resume ID", async () => {
  const seen: Array<{ settingSources?: readonly string[]; resume?: string }> = [];
  const delegate = fixtureQuery("resume");
  const queryFactory: ClaudeQueryFactory = (parameters) => {
    if (typeof parameters.prompt === "string") {
      seen.push({
        ...(parameters.options?.settingSources
          ? { settingSources: parameters.options.settingSources }
          : {}),
        ...(parameters.options?.resume ? { resume: parameters.options.resume } : {}),
      });
    }
    return delegate(parameters);
  };
  const homeDir = await mkdtemp(join(tmpdir(), "harness-claude-resume-"));
  const harness = await createHarness({
    homeDir,
    providers: {
      claude: createClaudeProvider({
        queryFactory,
        environment: async () => ({ ANTHROPIC_API_KEY: "fixture-secret" }),
      }),
    },
    store: createMemoryStore(),
    idleTimeoutMs: 5,
  });
  const session = await harness.sessions.create({ provider: "claude", cwd: homeDir });
  await (await session.send({ text: "first" })).done();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await (await session.send({ text: "second" })).done();
  expect(seen[0]?.settingSources).toEqual(["user", "project", "local"]);
  expect(seen[1]?.resume).toBe("00000000-0000-4000-8000-000000000001");
  await harness.close();
});

it("reports local subscription and API-key authentication without sending a prompt", async () => {
  const context = { homeDir: tmpdir(), registerSecrets: () => undefined };
  let probePromptWasStreaming = false;
  let probePersistedSession = true;
  const subscriptionQuery: ClaudeQueryFactory = (parameters) => {
    probePromptWasStreaming = typeof parameters.prompt !== "string";
    probePersistedSession = parameters.options?.persistSession ?? true;
    return statusQuery({
      email: "fixture@example.invalid",
      subscriptionType: "max",
      tokenSource: "oauth",
      apiProvider: "firstParty",
    })(parameters);
  };
  await expect(
    createClaudeProvider({
      queryFactory: subscriptionQuery,
    }).status(context),
  ).resolves.toMatchObject({ state: "ready" });
  expect(probePromptWasStreaming).toBe(true);
  expect(probePersistedSession).toBe(false);

  await expect(
    createClaudeProvider({
      queryFactory: statusQuery({ tokenSource: "apiKey", apiProvider: "firstParty" }),
      environment: async () => ({ ANTHROPIC_API_KEY: "fixture" }),
    }).status(context),
  ).resolves.toMatchObject({ state: "ready" });

  await expect(
    createClaudeProvider({
      queryFactory: statusQuery({ apiProvider: "firstParty" }),
    }).status(context),
  ).resolves.toMatchObject({ state: "not_authenticated" });

  await expect(
    createClaudeProvider({
      executable: join(tmpdir(), "definitely-missing-harness-claude"),
    }).status(context),
  ).resolves.toMatchObject({ state: "not_installed" });
});

it("closes a timed-out Claude status probe", async () => {
  let closed = false;
  const queryFactory: ClaudeQueryFactory = () => {
    const messages = (async function* () {})();
    return Object.assign(messages, {
      async initializationResult() {
        return await new Promise<SDKControlInitializeResponse>(() => undefined);
      },
      async interrupt() {
        return undefined;
      },
      close() {
        closed = true;
      },
    }) as unknown as Query;
  };
  const context = { homeDir: tmpdir(), registerSecrets: () => undefined };
  await expect(
    createClaudeProvider({ queryFactory, statusTimeoutMs: 5 }).status(context),
  ).resolves.toMatchObject({ state: "unavailable" });
  expect(closed).toBe(true);
});
