# Implementation status

Last updated: 2026-08-09

This is the running acceptance log for the implementation plan. A milestone is marked complete only when its documented completion check passes.

## Milestone 0 — provider boundary validation

Status: complete

Observed environment:

- Node.js 25.2.1 and npm 11.6.2 on macOS.
- Codex CLI 0.147.0 with app-server stdio transport and experimental generated TypeScript/JSON schemas.
- Claude Code 2.1.223 was observed initially; the successful local-login probe used 2.1.226 after Claude Code updated.
- `@anthropic-ai/claude-agent-sdk` 0.3.226 inspected from its published npm tarball.

Commands run:

```text
node --version
npm --version
codex --version
codex app-server --help
codex app-server generate-ts --experimental --out <temporary-directory>
codex app-server generate-json-schema --experimental --out <temporary-directory>
npm pack @anthropic-ai/claude-agent-sdk@0.3.226
HARNESS_RUN_LIVE_PROBES=1 node experiments/codex-app-server-probe.ts
CLAUDE_AGENT_SDK_ENTRY=<unpacked-sdk> CLAUDE_EXECUTABLE=<installed-claude> HARNESS_RUN_LIVE_PROBES=1 HARNESS_PROBE_ALLOW_LOCAL_CLAUDE_LOGIN=1 node experiments/claude-agent-sdk-probe.ts
claude auth status
HARNESS_RUN_LIVE_PROBES=1 HARNESS_PROBE_ALLOW_LOCAL_CLAUDE_LOGIN=1 CLAUDE_EXECUTABLE=<installed-claude> node experiments/claude-agent-sdk-probe.ts
```

Results so far:

- Codex generated schemas confirm `initialize`/`initialized`, `account/read`, `thread/start`, `thread/resume`, `turn/start`, `turn/steer`, `turn/interrupt`, approval callbacks, and `item/tool/requestUserInput` over newline-delimited stdio JSON.
- `turn/steer` requires the active native turn ID as `expectedTurnId`; this remains adapter-internal and does not change the public contract.
- Observed `thread/resume` requests immediately after `thread/start` failed with JSON-RPC error `-32600` and `no rollout found for thread id`, for both ephemeral and persistent empty threads. A native thread becomes resumable only after a turn materializes its rollout; resumable Harness sessions must use persistent Codex threads and must not assume an empty native thread can be resumed.
- An observed `turn/steer` sent after the successful `turn/start` response but before the `turn/started` notification failed with JSON-RPC error `-32600` and `no active turn to steer`. The adapter must use the notification, not the request response, as its native steering-readiness boundary.
- Codex 0.147.0 rejected a model attempt to use `request_user_input` in Default collaboration mode. The probe uses Plan mode for the required question round trip; the adapter normalizes the callback when emitted and does not claim the tool is available in every native collaboration mode.
- A sandboxed command that encountered denied network access failed inside the sandbox without automatically requesting approval. Approval fixtures must ask Codex to request escalated execution explicitly; applications must not assume every sandbox denial becomes an interaction request.
- Claude types and current official documentation confirm `query()` async streaming, session IDs and `resume`, `AbortController`/`Query.interrupt()` cancellation, `canUseTool`, and `AskUserQuestion` through `canUseTool`.
- Claude 0.3.226 defaults to loading all settings sources when `settingSources` is omitted. The adapter will choose configuration sources explicitly and test this behavior.
- The unpacked Claude SDK tarball did not include its optional platform CLI binary and failed before startup until `pathToClaudeCodeExecutable` was set to the installed executable. The adapter supports an exact executable path and reports missing binaries as provider status rather than treating this as a turn failure.
- Anthropic currently says third-party products may not offer Claude.ai login or subscription rate limits without prior approval. The initial adapter therefore required `ANTHROPIC_API_KEY`. The product contract was subsequently changed to support a bring-your-own local Claude Code login while making required upstream approval the embedding application's and distributor's responsibility.
- Sanitized, selected observations are checked in under `experiments/fixtures/`. The complete local traces were intentionally not checked in because they contain unrelated plugin diagnostics and machine-specific data.
- The initial local OAuth probe reached `system/init` but failed authentication because the installed login had expired. After `claude auth login`, the same sanitized probe completed through the user's Claude Max subscription: it streamed partial messages, handled `AskUserQuestion`, approved and ran the fixture Bash command, completed a turn, resumed the same native session ID, cancelled a running turn, and closed every query.
- The production status path now uses the same no-prompt SDK initialization mechanism with persistence and MCP servers disabled. It reads only account metadata, makes no model request, and accepts local subscription, API-key, or supported external-provider authentication reported by Claude Code.

