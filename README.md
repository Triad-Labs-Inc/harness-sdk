# Harness SDK

Harness SDK is a TypeScript library for building terminal and Electron applications that control coding agents installed on the user's machine.

The SDK presents one application-facing API while provider adapters handle the differences between Codex, Claude Code, and future agent harnesses. The first release targets the Codex app-server and the Claude Agent SDK. OpenCode, Goose, and Pi can be added later through the same adapter contract.

The first implementation includes the core runtime, memory and SQLite stores, Codex and Claude adapters, a deterministic testkit, and TUI and Electron reference applications. The specification and design decisions remain the behavioral contract.

## What developers should be able to build

- A terminal user interface (TUI) that creates and resumes agent sessions, streams output, and handles permissions.
- An Electron application whose main process owns the SDK, local agent processes, and SQLite database.
- Multiple independent sessions, such as a coder session and a reviewer session, running at the same time.

The SDK is a local developer tool. It does not provide a hosted service, user accounts, billing, or a user interface.

## Requirements

- Node.js 22.13 or newer.
- An application-owned `homeDir`.
- Codex installed and authenticated for `@harness-sdk/codex`.
- Claude Code authenticated with `claude auth login`, or Claude API credentials available to the process, for `@harness-sdk/claude`.

Real-provider tests are opt-in. The default build and test suite needs no provider installation, network, credentials, or paid usage.

## Usage

```ts
import { createHarness } from "@harness-sdk/core";
import { createCodexProvider } from "@harness-sdk/codex";
import { createClaudeProvider } from "@harness-sdk/claude";

const harness = await createHarness({
  homeDir: "/path/to/app-data/harness",
  providers: {
    codex: createCodexProvider(),
    claude: createClaudeProvider(),
  },
});

const session = await harness.sessions.create({
  provider: "codex",
  cwd: "/path/to/project",
});

const snapshot = await session.snapshot();

const subscription = await session.subscribe(
  { afterSequence: snapshot.sequence },
  {
    onEvent: (event) => render(event),
    onError: (error) => reportSubscriptionError(error),
  },
);

const turn = await session.send({
  text: "Explain this repository and suggest the first improvement.",
});

const result = await turn.done();

await subscription.close();
await harness.close();
```

SQLite at `homeDir/harness.sqlite3` is the production default. Use `createMemoryStore()` only for tests or explicitly ephemeral applications.

The Claude adapter delegates authentication to Claude Code. It can reuse the user's local Claude.ai subscription login without reading or storing the credential, and it continues to support API-key and provider-specific environment configuration. Applications distributing this capability are responsible for validating any upstream approval or terms that apply to their product.

## Development

```sh
npm install
npm run build
npm test
npm run lint
npm run format:check
npm run pack:check
```

## Documentation

- [Product specification](./docs/specification.md): public behavior, terminology, and scope.
- [Architecture](./docs/architecture.md): package boundaries, process ownership, and runtime flows.
- [Provider adapters](./docs/provider-adapters.md): adapter contract and the Codex and Claude mappings.
- [Storage and events](./docs/storage-and-events.md): SQLite, replay, projections, and recovery.
- [Implementation plan](./docs/implementation-plan.md): build order and acceptance criteria.
- [Design decisions](./docs/design-decisions.md): decisions already made and features deliberately deferred.
- [Reference analysis](./docs/reference-analysis.md): what we learned from T3 Code and Buzz.
- [API reference](./docs/api.md): public packages, methods, and lifecycle behavior.
- [Migration guide](./docs/migration.md): database and API upgrade guidance.
- [Adapter authoring guide](./docs/adapter-authoring.md): implementing `ProviderAdapterV1`.
- [Third-party notices](./docs/third-party-notices.md): upstream distribution, authentication, and license constraints.
- [Implementation status](./docs/implementation-status.md): milestone evidence and test commands.
- [Codex `/goal` prompt](./GOAL_PROMPT.md): a pasteable prompt for implementing the project.

## Reference projects and protocols

T3 Code and Buzz are architectural references, not runtime dependencies.

- [T3 Code](https://github.com/pingdotgg/t3code) demonstrates provider normalization and event-sourced orchestration around local coding agents.
- [Buzz](https://github.com/block/buzz) demonstrates local agent lifecycle management in a desktop application.
- [Codex app-server](https://github.com/openai/codex/tree/main/codex-rs/app-server) provides the Codex integration protocol.
- [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript) provides the Claude integration API.
