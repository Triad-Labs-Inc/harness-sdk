# Storage and events

This document specifies durable event ordering, SQLite projections, subscriptions, and recovery. It is intended for contributors implementing storage and runtime lifecycle behavior.

## Storage interface

Harness core depends on a replaceable storage interface. The first release includes:

- an in-memory implementation for unit and contract tests;
- a SQLite implementation for production applications.

SQLite is the default when the application does not pass another store.

The storage interface must support atomic event append and projection updates, paginated reads, snapshots at a known sequence, migrations, and graceful close. It must not expose SQLite-specific objects through the public Harness API.

## Initial SQLite model

The first migration should contain at least these logical tables:

```text
schema_migrations
sessions
turns
events
messages
interaction_requests
provider_metadata
```

The implementation may add supporting tables and indexes after measuring query patterns.

`provider_metadata` contains opaque native session identifiers and resume data. It must never contain environment secrets or credentials.

SQLite uses write-ahead logging (WAL) so application reads can continue while the event pipeline writes. All migrations run before providers start.

## Event envelope

Every normalized event has a common envelope:

```ts
interface HarnessEvent<TType extends string, TData> {
  id: string;
  sequence: number;
  sessionId: string;
  turnId?: string;
  type: TType;
  timestamp: string;
  data: TData;
  raw?: unknown;
}
```

`sequence` is store-wide and strictly increasing. It is assigned by storage, not by a provider. A provider's native sequence or message ID may be retained inside redacted raw data or provider metadata but cannot replace the Harness sequence.

Events are immutable after append.

## Normalized event families

The initial event union should include:

```text
session.created
session.status_changed
session.archived

turn.queued
turn.started
turn.completed
turn.failed
turn.interrupted

message.started
message.delta
message.completed

tool.started
tool.updated
tool.completed

permission.requested
permission.resolved

input.requested
input.resolved

diagnostic
```

The implementation should prefer additive event types and fields. Persisted events need schema versions or migration logic before the first stable release.

## Persist before delivery

The event pipeline follows one ordering rule:

```text
normalize
  -> coalesce eligible text delta
  -> begin transaction
  -> assign sequence
  -> append event
  -> update projections
  -> commit transaction
  -> deliver to subscribers
```

An application must never observe an event that cannot be replayed from storage.

Text deltas may be held for up to 25 milliseconds and combined when they belong to the same session, turn, message, and content stream. Terminal events, permissions, questions, tool state changes, diagnostics, and errors are never delayed for coalescing.

## Projections

Projections make common reads efficient. At minimum, the SDK maintains:

- current session state;
- current turn and queue state;
- readable messages and accumulated text;
- pending and resolved interactions;
- the sequence through which each snapshot is current.

Event append and projection changes occur in the same SQLite transaction. A crash cannot leave a committed event without its corresponding projection update.

## Gap-free subscriptions

Snapshots and subscriptions share the same store-wide sequence:

```ts
const snapshot = await session.snapshot();
const subscription = await session.subscribe(
  { afterSequence: snapshot.sequence },
  {
    onEvent: handleEvent,
    onError: handleSubscriptionError,
  },
);
```

Subscription setup captures the live boundary, replays matching persisted events after the requested sequence through that boundary, and then delivers later live events. The implementation must test a concurrent append during subscription setup.

Each subscriber tracks only a bounded number of undelivered events or bytes. When the bound is exceeded, the subscription closes with `SlowConsumerError`, including the last sequence safely handed to that subscriber. The application may reconnect after that sequence.

## Raw native events

Raw provider data is useful for debugging but may be large or sensitive. Persistence is opt-in:

```text
none    Do not store raw native data. This is the default.
errors  Store redacted raw data only for failures and diagnostics.
all     Store redacted raw data for every normalized event when available.
```

Redaction runs before persistence and before operational logging. Environment values supplied by the asynchronous environment resolver are always treated as secrets, regardless of key name.

## Startup recovery

When Harness opens an existing database:

1. Run migrations.
2. Mark turns that were active at shutdown as failed with `HOST_RESTARTED`.
3. Set `mayHaveSideEffects: true` for those turns.
4. Expire unresolved permission and input requests because their in-memory native callbacks no longer exist.
5. Leave accepted but not-yet-started turns paused.
6. Do not start provider runtimes until the application requests work.

The application resumes paused queued work explicitly:

```ts
await session.resumeQueue();
```

An application may opt into queue resumption during recovery with an explicit setting. Silent execution after a desktop application relaunch is not the default.

## Deletion boundaries

Archiving changes the Harness session projection and preserves its events.

Deleting a session hard-deletes its Harness-owned database records in one transaction. After the transaction commits, the SDK closes that session's subscriptions with `SessionDeletedError` and resolves the delete operation. There is no persisted `session.deleted` event because the deleted session no longer has an event stream.

Deletion does not remove provider-owned history, provider configuration, repository files, or operational logs that may contain unrelated sessions.
