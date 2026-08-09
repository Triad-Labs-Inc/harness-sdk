import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];
if (mode === "child") {
  process.on("SIGTERM", () => undefined);
  globalThis.setInterval(() => undefined, 1_000);
} else {
  const pidFile = mode;
  if (!pidFile) throw new Error("A PID file path is required");
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "child"], {
    stdio: "ignore",
    windowsHide: true,
  });
  if (!child.pid) throw new Error("Stubborn child process did not start");
  writeFileSync(pidFile, JSON.stringify({ parent: process.pid, child: child.pid }));
  process.on("SIGTERM", () => undefined);
  process.stdin.resume();
  globalThis.setInterval(() => undefined, 1_000);
}
