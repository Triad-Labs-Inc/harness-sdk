import type {
  OpenSessionContext,
  ProviderEvent,
  ProviderTurnRequest,
  SessionId,
  TurnId,
} from "@triadlabs/harness-sdk";
import { describe, expect, it, vi } from "vitest";

import {
  createMastraProvider,
  createMastraProjectionState,
  projectMastraChunk,
} from "./adapter.js";

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

function openSessionContext(metadata: Map<string, unknown>): OpenSessionContext {
  return {
    homeDir: "/tmp/harness-test",
    sessionId: "session-1" as SessionId,
    cwd: "/tmp/harness-test/workspace",
    registerSecrets: () => undefined,
    getMetadata: async (key) => metadata.get(key),
    setMetadata: async (key, value) => {
      metadata.set(key, value);
    },
  };
}

function turn(text: string): ProviderTurnRequest {
  return {
    sessionId: "session-1" as SessionId,
    turnId: `turn-${text}` as TurnId,
    text,
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function collectEvents(events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const collected: ProviderEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

function pendingStream(signal: AbortSignal, onStart?: () => void): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      signal.addEventListener("abort", () => controller.close(), {
        once: true,
      });
      onStart?.();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("Mastra event projection", () => {
  it("projects stable fields without persisting raw response metadata", () => {
    const state = createMastraProjectionState();
    const chunks = [
      { type: "text-start", payload: { id: "message-1" } },
      {
        type: "text-delta",
        payload: { id: "message-1", text: "cloud works" },
      },
      { type: "text-end", payload: { id: "message-1" } },
      {
        type: "finish",
        payload: {
          stepResult: { reason: "stop" },
          response: {
            headers: { "set-cookie": "must-not-persist" },
          },
        },
      },
      { type: "abort", payload: {} },
    ];

    const events = chunks.flatMap((chunk) => [...projectMastraChunk(chunk, state)]);

    expect(events).toEqual([
      { type: "message.started", messageId: "message-1", role: "assistant" },
      { type: "message.delta", messageId: "message-1", delta: "cloud works" },
      { type: "message.completed", messageId: "message-1" },
    ]);
    expect(state.terminal).toEqual({ type: "turn.completed" });
    expect(JSON.stringify({ events, terminal: state.terminal })).not.toContain("must-not-persist");
  });

  it("uses the first terminal event and surfaces unsupported suspensions", () => {
    const aborted = createMastraProjectionState();
    projectMastraChunk({ type: "abort", payload: {} }, aborted);
    projectMastraChunk(
      { type: "finish", payload: { stepResult: { reason: "tripwire" } } },
      aborted,
    );
    expect(aborted.terminal?.type).toBe("turn.interrupted");

    const suspended = createMastraProjectionState();
    projectMastraChunk(
      {
        type: "tool-call-approval",
        payload: { runId: "run-1", toolCallId: "tool-1" },
      },
      suspended,
    );
    expect(suspended.terminal).toMatchObject({
      type: "turn.failed",
      code: "MASTRA_INTERACTION_UNSUPPORTED",
    });
  });

  it("keeps processor-requested retries non-terminal", () => {
    const state = createMastraProjectionState();
    expect(projectMastraChunk({ type: "tripwire", payload: { retry: true } }, state)).toEqual([
      expect.objectContaining({
        type: "diagnostic",
        code: "MASTRA_RETRY",
      }),
    ]);
    projectMastraChunk({ type: "finish", payload: { stepResult: { reason: "retry" } } }, state);
    expect(state.terminal).toBeUndefined();
    projectMastraChunk({ type: "finish", payload: { stepResult: { reason: "stop" } } }, state);
    expect(state.terminal).toEqual({ type: "turn.completed" });
  });

  it("maps nested finish errors and never serializes remote metadata", () => {
    const failed = createMastraProjectionState();
    projectMastraChunk({ type: "finish", payload: { stepResult: { reason: "error" } } }, failed);
    expect(failed.terminal).toMatchObject({
      type: "turn.failed",
      code: "MASTRA_CLOUD_ERROR",
    });

    const remoteError = createMastraProjectionState();
    projectMastraChunk(
      {
        type: "error",
        payload: {
          error: {
            code: "UPSTREAM_FAILED",
            message: "The upstream model failed",
            headers: { "set-cookie": "secret-cookie" },
            stack: "private stack",
          },
        },
      },
      remoteError,
    );
    expect(remoteError.terminal).toEqual({
      type: "turn.failed",
      code: "MASTRA_CLOUD_ERROR",
      message: "[UPSTREAM_FAILED] The upstream model failed",
      mayHaveSideEffects: true,
    });
    expect(JSON.stringify(remoteError.terminal)).not.toContain("secret-cookie");
    expect(JSON.stringify(remoteError.terminal)).not.toContain("private stack");
  });

  it("preserves streamed tool identity and final input", () => {
    const state = createMastraProjectionState();
    const chunks = [
      {
        type: "tool-call-input-streaming-start",
        payload: { toolCallId: "tool-1", toolName: "weather" },
      },
      {
        type: "tool-call-delta",
        payload: { toolCallId: "tool-1", argsTextDelta: '{"city"' },
      },
      {
        type: "tool-call-delta",
        payload: { toolCallId: "tool-1", argsTextDelta: ':"Paris"}' },
      },
      {
        type: "tool-call",
        payload: {
          toolCallId: "tool-1",
          toolName: "weather",
          args: { city: "Paris" },
        },
      },
      {
        type: "tool-output",
        payload: {
          toolCallId: "tool-1",
          toolName: "weather",
          output: { temperature: 21 },
        },
      },
    ];

    expect(chunks.flatMap((chunk) => projectMastraChunk(chunk, state))).toEqual([
      { type: "tool.started", toolId: "tool-1", name: "weather" },
      {
        type: "tool.updated",
        toolId: "tool-1",
        update: { argsTextDelta: '{"city"' },
      },
      {
        type: "tool.updated",
        toolId: "tool-1",
        update: { argsTextDelta: ':"Paris"}' },
      },
      {
        type: "tool.updated",
        toolId: "tool-1",
        update: { input: { city: "Paris" } },
      },
      {
        type: "tool.completed",
        toolId: "tool-1",
        output: { temperature: 21 },
        isError: false,
      },
    ]);
  });
});

describe("Mastra provider runtime", () => {
  it("rejects bearer credentials over non-loopback HTTP", () => {
    expect(() =>
      createMastraProvider({
        baseUrl: "http://agents.example.com",
        agentId: "agent",
        authToken: "secret",
      }),
    ).toThrow("requires HTTPS");

    expect(() =>
      createMastraProvider({
        baseUrl: "http://127.0.0.1:4111",
        agentId: "agent",
        authToken: "local-secret",
      }),
    ).not.toThrow();
    expect(() =>
      createMastraProvider({
        id: "   ",
        baseUrl: "https://example.mastra.cloud",
        agentId: "agent",
      }),
    ).toThrow("id must not be empty");
  });

  it("does not surface Mastra HTTP response bodies in provider status", async () => {
    const provider = createMastraProvider({
      baseUrl: "https://example.mastra.cloud",
      agentId: "agent",
      fetch: async () =>
        Response.json(
          {
            error: "upstream failed",
            headers: { "set-cookie": "secret-cookie" },
          },
          { status: 500, statusText: "Internal Server Error" },
        ),
    });
    const status = await provider.status({
      homeDir: "/tmp/harness-test",
      registerSecrets: () => undefined,
    });
    expect(status).toEqual({
      state: "unavailable",
      message: "Cannot reach Mastra agent agent: Mastra returned HTTP 500 Internal Server Error",
    });
    expect(JSON.stringify(status)).not.toContain("secret-cookie");
    expect(JSON.stringify(status)).not.toContain("upstream failed");
  });

  it("does not write remote stream errors to the application console", async () => {
    const secret = "mastra-stream-secret";
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const provider = createMastraProvider({
      baseUrl: "https://example.mastra.cloud",
      agentId: "agent",
      authToken: secret,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        expect(request.headers.get("authorization")).toBe(`Bearer ${secret}`);
        return streamResponse([
          {
            type: "error",
            payload: { error: `remote failure included ${secret}` },
          },
        ]);
      },
    });

    try {
      const runtime = await provider.openSession(openSessionContext(new Map()));
      await expect(collectEvents(runtime.startTurn(turn("remote failure")))).resolves.toEqual([
        {
          type: "turn.failed",
          code: "MASTRA_CLOUD_ERROR",
          message: `remote failure included ${secret}`,
          mayHaveSideEffects: true,
        },
      ]);
      expect(consoleError).not.toHaveBeenCalled();
      await runtime.close();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("bounds provider readiness responses", async () => {
    const provider = createMastraProvider({
      baseUrl: "https://example.mastra.cloud",
      agentId: "agent",
      maxControlResponseBytes: 128,
      fetch: async () =>
        new Response(encoder.encode("x".repeat(1_024)), {
          status: 200,
          headers: {
            "content-length": "1024",
            "content-type": "application/json",
          },
        }),
    });
    const status = await provider.status({
      homeDir: "/tmp/harness-test",
      registerSecrets: () => undefined,
    });

    expect(status).toMatchObject({
      state: "unavailable",
      message: expect.stringContaining("128-byte stream limit"),
    });
  });

  it("aborts sibling readiness requests when one check fails", async () => {
    const cardAborted = deferred<void>();
    const provider = createMastraProvider({
      baseUrl: "https://example.mastra.cloud",
      agentId: "agent",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        if (request.url.includes("/.well-known/")) {
          return await new Promise<Response>((_resolve, reject) => {
            request.signal.addEventListener(
              "abort",
              () => {
                cardAborted.resolve(undefined);
                reject(new DOMException("readiness canceled", "AbortError"));
              },
              { once: true },
            );
          });
        }
        return Response.json(
          { error: "details failed" },
          { status: 500, statusText: "Internal Server Error" },
        );
      },
    });

    const status = await provider.status({
      homeDir: "/tmp/harness-test",
      registerSecrets: () => undefined,
    });
    expect(status.state).toBe("unavailable");
    await cardAborted.promise;
  });

  it("reuses durable memory identity across streamed turns", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    let turnCount = 0;
    const mockFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const bodyText = request.method === "GET" ? undefined : await request.clone().text();
      requests.push({
        url: request.url,
        method: request.method,
        ...(bodyText ? { body: JSON.parse(bodyText) } : {}),
      });

      if (request.url.endsWith("/api/agents/agent/stream")) {
        turnCount += 1;
        return streamResponse([
          { type: "text-start", payload: { id: `message-${turnCount}` } },
          {
            type: "text-delta",
            payload: { id: `message-${turnCount}`, text: `reply-${turnCount}` },
          },
          { type: "text-end", payload: { id: `message-${turnCount}` } },
          { type: "finish", payload: { stepResult: { reason: "stop" } } },
        ]);
      }
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    };

    const metadata = new Map<string, unknown>();
    const provider = createMastraProvider({
      baseUrl: "https://example.mastra.cloud/",
      agentId: "agent",
      fetch: mockFetch,
    });
    const runtime = await provider.openSession(openSessionContext(metadata));
    const received: ProviderEvent[][] = [];

    for (const text of ["one", "two"]) {
      const events: ProviderEvent[] = [];
      for await (const event of runtime.startTurn(turn(text))) events.push(event);
      received.push(events);
    }

    expect(received.map((events) => events.map((event) => event.type))).toEqual([
      ["message.started", "message.delta", "message.completed", "turn.completed"],
      ["message.started", "message.delta", "message.completed", "turn.completed"],
    ]);

    const streamBodies = requests
      .filter((request) => request.url.endsWith("/stream"))
      .map((request) => request.body as Record<string, unknown>);
    expect(streamBodies).toHaveLength(2);
    const memories = streamBodies.map((body) => body.memory);
    expect(memories[0]).toEqual(memories[1]);
    expect(memories[0]).toMatchObject({ thread: "session-1" });
    expect(streamBodies.map((body) => body.runId)).toEqual(["turn-one", "turn-two"]);
    expect(metadata.get("mastra.thread-id")).toBe("session-1");
    expect(metadata.get("mastra.resource-id")).toBeTypeOf("string");
    expect(metadata.get("mastra.active-turn")).toBeNull();
    expect(
      requests.every((request) => request.url.startsWith("https://example.mastra.cloud/api/")),
    ).toBe(true);

    await runtime.close();
  });

  it("supports distinct Harness IDs and namespaces their durable metadata", async () => {
    const metadata = new Map<string, unknown>();
    const provider = createMastraProvider({
      id: "studio-director",
      baseUrl: "https://example.mastra.cloud",
      agentId: "agent",
      fetch: async () => {
        throw new Error("network should not be used while opening a session");
      },
    });

    expect(provider.id).toBe("studio-director");
    const runtime = await provider.openSession(openSessionContext(metadata));
    expect(metadata.get("mastra.studio-director.thread-id")).toBe("session-1");
    expect(metadata.get("mastra.studio-director.connection-fingerprint")).toBeTypeOf("string");
    await runtime.close();
  });

  it("rejects reopening a session against a different server or agent", async () => {
    const metadata = new Map<string, unknown>();
    const first = createMastraProvider({
      baseUrl: "https://first.example.com",
      agentId: "agent-a",
    });
    await (await first.openSession(openSessionContext(metadata))).close();

    const changed = createMastraProvider({
      baseUrl: "https://second.example.com",
      agentId: "agent-b",
    });
    await expect(changed.openSession(openSessionContext(metadata))).rejects.toThrow(
      "bound to a different Mastra server or agent",
    );
  });

  it("rejects changing a configured resource ID on an existing session", async () => {
    const metadata = new Map<string, unknown>();
    const first = createMastraProvider({
      baseUrl: "https://example.mastra.cloud",
      agentId: "agent",
      resourceId: "resource-a",
    });
    await (await first.openSession(openSessionContext(metadata))).close();

    const changed = createMastraProvider({
      baseUrl: "https://example.mastra.cloud",
      agentId: "agent",
      resourceId: "resource-b",
    });
    await expect(changed.openSession(openSessionContext(metadata))).rejects.toThrow(
      "bound to a different Mastra resource ID",
    );
  });

  it("fails closed when a persisted active marker survives a host crash", async () => {
    const metadata = new Map<string, unknown>([["mastra.active-turn", "turn-from-crashed-host"]]);
    const provider = createMastraProvider({
      baseUrl: "https://example.mastra.cloud",
      agentId: "agent",
    });
    const runtime = await provider.openSession(openSessionContext(metadata));

    await expect(collectEvents(runtime.startTurn(turn("must not overlap")))).rejects.toThrow(
      "was active when the host stopped",
    );
    expect(metadata.get("mastra.unsafe-thread")).toContain("turn-from-crashed-host");
    await runtime.close();
  });

  it("cancels the remote thread and the local stream", async () => {
    let streamStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      streamStarted = resolve;
    });
    const requests: Array<{ url: string; body?: unknown }> = [];
    const mockFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const bodyText = await request.clone().text();
      requests.push({
        url: request.url,
        ...(bodyText ? { body: JSON.parse(bodyText) } : {}),
      });

      if (request.url.endsWith("/api/agents/agent/stream")) {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            request.signal.addEventListener("abort", () => controller.close(), {
              once: true,
            });
            streamStarted();
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (request.url.endsWith("/api/agents/agent/threads/abort")) {
        return Response.json({ aborted: true });
      }
      throw new Error(`Unexpected request: ${request.url}`);
    };

    const provider = createMastraProvider({
      baseUrl: "https://example.mastra.cloud",
      agentId: "agent",
      resourceId: "resource-1",
      fetch: mockFetch,
    });
    const runtime = await provider.openSession(openSessionContext(new Map()));
    const eventsPromise = (async () => {
      const events: ProviderEvent[] = [];
      for await (const event of runtime.startTurn(turn("interrupt me"))) {
        events.push(event);
      }
      return events;
    })();

    await started;
    await runtime.interrupt?.();
    const events = await eventsPromise;

    expect(events.at(-1)).toEqual({
      type: "turn.interrupted",
      reason: "Interrupted by the user",
    });
    const abortRequest = requests.find((request) => request.url.endsWith("/threads/abort"));
    expect(abortRequest?.body).toMatchObject({
      threadId: "session-1",
      resourceId: "resource-1",
    });

    await runtime.close();
  });

  it("keeps the active-turn barrier until remote cancellation settles", async () => {
    const streamStarted = deferred<void>();
    const abortRequested = deferred<void>();
    const abortResponse = deferred<Response>();
    let streamRequests = 0;
    const mockFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.url.endsWith("/api/agents/agent/stream")) {
        streamRequests += 1;
        if (streamRequests === 1) {
          return pendingStream(request.signal, () => streamStarted.resolve(undefined));
        }
        return streamResponse([{ type: "finish", payload: { stepResult: { reason: "stop" } } }]);
      }
      if (request.url.endsWith("/api/agents/agent/threads/abort")) {
        abortRequested.resolve(undefined);
        return await abortResponse.promise;
      }
      throw new Error(`Unexpected request: ${request.url}`);
    };
    const provider = createMastraProvider({
      baseUrl: "https://example.mastra.cloud",
      agentId: "agent",
      fetch: mockFetch,
    });
    const runtime = await provider.openSession(openSessionContext(new Map()));
    let firstSettled = false;
    const firstEvents = collectEvents(runtime.startTurn(turn("first"))).finally(() => {
      firstSettled = true;
    });

    await streamStarted.promise;
    const interrupt = runtime.interrupt?.();
    await abortRequested.promise;
    await Promise.resolve();
    expect(firstSettled).toBe(false);
    expect(streamRequests).toBe(1);

    abortResponse.resolve(Response.json({ aborted: true }));
    await interrupt;
    expect((await firstEvents).at(-1)?.type).toBe("turn.interrupted");
    const secondEvents = await collectEvents(runtime.startTurn(turn("second after cancellation")));
    expect(secondEvents.at(-1)?.type).toBe("turn.completed");
    expect(streamRequests).toBe(2);

    await runtime.close();
  });

  it("aborts remotely when the event consumer abandons an active turn", async () => {
    const abortRequested = deferred<void>();
    const mockFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.url.endsWith("/api/agents/agent/stream")) {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode('data: {"type":"text-start","payload":{"id":"message-1"}}\n\n'),
            );
            request.signal.addEventListener("abort", () => controller.close(), {
              once: true,
            });
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (request.url.endsWith("/api/agents/agent/threads/abort")) {
        abortRequested.resolve(undefined);
        return Response.json({ aborted: true });
      }
      throw new Error(`Unexpected request: ${request.url}`);
    };
    const provider = createMastraProvider({
      baseUrl: "https://example.mastra.cloud",
      agentId: "agent",
      fetch: mockFetch,
    });
    const runtime = await provider.openSession(openSessionContext(new Map()));
    const iterator = runtime.startTurn(turn("abandon me"))[Symbol.asyncIterator]();

    expect((await iterator.next()).value?.type).toBe("message.started");
    await iterator.return?.();
    await abortRequested.promise;
    await runtime.close();
  });

  it("aborts unsupported remote suspensions before completing locally", async () => {
    const requests: string[] = [];
    const mockFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      requests.push(request.url);
      if (request.url.endsWith("/api/agents/agent/stream")) {
        return streamResponse([
          {
            type: "tool-call-approval",
            payload: {
              runId: "run-1",
              toolCallId: "tool-1",
              toolName: "write",
            },
          },
        ]);
      }
      if (request.url.endsWith("/api/agents/agent/threads/abort")) {
        return Response.json({ aborted: true });
      }
      throw new Error(`Unexpected request: ${request.url}`);
    };
    const provider = createMastraProvider({
      baseUrl: "https://example.mastra.cloud",
      agentId: "agent",
      fetch: mockFetch,
    });
    const runtime = await provider.openSession(openSessionContext(new Map()));
    const events = await collectEvents(runtime.startTurn(turn("requires approval")));

    expect(events.at(-1)).toMatchObject({
      type: "turn.failed",
      code: "MASTRA_INTERACTION_UNSUPPORTED",
    });
    expect(requests.some((url) => url.endsWith("/threads/abort"))).toBe(true);
    await runtime.close();
  });

  it("fails a turn whose provider chunk exceeds the configured byte limit", async () => {
    let abortRequests = 0;
    const provider = createMastraProvider({
      baseUrl: "https://example.mastra.cloud",
      agentId: "agent",
      maxChunkBytes: 256,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        if (request.url.endsWith("/api/agents/agent/stream")) {
          return streamResponse([
            { type: "text-start", payload: { id: "message-1" } },
            {
              type: "text-delta",
              payload: { id: "message-1", text: "x".repeat(512) },
            },
          ]);
        }
        if (request.url.endsWith("/api/agents/agent/threads/abort")) {
          abortRequests += 1;
          return Response.json({ aborted: true });
        }
        throw new Error(`Unexpected request: ${request.url}`);
      },
    });
    const runtime = await provider.openSession(openSessionContext(new Map()));
    const events = await collectEvents(runtime.startTurn(turn("large chunk")));

    expect(events.some((event) => event.type === "message.delta")).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "turn.failed",
      code: "MASTRA_CLOUD_REQUEST_FAILED",
    });
    expect(abortRequests).toBe(1);
    await runtime.close();
  });

  it("reconciles a streamed response overflow without Content-Length", async () => {
    let abortRequests = 0;
    const provider = createMastraProvider({
      baseUrl: "https://example.mastra.cloud",
      agentId: "agent",
      maxStreamBytes: 128,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        if (request.url.endsWith("/api/agents/agent/stream")) {
          return new Response(encoder.encode("x".repeat(1_024)), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }
        if (request.url.endsWith("/api/agents/agent/threads/abort")) {
          abortRequests += 1;
          return Response.json({ aborted: true });
        }
        throw new Error(`Unexpected request: ${request.url}`);
      },
    });
    const runtime = await provider.openSession(openSessionContext(new Map()));
    const events = await collectEvents(runtime.startTurn(turn("large response")));

    expect(events.at(-1)).toMatchObject({ type: "turn.failed" });
    expect(abortRequests).toBe(1);
    await runtime.close();
  });

  it.each([
    {
      name: "an aborted:false response",
      interruptTimeoutMs: 100,
      abort: async (_request: Request) => Response.json({ aborted: false }),
      expected: "did not confirm remote cancellation",
    },
    {
      name: "a rejected abort request",
      interruptTimeoutMs: 100,
      abort: async (_request: Request) => {
        throw new Error("abort endpoint unavailable");
      },
      expected: "cancellation could not be confirmed",
    },
    {
      name: "an abort request timeout",
      interruptTimeoutMs: 10,
      abort: async (request: Request) =>
        await new Promise<Response>((_resolve, reject) => {
          if (request.signal.aborted) {
            reject(new DOMException("request timed out", "AbortError"));
            return;
          }
          request.signal.addEventListener(
            "abort",
            () => reject(new DOMException("request timed out", "AbortError")),
            { once: true },
          );
        }),
      expected: "cancellation could not be confirmed",
    },
    {
      name: "an oversized abort response",
      interruptTimeoutMs: 100,
      maxControlResponseBytes: 128,
      abort: async (_request: Request) =>
        new Response(encoder.encode("x".repeat(1_024)), {
          status: 200,
          headers: {
            "content-length": "1024",
            "content-type": "application/json",
          },
        }),
      expected: "cancellation could not be confirmed",
    },
  ])(
    "fails closed after $name",
    async ({ interruptTimeoutMs, maxControlResponseBytes, abort, expected }) => {
      const streamStarted = deferred<void>();
      const metadata = new Map<string, unknown>();
      const mockFetch: typeof fetch = async (input, init) => {
        const request = new Request(input, init);
        if (request.url.endsWith("/api/agents/agent/stream")) {
          return pendingStream(request.signal, () => streamStarted.resolve(undefined));
        }
        if (request.url.endsWith("/api/agents/agent/threads/abort")) {
          return await abort(request);
        }
        throw new Error(`Unexpected request: ${request.url}`);
      };
      const provider = createMastraProvider({
        baseUrl: "https://example.mastra.cloud",
        agentId: "agent",
        interruptTimeoutMs,
        ...(maxControlResponseBytes ? { maxControlResponseBytes } : {}),
        fetch: mockFetch,
      });
      const runtime = await provider.openSession(openSessionContext(metadata));
      const turnResult = collectEvents(runtime.startTurn(turn("uncertain cancellation"))).then(
        () => undefined,
        (error: unknown) => error,
      );

      await streamStarted.promise;
      await expect(runtime.interrupt?.()).rejects.toThrow(expected);
      expect(await turnResult).toMatchObject({
        message: expect.stringContaining(expected),
      });
      await expect(collectEvents(runtime.startTurn(turn("must not overlap")))).rejects.toThrow(
        expected,
      );

      await expect(runtime.close()).resolves.toBeUndefined();
      const reopened = await provider.openSession(openSessionContext(metadata));
      await expect(
        collectEvents(reopened.startTurn(turn("must not overlap after reopen"))),
      ).rejects.toThrow(expected);
      await reopened.close();
    },
  );
});
