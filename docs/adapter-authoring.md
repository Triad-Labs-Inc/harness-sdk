# Provider adapter authoring guide

Implement `ProviderAdapterV1` from `@triadlabs/harness` and register it explicitly under the same ID.

```ts
import type { ProviderAdapterV1 } from "@triadlabs/harness";

export const adapter: ProviderAdapterV1 = {
  apiVersion: 1,
  id: "example",
  async status(context) {
    context.registerSecrets([/* resolved credential values */]);
    return { state: "ready", version: "1.0.0" };
  },
  async capabilities() {
    return {
      steering: false,
      interruption: true,
      permissions: true,
      questions: true,
      sessionResume: true,
      modelOverride: false,
      reasoningOverride: false,
      rawEvents: true,
    };
  },
  async openSession(context) {
    // Return one isolated, idempotently closeable runtime.
    throw new Error("implement runtime");
  },
};
```

Rules:

- Status must distinguish missing installation, missing authentication, and temporary unavailability without creating a durable Harness session.
- Resolve environment asynchronously at runtime startup. Register secret values immediately and never put the environment into metadata, events, errors, or logs.
- Keep native session and turn IDs internal. Store only required resume data with `context.setMetadata()`.
- Yield normalized events in native order. Core persists and publishes them; adapters never call application observers.
- Park native permission and question callbacks separately. Use the provider request ID only inside the runtime; core creates the durable public interaction ID.
- Never automatically replay an accepted turn after a crash. Throwing from the stream causes a terminal `PROVIDER_CRASHED` result with possible side effects.
- Treat unknown additive messages as ignorable or diagnostic. Malformed boundary messages may fail the turn when continuing would be unsafe.
- `close()` must be idempotent and terminate only processes the adapter created.

Run `providerContract()` from `@triadlabs/harness-testkit` with deterministic native fixtures. Real integration tests must be separately opt-in.
