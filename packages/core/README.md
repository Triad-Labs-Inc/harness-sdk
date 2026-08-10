# @triadlabs/harness-sdk

One package for building local Codex and Claude agent applications. The root export provides provider-independent orchestration, durable normalized events, SQLite and memory stores, recovery, subscriptions, permissions, and questions.

```sh
npm install @triadlabs/harness-sdk
```

```ts
import { createHarness } from "@triadlabs/harness-sdk";
import { createCodexProvider } from "@triadlabs/harness-sdk/codex";
import { createClaudeProvider } from "@triadlabs/harness-sdk/claude";

const harness = await createHarness({
  homeDir: "/app/data/harness",
  providers: {
    codex: createCodexProvider(),
    claude: createClaudeProvider(),
  },
});
await harness.close();
```

The package also exports a deterministic fake provider from `@triadlabs/harness-sdk/testkit`. Adapter and store authors can install Vitest and import the optional contract suites from `@triadlabs/harness-sdk/testkit/vitest`. Node.js 22.13 or newer is required. See the repository's product specification and API reference for lifecycle guarantees.
