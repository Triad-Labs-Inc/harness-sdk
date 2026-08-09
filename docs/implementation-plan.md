# Implementation plan

This plan builds Harness SDK in verifiable vertical slices. A vertical slice is a small path that works from the public API through the provider or fake, storage, and events. It avoids building several disconnected layers before anything can run.

## Milestone 0: validate the provider boundaries

Create two disposable programs:

```text
experiments/codex-app-server-probe.ts
experiments/claude-agent-sdk-probe.ts
```

The Codex probe must demonstrate:

- process startup over standard input and output;
- `initialize` and `initialized`;
- provider status through `account/read`;
- thread creation and resumption;
- turn start, streamed text, steering, and interruption;
- one approval or user-input round trip;
- clean process shutdown.

The Claude probe must demonstrate:

- `query()` and asynchronous message streaming;
- capture and reuse of a session ID;
- tool permission handling through `canUseTool`;
- `AskUserQuestion` handling;
- cancellation and clean shutdown;
- the intended authentication mode for a distributed third-party application.

These probes may contain direct protocol code and console output. Production packages must not depend on them.

### Completion check

Record observed message fixtures with secrets removed. Document any difference between the upstream behavior and this specification before building adapters.

## Milestone 1: scaffold and build the fake vertical slice

Create the workspace, TypeScript configuration, linting, formatting, tests, package builds, and the package directories described in the architecture.

Implement in core:

- branded IDs and public types;
- typed error hierarchy;
- `Harness`, session, and turn interfaces;
- provider status and capabilities;
- the normalized event union;
- a replaceable storage contract;
- an in-memory store;
- session turn queueing;
- subscription and replay;
- permission and input response APIs;
- idempotent close.

Implement in testkit:

- a deterministic fake provider;
- controls for streaming, permissions, questions, crashes, and delays;
- the first shared provider contract tests.

### Completion check

The fake provider can accept a turn, stream normalized events, persist before delivery, resolve `turn.done()`, queue a second turn, replay history, ask for permission, ask a question, interrupt, and close. All behavior runs without Codex, Claude, network access, or credentials.

## Milestone 2: implement SQLite and recovery

Implement:

- migrations and WAL configuration;
- sessions, turns, events, messages, interaction requests, and provider metadata;
- atomic event append and projection updates;
- paginated history;
- snapshot sequence boundaries;
- gap-free replay-to-live subscriptions;
- raw event persistence modes and redaction;
- startup recovery and explicit queue resumption.

Run the storage contract tests against both memory and SQLite stores.

### Completion check

Closing and reopening the SDK preserves sessions and history. A simulated host crash produces `HOST_RESTARTED`, expires unresolved interactions, and does not silently execute queued work. A concurrent event during subscription startup is delivered exactly once.

## Milestone 3: implement Codex

Build:

- a supervised app-server child process;
- a framed newline JSON reader and serialized writer;
- JSON-RPC request correlation and timeouts;
- startup handshake and status detection;
- thread start and resume;
- turn start, steer, and interrupt;
- event, approval, and question normalization;
- generated protocol schemas or fixtures plus tolerant runtime validation;
- graceful and forced process-tree shutdown.

Add fixture-driven unit tests and opt-in integration tests against an installed, authenticated Codex.

### Completion check

The TUI example can create and resume a Codex session, stream text, handle an interaction, interrupt a turn, survive idle suspension, and reload history from SQLite.

## Milestone 4: implement Claude

Build:

- Agent SDK query lifecycle management;
- streamed message normalization;
- session ID capture and resumption;
- permission and `AskUserQuestion` translation;
- cancellation and shutdown;
- explicit configuration-source behavior;
- documented authentication requirements.

Run the same provider contract suite used for Codex. Add opt-in integration tests that require Claude credentials separately from the default test suite.

### Completion check

The same TUI code can switch its provider registration from Codex to Claude without changing session, event, permission, question, history, or turn-result handling.

## Milestone 5: harden runtime behavior

Implement and test:

- ten-minute configurable idle suspension;
- 25-millisecond text-delta coalescing;
- bounded subscriber buffers and `SlowConsumerError`;
- rotating redacted operational logs;
- executable path and asynchronous environment resolution;
- process crashes at each turn stage;
- multiple concurrent sessions;
- graceful application shutdown during active and queued work;
- provider unknown-message tolerance;
- event and database schema versioning.

### Completion check

Stress tests can run concurrent fake sessions without losing, duplicating, or reordering events. Fault-injection tests cover provider exit, malformed messages, storage failure, slow subscribers, and host restart.

## Milestone 6: ship reference integrations

Finish the TUI example with provider status, session selection, streaming output, permissions, questions, interruption, and history.

Build a minimal Electron example in which:

- Harness runs only in the main process;
- `homeDir` is under `app.getPath("userData")`;
- preload exposes a narrow typed API;
- renderer events are serializable and replayable;
- the renderer cannot access arbitrary process spawning, secrets, or SQLite.

Write package READMEs, API reference material, migration guidance, and a provider-adapter authoring guide.

### Completion check

Both examples pass packaged smoke tests. The package tarballs contain built code, declarations, licenses, and documentation, and can be installed into clean fixture projects.

## Release gate

Do not call the SDK production-ready until:

- memory and SQLite storage contract tests pass;
- Codex and Claude pass shared provider contract tests;
- supported operating systems pass CI and packaged smoke tests;
- crash and restart behavior is deterministic;
- secrets are absent from database and log fixtures;
- public exports have API review and declaration tests;
- upstream license and Claude distribution/authentication constraints are documented;
- the examples use only public package exports.
