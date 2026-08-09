# Codex `/goal` prompt

Run this command from `/Users/ferran/workspace/side-projects/harness-sdk` after reviewing the design documents. The goal is deliberately self-contained so a long-running Codex task can continue across context compaction.

```text
/goal Implement the first production-ready version of Harness SDK described in this repository.

Read README.md and every file under docs/ before changing code. Treat docs/specification.md and docs/design-decisions.md as the product contract. Follow docs/implementation-plan.md in milestone order, beginning with the disposable Codex app-server and Claude Agent SDK probes. If observed upstream behavior conflicts with the specification, record the evidence and update the relevant design document before changing the public behavior.

Build a TypeScript Node.js monorepo with separate core, Codex provider, Claude provider, and testkit packages plus TUI and Electron examples. Keep core independent of official provider packages. Use a public, versioned ProviderAdapterV1 contract, a deterministic fake provider, an in-memory test store, and SQLite as the production default.

Deliver working vertical slices. First prove send -> stream -> persist -> subscribe -> turn.done() with the fake provider. Then implement SQLite and recovery, Codex through app-server stdio, Claude through @anthropic-ai/claude-agent-sdk, lifecycle hardening, and the examples. Do not add OpenCode, Goose, Pi, Tauri, hosted/mobile transport, worktrees, locking, arbitrary terminal attachment, automatic provider installation/login, or automatic adapter discovery in this goal.

Preserve these required semantics: one active turn per session; send() queues; steering and interruption are explicit; events are committed before delivery; sequences are durable and store-wide; snapshots subscribe after their sequence without gaps; slow subscribers replay after SlowConsumerError; raw persistence defaults to none; supervised permissions and questions are separate; active turns fail with HOST_RESTARTED after a host crash; queued turns do not silently run after restart; provider crashes never automatically replay accepted turns; harness.close() is graceful and idempotent; environment values and credentials are never persisted or logged.

Use tests as the acceptance mechanism. Run shared provider and storage contract suites, deterministic fixture tests, crash and recovery tests, type checks, linting, and package builds. Keep real-provider tests opt-in so the default suite needs no installed agent, network access, credentials, or paid usage. Verify both reference applications use only public exports and keep Harness in Electron's main process.

Maintain docs/implementation-status.md while working. Record each milestone, commands run, test results, unresolved upstream risks, and intentional deviations. Continue until every release gate in docs/implementation-plan.md is satisfied or a genuine external blocker prevents further progress. Do not mark the goal complete while required work, tests, documentation, or packaging remains.
```