Upstream differences from the original product contract:

- The Agent SDK and installed Claude Code can technically reuse a local Claude.ai subscription login without credential extraction. Harness now exposes that capability by explicit product decision; the distribution approval caveat remains documented.

Unresolved upstream risks:

- The live Claude integration currently validates the local subscription path. A separately supplied API key is still needed to repeat the live test specifically against API-key authentication; deterministic coverage verifies its status metadata path.
- Provider protocols are additive and versioned independently. Production parsing must remain tolerant of unknown messages and fields.

Intentional deviations:

- Claude local-subscription authentication is enabled even though Anthropic's public Agent SDK documentation says third-party products require prior approval to offer Claude.ai login or subscription rate limits. Harness delegates credentials to the user-installed runtime and assigns approval/compliance responsibility to the embedding application and distributor.

## Milestone 1 — fake vertical slice

Status: complete

Commands run:

```text
npm install
npm run build
npx vitest run packages/testkit/src
```

Results:

- The TypeScript workspace builds core, testkit, both provider package shells, and both example shells.
- The deterministic fake proves send, ordered streaming, persistence before delivery, subscription, history replay, `turn.done()`, queueing, permission and question responses, steering, interruption, provider failure, graceful idempotent close, and independent session concurrency.
- Core and testkit prove this behavior without an installed provider, network, credentials, or paid usage. The final default suite count is recorded under the release gate.

## Milestone 2 — SQLite and recovery

Status: complete

Commands run:

```text
npx vitest run packages/testkit/src
npm test
```

Results:

- The shared storage contract passes against memory and SQLite.
- SQLite uses schema migrations, foreign keys, WAL, full synchronous commits, transactional event/projection writes, paginated history, store-wide auto-increment sequences, and opaque provider metadata.
- A public-API close/reopen test preserves sessions, history, projections, and sequence boundaries.
- Simulated restart tests fail active work with `HOST_RESTARTED`, expire callbacks, pause accepted queued work, and require explicit `resumeQueue()` before provider execution.
- A duplicate projection fault rolls back the event and its sequence assignment atomically.

## Milestone 3 — Codex provider

Status: complete

Commands run:

```text
npx vitest run packages/provider-codex/src
npm run test:integration:codex
```

Results:

- The adapter supervises newline-delimited `codex app-server` stdio, performs the handshake, correlates JSON-RPC requests with timeouts, starts/resumes persistent threads, waits for `turn/started` before steering, translates interactions, and shuts down the owned process tree.
- Deterministic tests use a real child-process protocol fixture and the same provider contract suite as the fake and Claude adapters.
- `cross-spawn` resolves native binaries and npm `.cmd` shims without shell interpolation on Windows. Forced Windows shutdown awaits `taskkill /T` and escalates with `/F`; a stubborn parent-plus-grandchild fixture proves forced process-tree shutdown on the executable host and will exercise the Windows branch in CI.
- The installed Codex 0.147.0 integration passed status, real streamed turn completion, and graceful shutdown in 7.3 seconds.
- The TUI registers the adapter only through its public package export and supports history, permission/input handling, steering-independent commands, interruption, and native session resume.

