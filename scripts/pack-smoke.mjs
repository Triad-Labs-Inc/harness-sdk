import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmExecPath = process.env.npm_execpath;
if (!npmExecPath) {
  throw new Error("pack-smoke must be run through npm so its cross-platform CLI is available");
}
const runNpm = (args, options) => run(process.execPath, [npmExecPath, ...args], options);
const temporary = await mkdtemp(join(tmpdir(), "harness-pack-smoke-"));
const packs = join(temporary, "packs");
const fixture = join(temporary, "fixture");
await mkdir(packs);
await mkdir(fixture);

try {
  const { stdout } = await runNpm(
    ["pack", join(root, "packages/core"), "--json", "--pack-destination", packs],
    { cwd: root },
  );
  const packed = JSON.parse(stdout)[0];
  const names = new Set(packed.files.map((file) => file.path));
  for (const required of [
    "package.json",
    "dist/index.js",
    "dist/index.d.ts",
    "dist/codex/index.js",
    "dist/codex/index.d.ts",
    "dist/claude/index.js",
    "dist/claude/index.d.ts",
    "dist/testkit/index.js",
    "dist/testkit/index.d.ts",
    "dist/testkit/vitest.js",
    "dist/testkit/vitest.d.ts",
    "README.md",
    "LICENSE",
  ]) {
    if (!names.has(required)) {
      throw new Error(`${packed.filename} is missing ${required}`);
    }
  }
  if ([...names].some((name) => name.endsWith(".tsbuildinfo"))) {
    throw new Error(`${packed.filename} contains TypeScript build state`);
  }
  const tarball = join(packs, packed.filename);

  await writeFile(
    join(fixture, "package.json"),
    JSON.stringify({ name: "harness-clean-install", private: true, type: "module" }, null, 2),
  );
  await runNpm(["install", "--ignore-scripts", tarball], { cwd: fixture });
  try {
    await access(join(fixture, "node_modules/vitest/package.json"));
    throw new Error("A normal Harness install unexpectedly included optional Vitest");
  } catch (error) {
    if (error instanceof Error && !error.message.includes("ENOENT")) throw error;
  }
  await writeFile(
    join(fixture, "smoke.mjs"),
    `import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness, createMemoryStore } from "@triadlabs/harness-sdk";
import { FakeProviderController, fakeProvider } from "@triadlabs/harness-sdk/testkit";
import { createCodexProvider } from "@triadlabs/harness-sdk/codex";
import { createClaudeProvider } from "@triadlabs/harness-sdk/claude";

const controller = new FakeProviderController();
controller.enqueue(controller.script({ type: "text", chunks: ["packaged"] }, { type: "complete" }));
const homeDir = await mkdtemp(join(tmpdir(), "harness-installed-"));
const harness = await createHarness({
  homeDir,
  store: createMemoryStore(),
  providers: { fake: fakeProvider(controller) },
});
const session = await harness.sessions.create({ provider: "fake", cwd: homeDir });
const result = await (await session.send({ text: "smoke" })).done();
if (result.status !== "completed") throw new Error("Installed package turn failed");
if (typeof createCodexProvider !== "function" || typeof createClaudeProvider !== "function") {
  throw new Error("Provider package public exports are unavailable");
}
await harness.close();
`,
  );
  await run(process.execPath, [join(fixture, "smoke.mjs")], { cwd: fixture });

  await runNpm(["install", "--ignore-scripts", "--save-dev", "vitest@4.1.10"], {
    cwd: fixture,
  });
  await writeFile(
    join(fixture, "contract-smoke.mjs"),
    `import { providerContract, storageContract } from "@triadlabs/harness-sdk/testkit/vitest";
if (typeof providerContract !== "function" || typeof storageContract !== "function") {
  throw new Error("Vitest contract-suite exports are unavailable");
}
`,
  );
  await run(process.execPath, [join(fixture, "contract-smoke.mjs")], { cwd: fixture });

  await writeFile(
    join(fixture, "declarations.ts"),
    `import { createHarness, type ProviderAdapterV1 } from "@triadlabs/harness-sdk";
import { createCodexProvider } from "@triadlabs/harness-sdk/codex";
import { createClaudeProvider } from "@triadlabs/harness-sdk/claude";
import { fakeProvider } from "@triadlabs/harness-sdk/testkit";
import { providerContract, storageContract } from "@triadlabs/harness-sdk/testkit/vitest";

const adapters: ProviderAdapterV1[] = [createCodexProvider(), createClaudeProvider(), fakeProvider()];
void createHarness({ homeDir: ".", providers: Object.fromEntries(adapters.map(a => [a.id, a])) });
void providerContract;
void storageContract;
`,
  );
  await writeFile(
    join(fixture, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
        },
        files: ["declarations.ts"],
      },
      null,
      2,
    ),
  );
  await run(
    process.execPath,
    [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", join(fixture, "tsconfig.json")],
    { cwd: fixture },
  );
  process.stdout.write(
    "Package tarball, dependency-light install, runtime, optional Vitest, and declaration smoke tests passed\n",
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
