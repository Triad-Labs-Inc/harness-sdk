import { cp, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicDist = resolve(root, "packages/core/dist");
const entries = [
  ["packages/provider-codex/dist", "codex"],
  ["packages/provider-claude/dist", "claude"],
  ["packages/provider-mastra/dist", "mastra"],
  ["packages/testkit/dist", "testkit"],
];

for (const [, subpath] of entries) {
  await rm(resolve(publicDist, subpath), { recursive: true, force: true });
}

if (process.argv.includes("--clean")) process.exit(0);

for (const [source, subpath] of entries) {
  await cp(resolve(root, source), resolve(publicDist, subpath), {
    recursive: true,
    filter: (path) => !path.endsWith(".map"),
  });
}
