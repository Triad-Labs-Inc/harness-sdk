import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHarness, createMemoryStore } from "@triadlabs/harness";
import { describe, expect, it } from "vitest";

import { createCodexProvider } from "./adapter.js";

const enabled = process.env.HARNESS_RUN_CODEX_INTEGRATION === "1";

describe.skipIf(!enabled)("Codex installed-provider integration", () => {
  it("starts, streams one turn, and shuts down", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "harness-codex-integration-"));
    const provider = createCodexProvider({
      ...(process.env.CODEX_EXECUTABLE ? { executable: process.env.CODEX_EXECUTABLE } : {}),
    });
    const harness = await createHarness({
      homeDir,
      providers: { codex: provider },
      store: createMemoryStore(),
    });
    expect(await harness.providers.codex!.status()).toMatchObject({ state: "ready" });
    const session = await harness.sessions.create({ provider: "codex", cwd: homeDir });
    const result = await (
      await session.send({ text: "Reply with exactly: harness-integration-ok" })
    ).done();
    expect(result).toEqual({ status: "completed" });
    await harness.close();
  }, 120_000);
});