## Milestone 4 — Claude provider

Status: complete

Commands run:

```text
npx vitest run packages/provider-claude/src
npm run test:integration
npm run test:integration:claude
```

Results:

- The adapter uses `@anthropic-ai/claude-agent-sdk` 0.3.226 directly, maps partial and complete messages and tools, captures/resumes the SDK session ID, translates `canUseTool` permissions and `AskUserQuestion`, cancels through `Query.interrupt()`, and closes queries idempotently.
- Existing settings are respected through an explicit `["user", "project", "local"]` default; applications can pass `[]` for isolation. A deterministic test verifies both the selected sources and resume option.
- The Claude adapter passes the same status, streaming, tools, failure, crash, interaction, interruption, resume, unknown-message, and lifecycle contracts as Codex. It explicitly reports steering as unsupported.
- The TUI and Electron main process switch providers without changing normalized session, event, history, interaction, or turn-result handling.
- The opt-in installed-provider test remains skipped by default and now accepts either local Claude Code authentication or API credentials. With the user's Claude Max login, provider status returned `ready` and a real streamed turn completed without `ANTHROPIC_API_KEY` through both an explicitly selected installed Claude Code executable (13.21 seconds) and the SDK-managed default executable (14.48 seconds).
- Deterministic status tests cover local subscription metadata, API-key metadata, unauthenticated first-party state, missing executables, no-prompt/non-persistent probe options, timeout cleanup, and query closure.

## Milestone 5 — lifecycle hardening

Status: complete

Results:

- Configurable ten-minute idle suspension, 25-millisecond delta coalescing, bounded subscribers with replay, rotating redacted logs, async environment/executable resolution, and event/database schema versions are implemented.
- Fault tests cover provider-reported failure, subprocess/SDK crashes, forced parent/grandchild shutdown, crash with an unresolved callback, storage write failure, SQLite projection rollback, malformed/unknown additive messages, host restart, slow consumers, graceful close during active/queued work, and queued work paused after provider failure.
- A 20-session stress test verifies concurrent runtimes, per-session ordering, durable global sequence uniqueness, and exactly one completion per turn.
- Raw persistence remains `none` by default, while `errors` retains only documented failure and diagnostic raw payloads. SQLite byte scans and all rotated log segments are checked for registered environment secrets, including an inherited value emitted by the Codex child process.
- Public-API tests cover pre-acceptance availability/capability errors, adapter contract version rejection, archive/list/delete semantics, and subscription failure after transactional deletion.

## Milestone 6 — reference integrations and packaging

Status: complete on macOS, Linux, and Windows release hosts

Commands run:

```text
npm run smoke -w @harness-sdk/example-tui
npm run smoke -w @harness-sdk/example-electron
npm run pack:check
```

Results:

- The TUI exposes provider status, session selection/resume, streaming, permissions, questions, interruption, concurrent command input, and history using public exports only.
- Electron keeps Harness in the main process, stores data below `app.getPath("userData")`, validates a narrow typed IPC surface, and gives the sandboxed renderer no process, environment, or database access.
- Both example smoke tests pass. Electron 43.3.0 was selected from the current stable release line and its main-process smoke test passes locally.
- The Electron smoke uses an isolated profile and exits through Electron's application lifecycle. A real Linux/Xvfb run caught and verified the fix for an initially lingering main process.
- All four package tarballs contain built ESM, declarations/maps, README, and license files. A clean fixture installs them together, runs a fake turn, imports both adapters, and type-checks only the shipped declarations.
- API, migration, adapter-authoring, third-party license/authentication, and package documentation are included.

## Release gate

Status: complete

Passed locally on macOS arm64 with Node.js 22.23.2 and 24.14.1:

