import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createHarness } from "@triadlabs/harness-sdk";
import { providerContract } from "@triadlabs/harness-sdk/testkit/vitest";
import { expect, it } from "vitest";

import { createCodexProvider } from "./adapter.js";

const fixture = fileURLToPath(new URL("../test-fixtures/app-server.mjs", import.meta.url));

providerContract(
  "Codex fixture",
  async () =>
    createCodexProvider({
      executable: process.execPath,
      appServerArgs: [fixture],
      requestTimeoutMs: 2_000,
    }),
  {
    expectedCapabilities: {
      steering: true,
      interruption: true,
      permissions: true,
      questions: true,
      sessionResume: true,
      modelOverride: true,
      reasoningOverride: true,
      rawEvents: true,
    },
  },
);

it("reports a missing Codex executable without throwing", async () => {
  const provider = createCodexProvider({
    executable: join(tmpdir(), "definitely-missing-harness-codex"),
    requestTimeoutMs: 100,
  });
  await expect(
    provider.status({ homeDir: tmpdir(), registerSecrets: () => undefined }),
  ).resolves.toMatchObject({ state: "not_installed" });
});

it("redacts inherited environment values emitted by app-server", async () => {
  const secret = "codex-inherited-environment-secret";
  const previous = process.env.HARNESS_CODEX_FIXTURE_SECRET;
  process.env.HARNESS_CODEX_FIXTURE_SECRET = secret;
  const homeDir = await mkdtemp(join(tmpdir(), "harness-codex-environment-"));
  const harness = await createHarness({
    homeDir,
    providers: {
      codex: createCodexProvider({
        executable: process.execPath,
        appServerArgs: [fixture],
        requestTimeoutMs: 2_000,
      }),
    },
    rawEvents: "all",
    textDeltaCoalesceMs: 0,
  });
  try {
    const session = await harness.sessions.create({ provider: "codex", cwd: homeDir });
    await (await session.send({ text: "environment" })).done();
    expect(JSON.stringify(await session.snapshot())).not.toContain(secret);
  } finally {
    await harness.close();
    if (previous === undefined) delete process.env.HARNESS_CODEX_FIXTURE_SECRET;
    else process.env.HARNESS_CODEX_FIXTURE_SECRET = previous;
  }
  expect((await readFile(join(homeDir, "harness.sqlite3"))).includes(Buffer.from(secret))).toBe(
    false,
  );
});
