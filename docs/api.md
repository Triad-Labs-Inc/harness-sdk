# API reference

Harness SDK exposes four packages. Applications register adapters explicitly; core never imports an official provider package.

## `@triadlabs/harness`

### `createHarness(options)`

Creates and recovers a Harness instance.

- `homeDir` is required. The default database is `homeDir/harness.sqlite3`; operational logs are under `homeDir/logs`.
- `providers` maps each provider ID to a `ProviderAdapterV1` with the same `id`.
- `store` replaces SQLite, normally with `createMemoryStore()` in tests.
- `rawEvents` is `"none"` by default, or `"errors"` / `"all"`.
- `idleTimeoutMs` defaults to ten minutes.
- `textDeltaCoalesceMs` defaults to 25 milliseconds.
- `subscriberBufferSize` defaults to 1,000 events, with an additional byte bound.
- `resumeQueuesOnStartup` defaults to false. Prefer explicit `session.resumeQueue()`.

`harness.close()` interrupts active work, fails queued work with `HARNESS_CLOSED`, closes subscriptions and provider runtimes, flushes logs, and closes storage. Repeated calls are safe.

### Providers

`harness.providers[name].status()` returns `ready`, `not_installed`, `not_authenticated`, or `unavailable`. `capabilities()` reports each optional operation explicitly.

### Sessions

- `sessions.create({ provider, cwd? })`
- `sessions.load(id)`
- `sessions.list({ includeArchived? })`

A session's provider and working directory are immutable. `send()` durably accepts and queues a turn, returning a `Turn`. Only `await turn.done()` yields its terminal result.

`steer()` and `interrupt()` are explicit and fail when the provider does not advertise the capability or no turn is active.

`archive()` preserves records. `delete()` hard-deletes Harness-owned session records and closes its subscriptions.

### History, snapshots, and subscriptions

`snapshot()` returns a durable projection plus its store-wide sequence. To avoid gaps:

```ts
const snapshot = await session.snapshot();
const subscription = await session.subscribe(
  { afterSequence: snapshot.sequence },
  { onEvent, onError },
);
```

Events are committed before `onEvent`. A slow observer receives `SlowConsumerError.lastSequence`; reconnect with that sequence to replay safely. `history()` is paginated and ordered by durable sequence.

### Interactions

Permissions and questions are separate event types and response APIs:

- `permission.requested` → `respondToPermission(requestId, decision)`
- `input.requested` → `respondToInput(requestId, { answers })`

Permission decisions are `allow_once`, `allow_session`, `deny`, and `cancel_turn`.

### Stores and adapter contract

`HarnessStore`, `InMemoryStore`, `SQLiteStore`, `ProviderAdapterV1`, `ProviderRuntime`, and the normalized provider/event types are public exports. Adapter API version 1 is structural and checked at registration.

## `@triadlabs/harness-codex`

`createCodexProvider(options?)` starts one supervised `codex app-server` stdio process per active session runtime.

- `executable`: exact string or async resolver; defaults to `codex`.
- `environment`: async environment override resolver.
- `appServerArgs`: defaults to `["app-server"]`; useful for an approved wrapper or deterministic fixture.
- `requestTimeoutMs`, `approvalPolicy`, and `sandbox` are explicit overrides.

The adapter persists only the native thread ID as opaque provider metadata.

## `@triadlabs/harness-claude`

`createClaudeProvider(options?)` uses `@anthropic-ai/claude-agent-sdk.query()`.

- `executable`: optional exact Claude Code executable path or async resolver.
- `environment`: async environment override resolver.
- `settingSources`: defaults explicitly to `["user", "project", "local"]`; pass `[]` for isolation.
- `statusTimeoutMs`: timeout for the no-prompt authentication probe; defaults to 25 seconds.

Provider status starts a non-persistent Agent SDK initialization, sends no user prompt, and accepts authentication delegated by Claude Code. This includes an existing local Claude.ai subscription login, API credentials, and supported external backends reported by the runtime. The adapter stores only the native SDK session ID for resume; credentials and environment values are not persisted. Claude does not advertise steering in version 1.

## `@triadlabs/harness-testkit`

Exports `FakeProviderController`, `fakeProvider()`, `storageContract()`, and `providerContract()`. The fake supports deterministic text, tools, permissions, questions, delays, diagnostics, failures, crashes, and interruption.
