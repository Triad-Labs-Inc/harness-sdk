import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createClaudeProvider } from "@triadlabs/harness-sdk/claude";
import { createCodexProvider } from "@triadlabs/harness-sdk/codex";
import {
  createHarness,
  type Harness,
  type InputResponse,
  type InteractionRequestId,
  type PermissionDecision,
  type SessionId,
} from "@triadlabs/harness-sdk";
import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";

import type { BootstrapData } from "./bridge.js";

let harness: Harness | undefined;
let closing = false;
const subscriptions = new Map<number, { close(): Promise<void> }>();

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function requirePermissionDecision(value: unknown): PermissionDecision {
  if (!value || typeof value !== "object" || !("decision" in value)) {
    throw new Error("Invalid permission decision");
  }
  const decision = (value as { decision?: unknown }).decision;
  if (!["allow_once", "allow_session", "deny", "cancel_turn"].includes(String(decision))) {
    throw new Error("Invalid permission decision");
  }
  return value as PermissionDecision;
}

function requireInputResponse(value: unknown): InputResponse {
  if (!value || typeof value !== "object" || !("answers" in value)) {
    throw new Error("Invalid input response");
  }
  const answers = (value as { answers?: unknown }).answers;
  if (
    !answers ||
    typeof answers !== "object" ||
    !Object.values(answers).every(
      (items) => Array.isArray(items) && items.every((item) => typeof item === "string"),
    )
  ) {
    throw new Error("Invalid input response");
  }
  return value as InputResponse;
}

function serializable<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sdk(): Harness {
  if (!harness) throw new Error("Harness has not initialized");
  return harness;
}

async function initializeHarness(): Promise<Harness> {
  return await createHarness({
    homeDir: join(app.getPath("userData"), "harness"),
    providers: {
      codex: createCodexProvider({
        ...(process.env.CODEX_EXECUTABLE ? { executable: process.env.CODEX_EXECUTABLE } : {}),
        environment: async () => ({ OPENAI_API_KEY: process.env.OPENAI_API_KEY }),
      }),
      claude: createClaudeProvider({
        ...(process.env.CLAUDE_CODE_EXECUTABLE
          ? { executable: process.env.CLAUDE_CODE_EXECUTABLE }
          : {}),
      }),
    },
  });
}

function registerIpc(): void {
  ipcMain.handle("harness:bootstrap", async (): Promise<BootstrapData> => {
    const providers = Object.fromEntries(
      await Promise.all(
        Object.entries(sdk().providers).map(async ([name, provider]) => [
          name,
          await provider.status(),
        ]),
      ),
    );
    return serializable({ providers, sessions: await sdk().sessions.list() });
  });
  ipcMain.handle("harness:session:create", async (_event, provider: unknown) => {
    const session = await sdk().sessions.create({
      provider: requireString(provider, "provider"),
      cwd: app.getPath("documents"),
    });
    return serializable(await session.snapshot());
  });
  ipcMain.handle("harness:session:snapshot", async (_event, id: unknown) =>
    serializable(
      await (await sdk().sessions.load(requireString(id, "sessionId") as SessionId)).snapshot(),
    ),
  );
  ipcMain.handle("harness:session:history", async (_event, id: unknown, afterSequence: unknown) =>
    serializable(
      await (
        await sdk().sessions.load(requireString(id, "sessionId") as SessionId)
      ).history({
        ...(typeof afterSequence === "number" ? { afterSequence } : {}),
        limit: 500,
      }),
    ),
  );
  ipcMain.handle(
    "harness:session:subscribe",
    async (event: IpcMainInvokeEvent, id: unknown, afterSequence: unknown) => {
      const session = await sdk().sessions.load(requireString(id, "sessionId") as SessionId);
      const webContentsId = event.sender.id;
      await subscriptions.get(webContentsId)?.close();
      const subscription = await session.subscribe(
        { afterSequence: typeof afterSequence === "number" ? afterSequence : 0 },
        {
          onEvent: (value) => {
            if (!event.sender.isDestroyed())
              event.sender.send("harness:event", serializable(value));
          },
        },
      );
      subscriptions.set(webContentsId, subscription);
      event.sender.once("destroyed", () => {
        void subscriptions.get(webContentsId)?.close();
        subscriptions.delete(webContentsId);
      });
    },
  );
  ipcMain.handle("harness:session:send", async (event, id: unknown, text: unknown) => {
    const session = await sdk().sessions.load(requireString(id, "sessionId") as SessionId);
    const turn = await session.send({ text: requireString(text, "text") });
    void turn.done().then((result) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send("harness:turn-result", serializable({ turnId: turn.id, result }));
      }
    });
    return turn.id;
  });
  ipcMain.handle("harness:session:interrupt", async (_event, id: unknown) => {
    await (await sdk().sessions.load(requireString(id, "sessionId") as SessionId)).interrupt();
  });
  ipcMain.handle(
    "harness:permission:respond",
    async (_event, id: unknown, requestId: unknown, decision: unknown) => {
      await (
        await sdk().sessions.load(requireString(id, "sessionId") as SessionId)
      ).respondToPermission(
        requireString(requestId, "requestId") as InteractionRequestId,
        requirePermissionDecision(decision),
      );
    },
  );
  ipcMain.handle(
    "harness:input:respond",
    async (_event, id: unknown, requestId: unknown, response: unknown) => {
      await (
        await sdk().sessions.load(requireString(id, "sessionId") as SessionId)
      ).respondToInput(
        requireString(requestId, "requestId") as InteractionRequestId,
        requireInputResponse(response),
      );
    },
  );
}

async function createWindow(): Promise<void> {
  const window = new BrowserWindow({
    width: 1_000,
    height: 720,
    webPreferences: {
      preload: fileURLToPath(new URL("./preload.js", import.meta.url)),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await window.loadFile(fileURLToPath(new URL("./renderer.html", import.meta.url)));
}

app.on("before-quit", (event) => {
  if (closing) return;
  event.preventDefault();
  closing = true;
  void Promise.all([...subscriptions.values()].map((subscription) => subscription.close()))
    .then(async () => await harness?.close())
    .finally(() => app.quit());
});

await app.whenReady();
harness = await initializeHarness();
registerIpc();
await createWindow();

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