```text
npm ci
npm run build
npm run typecheck
npm run lint
npm run format:check
npm test                         # 79 tests passed
npm run test:integration         # 2 opt-in tests skipped without flags/credentials
npm run pack:check
npm run smoke -w @harness-sdk/example-tui
npm run smoke -w @harness-sdk/example-electron
```

The opt-in integration suite also passed both installed-provider tests while leaving them skipped by default on macOS with Node.js 25.2.1:

```text
npm run test:integration         # 2 opt-in tests skipped without flags/credentials
npm run test:integration:codex   # 1 installed-provider test passed in 11.68 seconds
npm run test:integration:claude  # passed via Claude Max login: 13.21s explicit executable, 14.48s SDK default
```

Passed in GitHub Actions on `ubuntu-latest`, `macos-latest`, and `windows-latest`, each with Node.js 22 and 24:

```text
gh run watch 31313394419 --repo ferran9908/harness-sdk --exit-status

npm ci
npm run build
npm run typecheck
npm run lint
npm run format:check
npm test                         # 79 tests passed per matrix job
npm run pack:check
npm run smoke -w @harness-sdk/example-tui
npm run smoke -w @harness-sdk/example-electron
```

All six jobs passed. The hosted run proved the Windows `.cmd` launch and process-tree paths, clean package installation, shipped declaration checks, and both reference-application smokes on both supported Node lines. Linux downloaded Electron before configuring its SUID sandbox and ran the Electron smoke under Xvfb with the Chromium sandbox enabled.

The first hosted runs exposed two release-environment issues without changing public SDK behavior: Windows checkout converted text files to CRLF before the formatting check, and Linux's lazily downloaded Electron binary did not yet exist when its sandbox permissions were configured. `.gitattributes` now enforces LF for repository text (while retaining CRLF for Windows command files), and CI installs Electron before applying the Linux sandbox ownership and mode. The corrected matrix passed in full.

Passed in clean Debian 12 amd64 containers with Node.js 22.23.2 and 24.18.0:

```text
npm ci
npm run build
npm run typecheck
npm run lint
npm run format:check
npm test                         # 78 tests passed
npm run test:integration         # 2 opt-in tests skipped without flags/credentials
npm run pack:check
npm run smoke -w @harness-sdk/example-tui
xvfb-run -a npm run smoke -w @harness-sdk/example-electron
```

The Linux runs used the locally cached `registry.fly.io/triad-labs-sandboxes:latest` image because the earlier Docker Hub pull stalled. They covered clean dependency installs, the full deterministic suite, tarball installation/runtime/declaration checks, and both packaged example smokes. Electron ran as an unprivileged user under Xvfb with its Chromium sandbox enabled; the disposable container required namespace privileges because ordinary Docker namespace creation was denied.

Gate audit:

- Memory and SQLite storage contracts: passed.
- Fake, Codex, and Claude shared provider contracts: passed deterministically.
- Crash/restart determinism and absence of secret fixtures: passed.
- Public declarations, package contents, clean installation, and example public-import boundaries: passed.
- Upstream license and Claude distribution/authentication constraints, including the embedding application's approval responsibility for subscription access: documented.
- Windows execution: package smoke invokes npm through `npm_execpath`; opt-in integration scripts use a platform-neutral Node launcher; tests use OS temporary paths; Codex launches `.cmd` shims through `cross-spawn`; Electron smoke uses an isolated profile and explicit exit; forced tree shutdown has a Windows-aware deterministic test. The complete hosted release command set passed on Windows with Node.js 22 and 24.
- Supported-OS CI: Ubuntu, macOS, and Windows pass the complete release command set and packaged smokes on Node.js 22 and 24. GitHub Actions run `31313394419` is the release-gate evidence.

Intentional deviations:

- The official Claude adapter accepts bring-your-own local subscription authentication instead of enforcing API-key-only distribution. This is an explicit product decision recorded in `docs/design-decisions.md` and `docs/third-party-notices.md`.

## Registry identity preparation — 2026-08-10

Status: complete and published

