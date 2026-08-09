# Design decisions

This document records decisions already made during the initial design. Contributors should treat them as constraints unless a new decision replaces them with a written reason.

## Platform and packaging

- The implementation language is TypeScript on Node.js.
- The first supported application types are Node.js TUIs and Electron applications.
- Electron uses Harness in the main process. The renderer receives a narrow IPC bridge.
- Core, Codex, Claude, and test utilities are separate packages.
- Provider adapters use a public `ProviderAdapterV1` contract.
- Adapters are registered explicitly. There is no automatic plugin discovery.

## Sessions and turns

- A session belongs to exactly one provider and one fixed working directory.
- A coder and reviewer are separate sessions and may run concurrently.
- Each active session has an isolated provider runtime.
- There is one active turn per session.
- `send()` queues behind the active turn.
- `steer()` and `interrupt()` are explicit operations.
- The Harness session ID is the public primary identifier. Native IDs are internal metadata.
- Provider and working directory are immutable. Supported model, reasoning, and permission settings may be overridden per turn.

## Working directories

- The application always supplies `homeDir`.
- A supplied session `cwd` is used for the life of the session.
- Without `cwd`, the session uses `homeDir/workspace`.
- Worktree creation and repository locking are deferred.

## Providers and authentication

- The first adapters are Codex app-server and the TypeScript Claude Agent SDK.
- The SDK reports installation and authentication status but does not install or log in to a provider.
- The Claude adapter may reuse authentication already available to the user-installed Claude Code runtime, including a Claude.ai subscription login, or use explicitly supplied API credentials. It delegates credential access to Claude Code and never reads, copies, persists, or logs the credential itself.
- Applications and distributors are responsible for confirming that their use of Claude.ai login or subscription rate limits has any approval required by Anthropic's current terms and Agent SDK documentation. Harness reports the available local capability; it does not make a legal or account-entitlement determination.
- Existing provider configuration is respected by default.
- Provider overrides must be explicit.
- Exact executable paths and asynchronous environment resolvers are supported.
- Environment values are never persisted or logged.
- The SDK does not maintain manual compatibility tables for every provider version.
- Unsupported operations fail with typed capability errors.

## Events and storage

- SQLite is the production default; memory storage is available for tests.
- Storage is replaceable behind a core interface.
- Normalized events use a durable, store-wide Harness sequence.
- Events and their projections are committed before delivery.
- Snapshot plus subscription-after-sequence is the gap-free read pattern.
- History reads are paginated.
- Tiny text deltas may be coalesced for 25 milliseconds.
- Slow subscribers are disconnected and resume through sequence replay.
- Raw native event persistence defaults to `none`, with `errors` and `all` options.

## Permissions and input

- Supervised permissions are the default.
- Decisions are `allow_once`, `allow_session`, `deny`, and `cancel_turn`.
- Full access requires explicit configuration.
- Agent questions use a separate, rich input-request model.
- Applications render permissions and questions; the SDK does not provide UI.
- Pending interactions keep a session active and prevent idle suspension.

## Lifecycle and failures

- Provider runtimes start lazily.
- The default idle suspension threshold is ten minutes.
- The SDK owns and stops complete process trees that it starts.
- A provider crash fails the accepted turn and never causes an automatic replay.
- Accepted turn failures are returned through `TurnResult`; immediate API failures throw typed errors.
- Startup recovery fails formerly active turns with `HOST_RESTARTED`, expires pending interactions, and pauses queued turns.
- Queue resumption is explicit by default.
- `harness.close()` is graceful and idempotent.
- Archiving preserves data. Deleting removes Harness-owned data only.
- Session deletion is a transactional hard delete and closes active subscriptions; it does not append a `session.deleted` event.
- Operational logs rotate under `homeDir/logs`, are redacted, and do not write to the console by default.

## Deferred work

- OpenCode, Goose, and Pi adapters.
- Tauri integration.
- A hosted or mobile transport.
- T3 Connect extraction or an equivalent remote bridge.
- Git worktrees and repository locks.
- Attaching to arbitrary existing terminals.
- Automatic installation and authentication.
- Automatic adapter discovery.
- Product analytics, billing, accounts, or generic UI metadata.
