# Product specification

This document defines how application developers use Harness SDK and what behavior they can rely on. It is written for engineers implementing the SDK and engineers embedding it in a TUI or Electron application.

## Problem

Every coding agent exposes a different local interface. Codex has an app-server protocol, Claude has an Agent SDK, and other agents have their own process and event models. An application developer should not need to rebuild process management, event normalization, persistence, permissions, and recovery for every provider.

Harness SDK owns that integration layer. Applications work with Harness sessions, turns, events, permissions, and input requests. Provider adapters translate those operations to the native agent interface.

## Goals

The first production release must:

- run in Node.js applications, including TUIs and the Electron main process;
- support Codex through `codex app-server` and Claude through the TypeScript Claude Agent SDK;
- run multiple independent sessions concurrently;
- stream normalized, durable events;
- persist sessions, turns, and readable message history in SQLite;
- support permissions, agent questions, interruption, steering, resumption, and crash recovery;
- expose provider capabilities and typed errors when a feature is unavailable;
- let third parties implement adapters through a public, versioned adapter contract.

OpenCode, Goose, and Pi are planned providers after the first two adapters prove the contract.

## Non-goals for the first release

The first release does not:

- attach to arbitrary agent processes that the SDK did not start;
- manage Git worktrees or lock repositories;
- install agent CLIs or perform their login flows;
- provide a Tauri integration;
- expose a hosted server or mobile protocol;
- automatically discover third-party adapters;
- maintain a compatibility table for every provider release;
- automatically retry a turn after a provider crash;
- add generic product metadata, billing, or user-account concepts.

A desktop application may build its own mobile bridge, similar in purpose to T3 Connect, above the SDK. That bridge is outside the core package.

## Terminology

**Harness** is the top-level SDK instance. It owns storage, provider registrations, active runtimes, subscriptions, and shutdown.

**Provider** is a local coding-agent integration, such as Codex or Claude.

**Session** is one continuing conversation with one provider in one working directory. A coder and reviewer are separate sessions even when they use the same repository.

**Turn** is one accepted unit of work inside a session. Only one turn runs at a time in a session.

**Event** is an immutable fact emitted by the SDK. Events have durable sequence numbers and can be replayed.

**Projection** is a current-state database row derived from events, such as the latest state of a turn or the readable message list.

**Interaction request** is a provider request that needs an application or user response. Permissions and questions are separate interaction types.

## Top-level API

The following examples define the intended shape. Minor naming changes are allowed during `0.x`, but the behavior is required.

```ts
const harness = await createHarness({
  homeDir: "/path/to/application-data/harness",
  providers: {
    codex: codexProvider(),
    claude: claudeProvider(),
  },
  rawEvents: "none",
});
```

`homeDir` is required. The application chooses it so the same SDK works in both Electron and terminal programs.

The default layout is:

```text
homeDir/
  harness.sqlite3
  logs/
  workspace/
```

When a session includes `cwd`, the SDK resolves it once and keeps that working directory for the life of the session. When `cwd` is omitted, the SDK uses `homeDir/workspace`.

## Provider status

The SDK reports status; it does not install or authenticate providers.

```ts
type ProviderStatus =
  | { state: "ready"; version?: string }
  | { state: "not_installed"; message: string }
  | { state: "not_authenticated"; message: string }
  | { state: "unavailable"; message: string; cause?: unknown };
```

Applications decide how to display and recover from these states.

The SDK respects the provider's existing configuration by default. Provider-specific settings are overridden only when the application explicitly supplies them.

For Claude, existing configuration may include a Claude.ai subscription login held by the user-installed Claude Code runtime or API credentials supplied through the environment. Harness delegates authentication to Claude Code; it does not extract or store OAuth tokens, API keys, or subscription credentials. Applications and distributors remain responsible for complying with the authentication and redistribution terms that apply to their product.

## Sessions

```ts
const session = await harness.sessions.create({
  provider: "codex",
  cwd: "/path/to/project",
});
```

The SDK assigns a Harness session ID. Native provider IDs are stored as internal metadata and are never the application's primary identifier.

The provider and working directory are immutable after creation. Model, reasoning, and permission settings may be overridden per turn when the provider reports support for them.

