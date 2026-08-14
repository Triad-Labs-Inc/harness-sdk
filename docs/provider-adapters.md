# Provider adapters

This document defines the boundary between Harness core and an agent provider. It also records how the Codex, Claude, and Mastra adapters map their native concepts into Harness concepts.

## Public adapter contract

The adapter interface is public and versioned. The first release exposes `ProviderAdapterV1`. Core accepts only adapter versions it understands and throws a typed error for unsupported versions.

The exact TypeScript declaration will be finalized during the core vertical slice, but it must cover these responsibilities:

```ts
interface ProviderAdapterV1 {
  readonly apiVersion: 1;
  readonly id: string;

  status(context: ProviderContext): Promise<ProviderStatus>;
  capabilities(context: ProviderContext): Promise<ProviderCapabilities>;
  openSession(context: OpenSessionContext): Promise<ProviderRuntime>;
}

interface ProviderRuntime {
  startTurn(request: ProviderTurnRequest): AsyncIterable<ProviderEvent>;
  steer?(request: ProviderSteerRequest): Promise<void>;
  interrupt?(): Promise<void>;
  respondToPermission?(response: ProviderPermissionResponse): Promise<void>;
  respondToInput?(response: ProviderInputResponse): Promise<void>;
  close(): Promise<void>;
}
```

The final interface may split input, output, and callbacks differently where native APIs require it. Its observable behavior must still follow this document and the product specification.

## Adapter rules

Every adapter must:

- report status without starting a session;
- report capabilities explicitly;
- use the Harness session ID only as correlation data and keep native IDs internal;
- preserve the session's fixed working directory;
- normalize known native events and tolerate unknown native events;
- never deliver an event directly to an application;
- never persist secrets in normalized or raw events;
- implement graceful close and tolerate repeated close calls;
- surface provider crashes without automatically replaying an accepted turn;
- pass the shared provider contract test suite.

Raw native data may be attached to a normalized live event. Persistence is controlled globally by `rawEvents`:

```ts
type RawEventPersistence = "none" | "errors" | "all";
```

The default is `none`. Unknown native messages should be logged in a redacted form and may produce a diagnostic normalized event, but they must not crash the runtime merely because the provider added a new notification.

## Codex adapter

The Codex adapter starts `codex app-server` over standard input and output. WebSocket transport is not part of the first release.

### Startup

The runtime performs this handshake before any other method:

```text
initialize
initialized
```

The adapter uses `account/read` for status and translates the result into `ready` or `not_authenticated`. Failure to find or execute the binary becomes `not_installed` or `unavailable` as appropriate.

### Session and turn mapping

```text
Harness session create   -> thread/start
Harness session resume   -> thread/resume
Harness send             -> turn/start
Harness steer            -> turn/steer
Harness interrupt        -> turn/interrupt
```

The adapter saves the Codex thread ID as provider metadata. It maps turn and item notifications into normalized turn, message, tool, permission, and diagnostic events. Text deltas such as `item/agentMessage/delta` enter the common 25-millisecond coalescing pipeline.

The `turn/start` response can precede the native `turn/started` notification. The adapter treats `turn/started` as the readiness boundary for steering; attempting `turn/steer` immediately after the response can fail with `no active turn to steer`. A new native thread also has no resumable rollout until its first turn materializes one, so the adapter uses persistent threads and does not attempt to resume a never-started native thread.

In Codex 0.147.0, the built-in `request_user_input` tool is unavailable in Default collaboration mode and is available in Plan mode. The adapter normalizes `item/tool/requestUserInput` whenever Codex emits it; Harness does not fabricate provider questions in modes where Codex declines to offer the native tool.

The observed 0.147.0 question schema has no explicit multi-select flag even though answers are arrays. The adapter therefore defaults Codex questions to `multiple: false` and tolerantly honors additive `multiple` or `multiSelect` fields if a newer protocol emits them. This provider limitation does not narrow the normalized input model used by Claude or third-party adapters.

Codex can generate TypeScript and JSON schemas for the installed app-server version:

```bash
codex app-server generate-ts --out ./schemas
codex app-server generate-json-schema --out ./schemas
```

Generated schemas are development inputs and test fixtures. Runtime code must still validate protocol boundaries and tolerate additive fields and unknown notification types.

See the [Codex app-server source](https://github.com/openai/codex/tree/main/codex-rs/app-server) for the upstream protocol implementation.

## Claude adapter

The Claude adapter uses `@anthropic-ai/claude-agent-sdk` directly. It does not shell out to an interactive Claude terminal interface and scrape terminal output.

### Session and turn mapping

The adapter starts a `query()` and consumes its asynchronous message stream. It stores the SDK session ID as provider metadata so a suspended Harness session can resume the Claude session.

The adapter deliberately passes `settingSources: ["user", "project", "local"]` so the documented default of respecting existing provider configuration does not depend on an omitted-option behavior that may change upstream. Applications can explicitly pass a narrower list or `[]` for isolation. Contract tests verify the selected sources.

### Permissions and questions

Claude's `canUseTool` callback maps to two Harness concepts:

- ordinary tool approval becomes a permission request;
- `AskUserQuestion` becomes an input request.

The native callback may stay pending while the application asks the user. The adapter keeps the native callback in memory and associates it with the durable Harness request ID. It converts a normalized Harness response back into Claude's expected result shape.

Claude identifies some answers by question text. Harness uses stable question IDs externally, so the adapter must retain an internal ID-to-native-question mapping for each request.

See the official [Claude Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview), [permissions documentation](https://code.claude.com/docs/en/agent-sdk/permissions), and [user-input documentation](https://code.claude.com/docs/en/agent-sdk/user-input).

## Mastra adapter

The Mastra adapter uses `@mastra/client-js` to execute turns through the native agent stream API. It stores thread and resource IDs as provider metadata, forwards the Harness turn ID as the Mastra run ID, and deliberately omits raw stream chunks because terminal envelopes can contain upstream response metadata.

The adapter confirms thread-wide remote abort before closing its local stream. It persists an active-turn marker before issuing a request and fails closed after an unconfirmed cancellation or host crash, preventing a subsequent turn from overlapping remote work whose execution state is unknown. The optional A2A card contributes status metadata only; execution is not translated to A2A.

Mastra manages its own remote tool policy. The version 1 adapter therefore advertises no Harness permissions or questions and treats remote approval or suspension chunks as unsupported terminal failures that must be remotely aborted.

### Authentication and distribution responsibility

The adapter delegates authentication to the Claude Code runtime. It supports an existing local Claude.ai subscription login as well as API credentials supplied through the process environment. The adapter does not read or copy Claude's stored credential; its status probe starts a no-prompt Agent SDK runtime, reads only the SDK initialization account metadata, and closes the runtime before any model request.

Anthropic's current Agent SDK documentation states that third-party developers generally may not offer Claude.ai login or subscription rate limits in their products without prior approval. Harness therefore documents local subscription support as a bring-your-own-runtime capability, not as a representation that every distributing application has Anthropic's approval. Applications and distributors must validate their own intended distribution model.

## Shared contract tests

The testkit runs the same observable tests against every adapter. Tests that require a real provider are opt-in and separate from deterministic fixture tests.

The contract suite covers:

- status reporting;
- session creation and resumption;
- ordered streaming events;
- completed, failed, and interrupted turns;
- permission requests and every decision;
- agent questions with single, multiple, and free-text answers;
- steering capability enforcement;
- provider crashes and `mayHaveSideEffects`;
- idempotent close;
- unknown native events;
- redaction of environment values and secrets.
