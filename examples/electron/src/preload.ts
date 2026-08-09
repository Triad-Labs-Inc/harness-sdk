import { contextBridge, ipcRenderer } from "electron";

import type { HarnessEvent, TurnId, TurnResult } from "@harness-sdk/core";

import type { HarnessRendererApi } from "./bridge.js";

const api: HarnessRendererApi = {
  bootstrap: () => ipcRenderer.invoke("harness:bootstrap"),
  createSession: (provider) => ipcRenderer.invoke("harness:session:create", provider),
  snapshot: (sessionId) => ipcRenderer.invoke("harness:session:snapshot", sessionId),
  history: (sessionId, afterSequence) =>
    ipcRenderer.invoke("harness:session:history", sessionId, afterSequence),
  subscribe: (sessionId, afterSequence) =>
    ipcRenderer.invoke("harness:session:subscribe", sessionId, afterSequence),
  send: (sessionId, text) => ipcRenderer.invoke("harness:session:send", sessionId, text),
  interrupt: (sessionId) => ipcRenderer.invoke("harness:session:interrupt", sessionId),
  respondToPermission: (sessionId, requestId, decision) =>
    ipcRenderer.invoke("harness:permission:respond", sessionId, requestId, decision),
  respondToInput: (sessionId, requestId, response) =>
    ipcRenderer.invoke("harness:input:respond", sessionId, requestId, response),
  onEvent: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, value: HarnessEvent) => listener(value);
    ipcRenderer.on("harness:event", wrapped);
    return () => ipcRenderer.removeListener("harness:event", wrapped);
  },
  onTurnResult: (listener) => {
    const wrapped = (
      _event: Electron.IpcRendererEvent,
      value: { turnId: TurnId; result: TurnResult },
    ) => listener(value);
    ipcRenderer.on("harness:turn-result", wrapped);
    return () => ipcRenderer.removeListener("harness:turn-result", wrapped);
  },
};

contextBridge.exposeInMainWorld("harness", api);