Applications can list, load, archive, and delete sessions. Archiving hides a session without deleting its data. Deleting removes the Harness-owned records only; it does not delete logs or history owned by Codex, Claude, or another provider.

## Turns, queueing, steering, and interruption

`send()` accepts a new turn and returns without waiting for the agent to finish:

```ts
const turn = await session.send({
  text: "Implement the parser described in docs/parser.md.",
});

const result = await turn.done();
```

There is one active turn per session. Calling `send()` while a turn is active queues the new turn. It does not silently interrupt or alter the active turn.

`steer()` explicitly sends additional direction to the active turn when the provider supports steering:

```ts
await session.steer({
  text: "Keep the public API unchanged.",
});
```

`interrupt()` explicitly requests that the active turn stop:

```ts
await session.interrupt();
```

Unsupported operations throw a typed `UnsupportedCapabilityError` before the SDK accepts them.

An immediate validation, availability, or capability failure rejects the method with a typed error. Once a turn is accepted, later failures are represented by `TurnResult` and durable events:

```ts
type TurnResult =
  | { status: "completed" }
  | { status: "interrupted"; reason?: string }
  | {
      status: "failed";
      error: HarnessErrorData;
      mayHaveSideEffects: boolean;
    };
```

If a provider crashes during an accepted turn, the SDK does not replay the turn automatically. The failed result sets `mayHaveSideEffects: true` when the provider could have changed files or external state before the crash.

## Permissions

The default permission mode is supervised. A provider request becomes a normalized event with a Harness request ID:

```ts
type PermissionDecision =
  | { decision: "allow_once" }
  | { decision: "allow_session" }
  | { decision: "deny"; reason?: string }
  | { decision: "cancel_turn"; reason?: string };
```

The application answers through the session:

```ts
await session.respondToPermission(requestId, {
  decision: "allow_once",
});
```

Full-access mode must be explicitly enabled. The core SDK does not render a confirmation dialog because TUIs and Electron applications have different user interfaces.

## Agent questions

Questions are not permissions. They use a separate normalized structure:

```ts
interface InputRequest {
  id: string;
  title?: string;
  questions: Array<{
    id: string;
    prompt: string;
    options?: Array<{
      value: string;
      label: string;
      description?: string;
    }>;
    multiple?: boolean;
    allowFreeText?: boolean;
  }>;
}
```

The application responds with Harness question IDs. An adapter translates those IDs into the provider's native response format.

```ts
await session.respondToInput(requestId, {
  answers: {
    database: ["sqlite"],
  },
});
```

Pending permission and input requests count as active work and prevent idle suspension.

## Snapshots, subscriptions, and history

Applications need a consistent way to load existing state and then stream changes without losing an event between those two operations.

```ts
const snapshot = await session.snapshot();

const subscription = await session.subscribe(
  { afterSequence: snapshot.sequence },
  {
    onEvent: (event) => render(event),
    onError: (error) => reportSubscriptionError(error),
  },
);
```

The snapshot includes the durable sequence through which its projections are current. Subscribing after that sequence fills the gap and continues with live events.

History is paginated rather than loaded into memory at once:

```ts
const page = await session.history({
  afterSequence: 1_200,
  limit: 100,
});
```

`subscribe()` resolves after the replay-to-live boundary is installed and returns an idempotently closeable subscription. Every subscriber has a bounded buffer. If a subscriber cannot keep up, the SDK invokes `onError` with `SlowConsumerError` and closes the subscription. The error includes the last safely delivered sequence. The application reconnects after that sequence and receives replayed events before live delivery resumes.

## Capabilities

Providers advertise explicit capabilities:

```ts
interface ProviderCapabilities {
  steering: boolean;
  interruption: boolean;
  permissions: boolean;
  questions: boolean;
  sessionResume: boolean;
  modelOverride: boolean;
  reasoningOverride: boolean;
  rawEvents: boolean;
}
```

Applications use capabilities to decide which controls to display. The SDK also enforces them so an application cannot accidentally call an unsupported operation.

## Shutdown

`harness.close()` is graceful and idempotent. It stops accepting new work, resolves or fails outstanding operations, stops every SDK-owned process tree, flushes storage and logs, and releases database resources. Calling it more than once has no additional effect.
