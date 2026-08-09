import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHarness } from "@harness-sdk/core";
import { app } from "electron";

const homeDir = await mkdtemp(join(tmpdir(), "harness-electron-smoke-"));
app.setPath("userData", join(homeDir, "electron"));
const harness = await createHarness({ homeDir, providers: {} });
await harness.close();
process.stdout.write("Harness Electron smoke test passed\n");
app.exit(0);