The free public npm organizations `@triadlabs` and `@triad-labs` were created under `ferran-tl` to reserve both brand spellings. Registry membership checks report `ferran-tl` as owner of each organization. `@triadlabs` is the primary package scope; `@triad-labs` is reserved defensively and has no planned packages.

The publishable package identities changed before the first registry release:

- `@harness-sdk/core` → `@triadlabs/harness`
- `@harness-sdk/codex` → `@triadlabs/harness-codex`
- `@harness-sdk/claude` → `@triadlabs/harness-claude`
- `@harness-sdk/testkit` → `@triadlabs/harness-testkit`

The private example workspaces now use `@triadlabs/harness-example-tui` and `@triadlabs/harness-example-electron`. Earlier sections retain the old workspace names because they are historical records of commands run before the rename.

Package manifests now declare public access, descriptions, repository metadata, keywords, and `prepack` builds. TypeScript incremental state moved outside `dist`; dry-run tarballs contain no `.tsbuildinfo` files. The standalone Electron proof of concept at `../harness-electron-poc` also consumes only the renamed public package identities through local file dependencies.

Commands run after the rename:

```text
npm org ls triadlabs --json
npm org ls triad-labs --json
npm install
npm run format
npm run clean
npm run build
npm run typecheck
npm run lint
npm run format:check
npm test
npm run test:integration
npm run pack:check
npm run smoke -w @triadlabs/harness-example-tui
npm run smoke -w @triadlabs/harness-example-electron
npm publish --dry-run --json -w @triadlabs/harness
npm pack <each publishable package> --dry-run --ignore-scripts --json

cd ../harness-electron-poc
npm install
npm run typecheck
npm test
npm run format:check
npm audit --audit-level=high
npm run smoke
```

Results:

- Both npm organizations: owned by `ferran-tl`.
- Deterministic SDK suite: 79 tests passed.
- Default real-provider suite: 2 opt-in tests skipped as designed.
- Lint, formatting, build, and type checks: passed.
- Tarball clean install, runtime, and shipped declaration checks: passed.
- TUI and Electron reference smoke tests: passed under the renamed workspaces.
- Standalone Electron consumer: 2 tests, production build, audit, and Electron runtime smoke passed; 0 vulnerabilities.
- Dry-run package sizes are 35.9 kB core, 14.7 kB Codex, 12.4 kB Claude, and 13.1 kB testkit; none contains build-cache state.

The first public registry release was then published interactively with npm-enforced WebAuthn/2FA:

```text
npm publish -w @triadlabs/harness --tag next --access public
npm publish -w @triadlabs/harness-testkit -w @triadlabs/harness-codex -w @triadlabs/harness-claude --tag next --access public
npm access get status <each package> --json
npm dist-tag ls <each package>
```

Published versions:

- `@triadlabs/harness@0.1.0`
- `@triadlabs/harness-testkit@0.1.0`
- `@triadlabs/harness-codex@0.1.0`
- `@triadlabs/harness-claude@0.1.0`

All four packages report public access. npm assigned both `next` and `latest` to `0.1.0` during the initial publications. npm's publish-time malware scan delayed public reads for several minutes after the publish API accepted the packages; all four registry documents subsequently returned HTTP 200. A clean install from the public registry was started after propagation but intentionally interrupted at the user's request before it completed, so the verified clean-install evidence for this commit remains the pre-publication tarball gate recorded above.

## Single-package export consolidation — 2026-08-10

Status: complete and published

The public distribution now follows Email SDK's single-package export-map model. Inspection of `opencoredev/email-sdk` confirmed that `@opencoredev/email-sdk` publishes one tarball whose provider integrations are explicit `exports` entries such as `./resend`; those subpaths are not independent npm packages.

Harness now has one publishable npm identity and five entrypoints:

