import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Redactor, RotatingFileLogger } from "@harness-sdk/core";
import { describe, expect, it } from "vitest";

describe("operational logger", () => {
  it("rotates bounded files and redacts every segment", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "harness-logger-"));
    const redactor = new Redactor();
    redactor.register(["fixture-secret-value"]);
    const logger = new RotatingFileLogger(homeDir, redactor, 220, 2);
    for (let index = 0; index < 20; index++) {
      await logger.log("error", `entry ${index} fixture-secret-value`, {
        authorization: "fixture-secret-value",
        padding: "x".repeat(40),
      });
    }
    await logger.close();
    const directory = join(homeDir, "logs");
    const files = (await readdir(directory)).filter((file) => file.startsWith("harness.log"));
    expect(files.length).toBeLessThanOrEqual(3);
    const contents = await Promise.all(
      files.map((file) => readFile(join(directory, file), "utf8")),
    );
    expect(contents.join("\n")).not.toContain("fixture-secret-value");
  });
});
