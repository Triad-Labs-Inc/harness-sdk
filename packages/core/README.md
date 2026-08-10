# @triadlabs/harness

Provider-independent orchestration, durable normalized events, SQLite and memory stores, recovery, subscriptions, permissions, and questions for Harness SDK.

```ts
import { createHarness } from "@triadlabs/harness";

const harness = await createHarness({ homeDir: "/app/data/harness", providers: {} });
await harness.close();
```

Node.js 22.13 or newer is required. See the repository's product specification and API reference for lifecycle guarantees.
