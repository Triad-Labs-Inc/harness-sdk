# @triadlabs/harness-sdk/testkit

Deterministic fake provider for testing applications without a provider installation, network access, credentials, or paid usage.

```ts
import { FakeProviderController, fakeProvider } from "@triadlabs/harness-sdk/testkit";

const controller = new FakeProviderController();
controller.enqueue(controller.script({ type: "text", chunks: ["fixture"] }, { type: "complete" }));
const provider = fakeProvider(controller);
```

Vitest users who author adapters or stores can run the shared contract suites separately:

```ts
import { providerContract, storageContract } from "@triadlabs/harness-sdk/testkit/vitest";
```

The `/testkit` entrypoint itself has no test-runner dependency.
