# @harness-sdk/codex

Codex `app-server` stdio adapter for Harness SDK.

```ts
import { createCodexProvider } from "@harness-sdk/codex";

const provider = createCodexProvider({ executable: "/absolute/path/to/codex" });
```

The application installs and authenticates Codex. This package does neither. Native thread IDs remain opaque Harness provider metadata.