- `@triadlabs/harness-sdk`
- `@triadlabs/harness-sdk/codex`
- `@triadlabs/harness-sdk/claude`
- `@triadlabs/harness-sdk/testkit`
- `@triadlabs/harness-sdk/testkit/vitest`

The Codex, Claude, and testkit source trees remain separate private workspaces. A release build compiles them independently and assembles their output under the public package's `dist/codex`, `dist/claude`, and `dist/testkit` directories. The root entrypoint remains provider-independent and does not evaluate provider modules. The lightweight `/testkit` entrypoint exports only the deterministic fake and does not load a test runner; the contract suites moved to `/testkit/vitest`, with Vitest declared as an optional peer dependency. A normal production installation therefore installs the Claude Agent SDK and `cross-spawn`, but not Vitest.

`@triadlabs/harness-sdk@0.1.0` is published publicly with the `latest` tag. The previous `@triadlabs/harness`, `@triadlabs/harness-codex`, `@triadlabs/harness-claude`, and `@triadlabs/harness-testkit` `0.1.0` releases remain available as historical artifacts and are deprecated with migration notices pointing to the corresponding entrypoint in `@triadlabs/harness-sdk`.

Commands run:

```text
npm view @triadlabs/harness-sdk name version --json
npm install
npm run clean
npm run build:package
npm run build
npm run pack:check
npm test
npm run format
npm run clean
npm run build
npm run typecheck
npm run lint
npm run format:check
npm test
npm run test:integration
npm run pack:check
npm run smoke -w @triadlabs/harness-example-tui
npm run smoke -w @triadlabs/harness-example-electron
npm pack ./packages/core --dry-run --ignore-scripts --json
npm publish --dry-run --json -w @triadlabs/harness-sdk --ignore-scripts
npm publish -w @triadlabs/harness-sdk --access public
npm access get status @triadlabs/harness-sdk
npm view @triadlabs/harness-sdk@0.1.0 --json

# In a new temporary project, using only the public registry:
npm install --ignore-scripts @triadlabs/harness-sdk@0.1.0
node --input-type=module -e "await import('@triadlabs/harness-sdk'); await import('@triadlabs/harness-sdk/codex'); await import('@triadlabs/harness-sdk/claude'); await import('@triadlabs/harness-sdk/testkit')"
npm install --ignore-scripts vitest@4.1.10
node --input-type=module -e "await import('@triadlabs/harness-sdk/testkit/vitest')"

npm deprecate @triadlabs/harness@0.1.0 "Moved to @triadlabs/harness-sdk. Install @triadlabs/harness-sdk."
npm deprecate @triadlabs/harness-codex@0.1.0 "Moved to @triadlabs/harness-sdk/codex. Install @triadlabs/harness-sdk and import from @triadlabs/harness-sdk/codex."
npm deprecate @triadlabs/harness-claude@0.1.0 "Moved to @triadlabs/harness-sdk/claude. Install @triadlabs/harness-sdk and import from @triadlabs/harness-sdk/claude."
npm deprecate @triadlabs/harness-testkit@0.1.0 "Moved to @triadlabs/harness-sdk/testkit. Vitest contracts are at @triadlabs/harness-sdk/testkit/vitest."
npm view <each legacy package>@0.1.0 deprecated --json

cd ../harness-electron-poc
npm install
npm run format
npm run typecheck
npm test
npm run format:check
npm audit --audit-level=high
npm run smoke
```

Results:

