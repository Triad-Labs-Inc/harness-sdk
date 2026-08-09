# Provider boundary probes

These disposable programs validate native provider behavior before the production adapters are changed. They are deliberately independent of the production packages.

Both probes redact identifiers, paths, credentials, and token-like fields before printing or writing JSONL fixtures. Live calls are opt-in.

## Codex

```bash
node experiments/codex-app-server-probe.ts
HARNESS_RUN_LIVE_PROBES=1 \
HARNESS_PROBE_FIXTURE=experiments/fixtures/codex-0.147.0.jsonl \
node experiments/codex-app-server-probe.ts
```

The non-live run validates startup, `initialize`/`initialized`, `account/read`, thread creation, and shutdown. Codex does not materialize a resumable rollout until a turn begins, so the live run validates thread resumption in addition to streaming text, `turn/steer`, `turn/interrupt`, approval, and user input.

## Claude

Install `@anthropic-ai/claude-agent-sdk` or point at an unpacked ESM entry with `CLAUDE_AGENT_SDK_ENTRY`. Distributed products must supply `ANTHROPIC_API_KEY`; a local Claude login is available only as an explicit probe override and is not a supported Harness authentication mode.

```bash
CLAUDE_AGENT_SDK_ENTRY=/path/to/sdk.mjs \
CLAUDE_EXECUTABLE=/absolute/path/to/claude \
node experiments/claude-agent-sdk-probe.ts

ANTHROPIC_API_KEY=... \
CLAUDE_EXECUTABLE=/absolute/path/to/claude \
HARNESS_RUN_LIVE_PROBES=1 \
HARNESS_PROBE_FIXTURE=experiments/fixtures/claude-agent-sdk-0.3.226.jsonl \
node experiments/claude-agent-sdk-probe.ts
```

For local protocol observation only, `HARNESS_PROBE_ALLOW_LOCAL_CLAUDE_LOGIN=1` allows the installed Claude login to be used. Do not use that mode in a distributed product.
