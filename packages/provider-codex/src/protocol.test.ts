import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

import { CodexAppServerClient } from "./protocol.js";

const stubbornFixture = fileURLToPath(
  new URL("../test-fixtures/stubborn-process.mjs", import.meta.url),
);

async function waitForPids(path: string): Promise<{ parent: number; child: number }> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(path, "utf8")) as { parent: number; child: number };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("Timed out waiting for stubborn process IDs");
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (processExists(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

it("forcefully stops an owned app-server process tree", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-codex-process-tree-"));
  const pidFile = join(directory, "pids.json");
  const client = new CodexAppServerClient({
    executable: process.execPath,
    args: [stubbornFixture, pidFile],
    cwd: directory,
    env: process.env,
    requestTimeoutMs: 100,
  });
  const pids = await waitForPids(pidFile);
  try {
    await client.close();
    await Promise.all([waitForExit(pids.parent), waitForExit(pids.child)]);
    expect(processExists(pids.parent)).toBe(false);
    expect(processExists(pids.child)).toBe(false);
  } finally {
    for (const pid of [pids.child, pids.parent]) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // The expected path already stopped it.
      }
    }
  }
});
