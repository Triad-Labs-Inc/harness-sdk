# @triadlabs/harness-testkit

Deterministic fake provider plus shared storage and provider contract suites for Harness SDK adapters and stores.

```ts
import { FakeProviderController, fakeProvider } from "@triadlabs/harness-testkit";

const controller = new FakeProviderController();
controller.enqueue(controller.script({ type: "text", chunks: ["fixture"] }, { type: "complete" }));
const provider = fakeProvider(controller);
```

The fake uses no provider installation, network, credentials, or paid usage.
