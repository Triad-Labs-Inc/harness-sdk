import type { ProviderAdapterV1 } from "@triadlabs/harness-sdk";
import {
  providerContract,
  type ProviderContractScenario,
} from "@triadlabs/harness-sdk/testkit/vitest";

import { createMastraProvider } from "./adapter.js";

const encoder = new TextEncoder();

function streamResponse(chunks: readonly unknown[]): Response {
  const body = chunks
    .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
    .join("")
    .concat("data: [DONE]\n\n");
  return new Response(encoder.encode(body), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function scenarioChunks(scenario: ProviderContractScenario): readonly unknown[] {
  switch (scenario) {
    case "tools":
      return [
        {
          type: "tool-call",
          payload: {
            toolCallId: "fixture-tool",
            toolName: "fixture",
            args: { value: true },
          },
        },
        {
          type: "tool-result",
          payload: {
            toolCallId: "fixture-tool",
            toolName: "fixture",
            result: "done",
          },
        },
        { type: "finish", payload: { stepResult: { reason: "stop" } } },
      ];
    case "failed":
      return [{ type: "error", payload: { error: "fixture failure" } }];
    case "unknown":
      return [
        { type: "future-mastra-chunk", payload: {} },
        { type: "finish", payload: { stepResult: { reason: "stop" } } },
      ];
    default:
      return [
        { type: "text-start", payload: { id: "fixture-message" } },
        { type: "text-delta", payload: { id: "fixture-message", text: "one" } },
        { type: "text-delta", payload: { id: "fixture-message", text: "two" } },
        { type: "text-end", payload: { id: "fixture-message" } },
        { type: "finish", payload: { stepResult: { reason: "stop" } } },
      ];
  }
}

function fetchFor(scenario: ProviderContractScenario): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    if (request.method === "GET" && request.url.includes("/.well-known/")) {
      return Response.json({
        name: "Fixture agent",
        protocolVersion: "0.3.0",
        capabilities: {},
        skills: [],
      });
    }
    if (request.method === "GET" && request.url.endsWith("/api/agents/agent")) {
      return Response.json({ name: "Fixture agent", modelId: "fixture-model" });
    }
    if (request.url.endsWith("/api/agents/agent/threads/abort")) {
      return Response.json({ aborted: true });
    }
    if (request.url.endsWith("/api/agents/agent/stream")) {
      if (scenario === "interrupt") {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              request.signal.addEventListener("abort", () => controller.close(), {
                once: true,
              });
            },
          }),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        );
      }
      return streamResponse(scenarioChunks(scenario));
    }
    throw new Error(`Unexpected Mastra fixture request: ${request.method} ${request.url}`);
  };
}

function fixture(scenario: ProviderContractScenario): ProviderAdapterV1 {
  const provider = createMastraProvider({
    baseUrl: "https://fixture.mastra.local",
    agentId: "agent",
    fetch: fetchFor(scenario),
  });
  if (scenario !== "crash") return provider;
  return {
    ...provider,
    async openSession() {
      return {
        startTurn() {
          return {
            [Symbol.asyncIterator]() {
              return {
                next: () => Promise.reject(new Error("Injected Mastra provider crash")),
              };
            },
          };
        },
        async close() {},
      };
    },
  };
}

providerContract("Mastra", fixture);
