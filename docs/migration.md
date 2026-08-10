# Migration guide

## Public package consolidation

The initial four-package registry layout is replaced by one package with subpath exports:

| Previous import              | Current import                   |
| ---------------------------- | -------------------------------- |
| `@triadlabs/harness`         | `@triadlabs/harness-sdk`         |
| `@triadlabs/harness-codex`   | `@triadlabs/harness-sdk/codex`   |
| `@triadlabs/harness-claude`  | `@triadlabs/harness-sdk/claude`  |
| `@triadlabs/harness-testkit` | `@triadlabs/harness-sdk/testkit` |

Install only `@triadlabs/harness-sdk`; the subpaths are exports of that package, not separately installable npm packages. The previous package names remain as deprecated historical registry artifacts with migration notices pointing to the consolidated package.

`FakeProviderController` and `fakeProvider()` move to `/testkit`. `providerContract()` and `storageContract()` move to `/testkit/vitest`; install `vitest@4.1.10` when using those contract suites.

## Pre-1.0 compatibility

The packages are versioned together. Until 1.0, review release notes for public type changes and pin exact package versions in production applications. `ProviderAdapterV1.apiVersion` changes only when the structural adapter contract becomes incompatible.

## Database migrations

SQLite is migrated automatically inside a transaction when Harness opens it. Schema version 1 contains sessions, turns, events, messages, interaction requests, provider metadata, and `schema_migrations`.

Before upgrading:

1. Gracefully close every Harness instance using the database.
2. Back up `harness.sqlite3` and any `-wal` / `-shm` companions as one set.
3. Upgrade all Harness packages together.
4. Start one application instance and let migrations finish before exposing the database to normal traffic.

Harness does not coordinate multiple host processes and does not implement database locking beyond SQLite's own transactions. A single application process should own a `homeDir`.

Never edit durable event sequences. Hard deletion removes a session's rows but deliberately preserves SQLite's sequence high-water mark.

## Recovery changes

After an ungraceful host stop, the next open:

- fails formerly active turns with `HOST_RESTARTED` and `mayHaveSideEffects: true`;
- expires unresolved permissions and questions;
- pauses accepted queued turns.

Call `session.resumeQueue()` only after the application has shown the recovered state to a user or applied its own explicit policy. Do not emulate replay by sending the old prompt again.

## Raw event policy

Upgrading never enables raw persistence. `rawEvents` remains `"none"` unless the application opts in. Treat databases created with `"all"` as potentially containing provider content even though registered secrets and sensitive-key values are redacted.

## Claude authentication behavior

The Claude adapter now probes the Claude Code runtime instead of requiring `ANTHROPIC_API_KEY` before session startup. Existing applications using API keys continue to work. Applications may remove environment resolvers whose only purpose was to copy `process.env.ANTHROPIC_API_KEY`; the adapter already inherits the process environment.

A local `claude auth login` can now satisfy provider status. The status call may take up to 25 seconds while Claude Code initializes, makes no model request, and closes its non-persistent probe. Distributors that expose Claude.ai subscription access must validate any upstream approval requirements for their product.