- npm initially returned `E404` for `@triadlabs/harness-sdk`, confirming that the name was free before release.
- Published `@triadlabs/harness-sdk@0.1.0` publicly; npm reports `latest` as `0.1.0`, public access, 73 files, and a 383,112-byte unpacked size.
- A clean temporary project installed `@triadlabs/harness-sdk@0.1.0` from the public registry with 0 audit vulnerabilities. The root, `/codex`, `/claude`, and `/testkit` entrypoints imported successfully while `node_modules/vitest` was absent. After explicitly installing `vitest@4.1.10`, `/testkit/vitest` imported successfully.
- Deprecated all four legacy `0.1.0` packages and verified their registry notices point to the matching root, `/codex`, `/claude`, or `/testkit` entrypoint.
- Clean SDK build, type check, lint, and formatting checks: passed.
- Deterministic SDK suite: 79 tests passed.
- Default real-provider suite: 2 opt-in tests skipped as designed.
- Single-tarball clean install, runtime import, and declaration smoke tests: passed for all five entrypoints. The smoke first proves that Vitest is absent and `/testkit` works, then installs Vitest explicitly and verifies `/testkit/vitest`.
- TUI and Electron reference smokes: passed.
- Standalone Electron consumer: type check, 2 tests, formatting, audit, production build, and Electron smoke passed; 0 vulnerabilities.
- Dry-run package: 69,965 bytes compressed, 383,112 bytes unpacked, 73 entries, and no `.tsbuildinfo` files.
- The first attempt used `npm pack packages/core`, which npm interpreted as a GitHub shorthand and rejected. The corrected local path `npm pack ./packages/core` passed.

Intentional deviation:

- The previous design exposed four independently published packages. The user-directed consolidation replaces that registry layout with one package. Internal source boundaries and the root entrypoint's provider independence are preserved, but a root-only installation now installs dependencies used by the Codex and Claude provider subpaths. Test-runner dependencies remain opt-in through `/testkit/vitest`.

## Mintlify documentation site — 2026-08-10

Status: complete locally; production project connected and awaiting a documentation commit

The existing site at `https://harness-sdk.mintlify.app` was inspected before replacing its source. Its information architecture was useful, but its install and import examples still referenced the four deprecated package names. The repository now contains a code-based Mintlify project under `docs/` with a current `docs.json`, 22 user-facing MDX pages, light and dark brand assets, task-based navigation, and 22 permanent redirects from the established live URLs.

The site documents installation, a complete first turn, Codex and Claude setup, sessions and queues, gap-free streaming, permissions and questions, TUI and Electron integration, crash recovery, security boundaries, the deterministic fake, optional Vitest contracts, storage, errors, events, adapter authoring, and package migration. Every package example uses `@triadlabs/harness-sdk` and its public subpaths.

Commands run:

```text
npm run format
npm run docs:validate
npm run docs:a11y
npm run docs:dev -- --no-open --port 3333
```

Results:

- Mintlify strict build validation: passed.
- Mintlify accessibility audit: passed. The primary light-theme accent reaches a 7.19:1 contrast ratio; all configured colors meet the audit thresholds, and all checked media has alternative text.
- Local rendered inspection: passed for the landing page, navigation, `/quickstart` redirect, current quickstart code, Electron guide, and Harness API reference.
- The existing Mintlify project is connected to `Triad-Labs-Inc/harness-sdk`, branch `main`, with monorepo documentation path `/docs`. Saving the Git settings queued a deployment and the dashboard verified the new repository link. Production remains on the older content until the local documentation changes are committed and pushed.

Tooling note:

- Mint CLI 4.2.788 rejects Node.js 25.2.1. The repository scripts provision Node.js 22.23.2 and Mint CLI 4.2.788 through `npx`, so preview and validation work without changing the application's active Node.js version.

## Repository cleanup — 2026-08-10

Removed `GOAL_PROMPT.md` and its README link. The file was the completed implementation prompt, contained a machine-specific path, and had no runtime, test, packaging, or documentation role. The provider probes, sanitized fixtures, internal design documents, and package-level READMEs remain because they still support reproducibility and contributor work.

Moved Vitest from the private testkit workspace's runtime dependencies to its development dependencies. The published package continues to expose the contracts through `/testkit/vitest` with an optional Vitest peer, while `/testkit` remains test-runner-free. Updated stale probe fixture paths, Claude login wording, and the migration note about the already deprecated package names.

