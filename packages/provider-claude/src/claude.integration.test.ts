import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHarness, createMemoryStore } from "@triadlabs/harness";
import { describe, expect, it } from "vitest";

import { createClaudeProvider } from "./adapter.js";

const enabled = process.env.HARNESS_RUN_CLAUDE_INTEGRATION === "1";

describe.skipIf(!enabled)("Claude installed-provider integration", () => {
  it("starts, streams one turn, and shuts down", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "harness-claude-integration-"));
    const provider = createClaudeProvider({
      ...(process.env.CLAUDE_CODE_EXECUTABLE
        ? { executable: process.env.CLAUDE_CODE_EXECUTABLE }
        : {}),
      settingSources: [],
    });
    const harness = await createHarness({
      homeDir,
      providers: { claude: provider },
      store: createMemoryStore(),
    });
    try {
      expect(await harness.providers.claude!.status()).toMatchObject({ state: "ready" });
      const session = await harness.sessions.create({ provider: "claude", cwd: homeDir });
      const result = await (
        await session.send({ text: "Reply with exactly: harness-integration-ok" })
      ).done();
      expect(result).toEqual({ status: "completed" });
    } finally {
      await harness.close();
    }
  }, 120_000);
});
