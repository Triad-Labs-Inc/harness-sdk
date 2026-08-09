# Reference analysis

This document records which ideas Harness SDK borrows from T3 Code and Buzz and where the design intentionally differs. The reference projects help validate architecture; Harness SDK does not copy their user interface or depend on their runtime.

## T3 Code

T3 Code places a server layer between its user interfaces and coding-agent providers. Its provider adapter boundary translates provider-specific requests and notifications into orchestration concepts. The server can then project those events into a UI-facing snapshot without teaching the UI every native protocol.

Relevant source files include:

- [`ProviderAdapter.ts`](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/provider/Services/ProviderAdapter.ts), which defines the provider boundary;
- [`CodexAdapter.ts`](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/provider/Layers/CodexAdapter.ts), which implements a concrete provider translation;
- [`ProjectionSnapshotQuery.ts`](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts), which exposes projected state to consumers.

Harness SDK adopts the same broad separation:

```text
native provider protocol -> provider adapter -> normalized orchestration events -> application state
```

T3 Code also delegates Claude authentication to the installed Claude Code runtime: it preserves the user's environment and keychain access, optionally selects an account with `CLAUDE_CONFIG_DIR`, and reads account metadata from an Agent SDK initialization. Harness uses the same bring-your-own-runtime mechanism for its Claude status probe and turns, while leaving upstream distribution approval to the embedding application.

Harness SDK differs in several ways:

- It is an embeddable Node.js library rather than a WebSocket application server.
- It supports both a direct TUI process and an Electron main process.
- Its normalized event stream is a public, durable SDK contract with sequence replay.
- It exposes a public adapter interface for providers outside the repository.
- It coalesces small text deltas for a short fixed window instead of making a full buffered message the only useful application update.
- A future mobile bridge belongs above the SDK rather than inside the provider layer.

## Buzz

Buzz is a desktop application that manages local agents and uses the Agent Client Protocol (ACP) in parts of its agent integration. Its managed-agent runtime is useful evidence that a desktop host should own agent startup, runtime state, and shutdown instead of pushing those responsibilities into the UI.

Relevant source files include:

- [`buzz-acp/README.md`](https://github.com/block/buzz/blob/main/crates/buzz-acp/README.md), which describes its ACP integration;
- [`managed_agents/runtime.rs`](https://github.com/block/buzz/blob/main/desktop/src-tauri/src/managed_agents/runtime.rs), which manages local agent runtimes.

Harness SDK adopts these ideas:

- the host application owns local agent lifecycles;
- each agent runtime is isolated and explicitly stopped;
- the UI receives structured state rather than parsing terminal output;
- provider availability is reported separately from conversation state.

Harness SDK is not built on Buzz's application architecture:

- It does not use Rust or Tauri.
- It does not require ACP as the universal provider protocol.
- Codex uses app-server directly and Claude uses the Agent SDK directly.
- It separates the reusable integration library from the desktop application's UI and product rules.

## Resulting design rule

The stable boundary is the normalized Harness contract, not any current provider protocol. Native Codex, Claude, ACP, or future provider changes remain inside their adapters. Applications continue to use Harness sessions, turns, events, capabilities, permissions, and questions.
