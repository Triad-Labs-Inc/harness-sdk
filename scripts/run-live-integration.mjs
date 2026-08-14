import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const provider = process.argv[2];
const configurations = {
  codex: {
    flag: "HARNESS_RUN_CODEX_INTEGRATION",
    file: "packages/provider-codex/src/codex.integration.test.ts",
  },
  claude: {
    flag: "HARNESS_RUN_CLAUDE_INTEGRATION",
    file: "packages/provider-claude/src/claude.integration.test.ts",
  },
  mastra: {
    flag: "HARNESS_RUN_MASTRA_INTEGRATION",
    file: "packages/provider-mastra/src/mastra.integration.test.ts",
  },
};
const configuration = configurations[provider];
if (!configuration) throw new Error(`Unknown integration provider: ${String(provider)}`);

const vitest = fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url));
const child = spawn(
  process.execPath,
  [vitest, "run", "--config", "vitest.integration.config.ts", configuration.file],
  {
    stdio: "inherit",
    windowsHide: true,
    env: { ...process.env, [configuration.flag]: "1" },
  },
);

child.once("error", (error) => {
  throw error;
});
child.once("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
