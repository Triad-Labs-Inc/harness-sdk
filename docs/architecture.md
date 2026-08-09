# Architecture

This document explains how Harness SDK is divided and how data moves through it. It is intended for contributors implementing the core and provider adapters.

## Package boundaries

```text
packages/
  core/              Public API, orchestration, event model, storage contracts
  provider-codex/    Codex app-server process and protocol adapter
  provider-claude/   Claude Agent SDK adapter
  testkit/           Fake provider and provider contract tests
examples/
  tui/               Reference terminal application
  electron/          Reference Electron main-process integration
experiments/
  codex-app-server-probe.ts
  claude-agent-sdk-probe.ts
```

The core package must not import either official provider package. Provider packages depend on core contracts. This keeps the core usable by future OpenCode, Goose, Pi, and third-party adapters.

SQLite is the default store and may live in the core package for the first release. Storage remains behind an interface so tests can use memory and future applications can supply another implementation.

## Runtime ownership

Harness SDK owns only the processes it starts. It never searches for an arbitrary terminal process and attaches to it.

Each active Harness session has an isolated provider runtime. For Codex, that means one app-server child process associated with the session. For Claude, it means one SDK query/runtime associated with the session. Isolation prevents a crash, blocked permission, or cancellation in one session from corrupting another session.

Runtimes start lazily. Loading or listing a session does not start the provider. The runtime starts when an operation requires it, such as sending a turn or resuming an interaction.

After ten minutes without an active turn, queued work, pending interaction, or attached operation, the runtime is eligible for suspension. Suspension closes the runtime but keeps the Harness session and provider resume metadata in SQLite.

## Main components

```text
Application
    |
    v
Harness public API
    |
    +--> Session coordinator --> ProviderAdapterV1 --> Provider runtime
    |
    +--> Event pipeline -------> Event store -------> SQLite
    |                                  |
    |                                  +-----------> Projections
    |
    +--> Subscription manager <-------- durable replay + live events
    |
    +--> Process supervisor ----------> child process trees
```

### Harness public API

This is the only layer most application developers use. It exposes providers, sessions, turns, snapshots, history, interaction responses, and shutdown.

### Session coordinator

The coordinator enforces one active turn per session, queues later turns, routes steering and interruption, and manages idle suspension. It does not contain provider-specific protocol code.

### Provider adapter

An adapter translates between normalized Harness operations and the native provider interface. It also normalizes native events and reports capabilities and status.

### Event pipeline

The pipeline validates normalized events, coalesces tiny text deltas for up to 25 milliseconds, assigns a durable store-wide sequence, writes the event and projections in one transaction, and only then makes the event available to subscribers.

### Subscription manager

The manager replays persisted events after a requested sequence and then switches the subscriber to live delivery without a gap. It bounds each subscriber's memory usage and disconnects slow consumers.

### Process supervisor

The supervisor starts providers with explicit executables, working directories, and environments. It terminates the complete process tree during interruption, suspension, crashes, and Harness shutdown when the provider's normal shutdown path does not finish.

## Turn flow

```text
1. Application calls session.send().
2. Core validates the session, provider status, settings, and capabilities.
3. Core persists the accepted turn and turn.queued event.
4. session.send() returns a Turn handle.
5. The coordinator starts the turn immediately or leaves it queued.
6. The adapter sends the native provider request.
7. Native events are normalized, persisted, projected, and delivered.
8. A terminal event resolves turn.done().
9. The next queued turn may start.
```

Returning a `Turn` only means the SDK accepted and persisted the work. It does not mean the provider started or completed it.

## Permission and question flow

```text
Provider asks for a decision
    |
Adapter creates a normalized interaction request
    |
Core persists and delivers the request
    |
Application renders its own UI
    |
Application responds using the Harness request ID
    |
Core persists the resolution
    |
Adapter translates and returns the native response
```

The adapter may keep a native callback or promise pending while waiting. The durable Harness record makes the request visible and recoverable even though the native handle itself exists only in memory.

## TUI integration

A TUI imports Harness directly into its Node.js process:

```text
TUI process
  +-- rendering and keyboard input
  +-- Harness SDK
  +-- SQLite connection
  +-- provider child processes or SDK runtimes
```

The TUI chooses a stable `homeDir`, often a hidden directory under the user's home directory or an application data directory. The SDK does not choose a product-specific folder name.

## Electron integration

Harness runs in Electron's main process, never in the renderer:

```text
Renderer
    |
    | narrow, typed IPC bridge
    v
Electron main process
    +-- Harness SDK
    +-- SQLite in app.getPath("userData")
    +-- provider runtimes
```

The main process converts SDK objects and events into serializable IPC messages. The preload bridge exposes only the operations the renderer needs. The renderer does not receive executable paths, environment secrets, database access, or arbitrary process-spawning privileges.

An Electron application normally uses a directory below `app.getPath("userData")` as `homeDir`.

## Configuration and secrets

Applications may provide an exact provider executable path and an asynchronous environment resolver. Environment values are passed only when a runtime starts. They are never stored in SQLite, included in normalized events, or written to logs.

The default logger is operational and redacted. It writes rotating files under `homeDir/logs` and does not write to the application's console. Applications may replace it with a compatible logger.
