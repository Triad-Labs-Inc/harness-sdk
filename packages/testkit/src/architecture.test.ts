import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../");

describe("package boundaries", () => {
  it("keeps core independent of official provider packages", async () => {
    const sourceFiles = [
      "errors.ts",
      "harness.ts",
      "index.ts",
      "logger.ts",
      "memory-store.ts",
      "provider.ts",
      "redaction.ts",
      "sqlite-store.ts",
      "store.ts",
      "types.ts",
    ];
    const source = (
      await Promise.all(
        sourceFiles.map((file) => readFile(resolve(root, "packages/core/src", file), "utf8")),
      )
    ).join("\n");
    expect(source).not.toContain("@anthropic-ai");
    expect(source).not.toContain("@triadlabs/harness-codex");
    expect(source).not.toContain("@triadlabs/harness-claude");
  });

  it("uses only package-root public imports in both examples", async () => {
    const files = [
      "examples/tui/src/index.ts",
      "examples/electron/src/bridge.ts",
      "examples/electron/src/main.ts",
      "examples/electron/src/preload.ts",
      "examples/electron/src/renderer.ts",
      "examples/electron/src/smoke.ts",
    ];
    for (const file of files) {
      const source = await readFile(resolve(root, file), "utf8");
      expect(source).not.toMatch(/@harness-sdk\/(?:core|codex|claude|testkit)\//);
      expect(source).not.toMatch(/packages\/(?:core|provider-codex|provider-claude)\/src/);
    }
  });

  it("keeps Harness construction out of Electron preload and renderer", async () => {
    const renderer = await readFile(resolve(root, "examples/electron/src/renderer.ts"), "utf8");
    const preload = await readFile(resolve(root, "examples/electron/src/preload.ts"), "utf8");
    const main = await readFile(resolve(root, "examples/electron/src/main.ts"), "utf8");
    expect(renderer).not.toContain("createHarness");
    expect(preload).not.toContain("createHarness");
    expect(main).toContain("createHarness");
    expect(main).toContain('app.getPath("userData")');
  });
});
