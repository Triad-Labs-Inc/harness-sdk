# @triadlabs/harness-sdk/mastra

Mastra-native remote agent adapter for Harness SDK. It works with Mastra Cloud and self-hosted Mastra Server deployments.

Install the optional Mastra client alongside Harness SDK:

```sh
npm install @triadlabs/harness-sdk @mastra/client-js
```

```ts
import { createMastraProvider } from "@triadlabs/harness-sdk/mastra";

const provider = createMastraProvider({
  id: "studio-director",
  baseUrl: process.env.MASTRA_SERVER_URL!,
  agentId: "studio-director",
  authToken: process.env.MASTRA_AUTH_TOKEN,
});
```

Mastra owns remote tool policy. Harness permissions, questions, steering, reasoning overrides, and suspended tool continuations are not supported. The adapter persists remote thread identity, binds sessions to one server and agent, and fails closed if remote cancellation or active-turn recovery cannot be confirmed.