Commands run:

```text
git diff --check
npm run format:check
npm run lint
npm test
npm run typecheck
npm run pack:check
npm run build:examples
npm run docs:validate
```

Results: 79 tests passed. Type checks, package assembly and clean-install smoke tests, TUI and Electron builds, formatting, linting, and Mintlify validation passed.

## MIT license metadata — 2026-08-10

The repository and every workspace now declare the SPDX license identifier `MIT`. The root and both private examples were the missing entries; the public SDK and internal package workspaces already declared it. The README links to the canonical root `LICENSE`, while the publishable package retains its identical `packages/core/LICENSE` copy for the npm tarball. Third-party dependencies and provider runtimes retain their own licenses and terms.

Commands run:

```text
npm install --package-lock-only --ignore-scripts
npm run format:check
npm run lint
npm run pack:check
```

Results: formatting and linting passed. The package tarball, dependency-light installation, runtime imports, optional Vitest entrypoint, and declaration smoke tests passed.

## Coding-agent Electron starter prompt — 2026-08-11

Added a copy-ready, coding-agent-agnostic prompt at `getting-started/electron-starter-prompt.mdx` and linked it from the Mintlify Start here navigation and repository README. The prompt now clones the public `Triad-Labs-Inc/harness-electron-starter` template into an empty current directory or an isolated `harness-electron-app` child directory when other files are present.

The generated-app contract requires the published `@triadlabs/harness-sdk` package, Harness ownership in Electron's main process, typed and validated IPC, multiple navigable Codex and Claude sessions, explicit queue/steer/interrupt behavior, durable snapshot-plus-subscribe projection, supervised permissions, separate questions, recovery controls, and an offline deterministic acceptance suite. Provider login and live-provider checks remain explicit manual steps.

Commands run:

```text
npx prettier --write docs/getting-started/electron-starter-prompt.mdx docs/docs.json README.md
git diff --check
npm run format:check
npm run docs:validate
npm run docs:a11y
npm run docs:dev -- --no-open --port 3333
curl --location http://localhost:3333/getting-started/electron-starter-prompt
```

Results: formatting passed, Mintlify strict build validation passed, and the accessibility audit found no issues across all 35 checked MDX files. The local preview returned HTTP 200 for the new route and rendered the clone URL, the instruction not to rebuild from scratch, the safe fallback directory name, and the GitHub template option.

## Public Electron starter — 2026-08-11

Converted the standalone proof of concept into the public `Triad-Labs-Inc/harness-electron-starter` repository and enabled GitHub's template-repository mode. The starter consumes `@triadlabs/harness-sdk@0.1.0` from npm and contains no local SDK dependency or machine-specific path.

The application now uses a simplified two-pane workbench with navigable sessions and a focused conversation surface. Provider readiness appears in first-run and session-creation contexts instead of a permanent diagnostics sidebar. The new-session dialog is keyboard-dismissible, provider selection avoids unavailable defaults, and durable activity appears only as contextual session or header state.

The repository includes an MIT license, portable clone instructions, customization guidance, a Node 22 pin, public-repository metadata, GitHub Actions CI, event-projection tests, a deterministic fake-provider vertical-slice test, and an isolated Electron smoke test.

Commands run in the source directory and a clean clone from GitHub:

```text
npm ci
npm run check
npm run build
npm run smoke
npm audit --audit-level=high
npm start
```

Results: 3 tests passed across 2 files. Type checking, formatting, the production renderer and main/preload builds, the isolated Electron smoke test, and the high-severity audit passed with 0 vulnerabilities. The production `file://` build was inspected in the real Electron window; both providers reported ready, the first-run screen and new-session dialog rendered correctly, the dialog closed with Escape, and the simplified layout contained no right diagnostics sidebar. A clean clone from `https://github.com/Triad-Labs-Inc/harness-electron-starter.git` repeated installation, checks, build, and smoke successfully.
