// Preload script (RFC-002 §3): the narrow bridge between the trusted main and
// the untrusted renderer. It exposes ONLY the typed Soroeru API, and only the
// allowlisted IPC channels reachable through it (see ./preload-api.ts and
// ./ipc/contract.ts). It runs with sandbox: true, so this file is bundled into
// a self-contained CommonJS module by Vite (`vite build --mode preload`); the
// tsc-compiled copy under dist/compiled is for typechecking only.

import { contextBridge, ipcRenderer } from "electron";
import { createSoroeruApi } from "./preload-api.js";
import {
  CHROME_BRIDGE_EVENT_CHANNEL,
  VISIBILITY_EVENT_CHANNEL,
  type ChromeBridgeConnectionEvent,
  type VisibilityEvent,
} from "./ipc/contract.js";

contextBridge.exposeInMainWorld(
  "soroeru",
  createSoroeruApi(
    (channel, ...args) => ipcRenderer.invoke(channel, ...args),
    (listener) => {
      // Wrap so the renderer never receives Electron's IpcRendererEvent (which
      // can carry a sender handle); it sees only the sanitized payload.
      const handler = (_event: unknown, payload: VisibilityEvent): void => listener(payload);
      ipcRenderer.on(VISIBILITY_EVENT_CHANNEL, handler);
      return () => ipcRenderer.removeListener(VISIBILITY_EVENT_CHANNEL, handler);
    },
    (listener) => {
      const handler = (_event: unknown, payload: ChromeBridgeConnectionEvent): void => listener(payload);
      ipcRenderer.on(CHROME_BRIDGE_EVENT_CHANNEL, handler);
      return () => ipcRenderer.removeListener(CHROME_BRIDGE_EVENT_CHANNEL, handler);
    },
  ),
);
