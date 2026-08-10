# @triadlabs/harness-claude

Claude Agent SDK adapter for Harness SDK.

```ts
import { createClaudeProvider } from "@triadlabs/harness-claude";

const provider = createClaudeProvider();
```

The adapter delegates authentication to Claude Code. It can reuse a local login created with `claude auth login`, including a Claude.ai subscription, or use API credentials inherited from the process or supplied with `environment`. It never reads or persists the stored credential.

Status uses a no-prompt, non-persistent Agent SDK initialization probe and defaults to a 25-second timeout. Existing user, project, and local settings are loaded explicitly by default; pass `settingSources: []` for isolation. Applications distributing Claude.ai subscription access are responsible for validating any required upstream approval.
