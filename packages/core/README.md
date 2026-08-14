# @triadlabs/harness-sdk

One package for building local and remote agent applications with Codex, Claude, and Mastra. The root export provides provider-independent orchestration, durable normalized events, SQLite and memory stores, recovery, subscriptions, permissions, and questions.

```sh
npm install @triadlabs/harness-sdk

# Only required when using the Mastra provider
npm install @mastra/client-js
```

```ts
import { createHarness } from "@triadlabs/harness-sdk";
import { createCodexProvider } from "@triadlabs/harness-sdk/codex";
import { createClaudeProvider } from "@triadlabs/harness-sdk/claude";
import { createMastraProvider } from "@triadlabs/harness-sdk/mastra";

const harness = await createHarness({
  homeDir: "/app/data/harness",
  providers: {
    codex: createCodexProvider(),
    claude: createClaudeProvider(),
    mastra: createMastraProvider({
      baseUrl: process.env.MASTRA_SERVER_URL!,
      agentId: process.env.MASTRA_AGENT_ID!,
    }),
  },
});
await harness.close();
```

The package also exports a deterministic fake provider from `@triadlabs/harness-sdk/testkit`. Adapter and store authors can install Vitest and import the optional contract suites from `@triadlabs/harness-sdk/testkit/vitest`. Node.js 22.13 or newer is required. See the repository's product specification and API reference for lifecycle guarantees.
