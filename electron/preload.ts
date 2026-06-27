// Preload script (RFC-002 §3): the narrow bridge between the trusted main and
// the untrusted renderer. It exposes ONLY the typed Soroeru API, and only the
// allowlisted IPC channels reachable through it (see ./preload-api.ts and
// ./ipc/contract.ts). It runs with sandbox: true, so this file is bundled into
// a self-contained CommonJS module by Vite (`vite build --mode preload`); the
// tsc-compiled copy under dist/compiled is for typechecking only.

import { contextBridge, ipcRenderer } from "electron";
import { createSoroeruApi } from "./preload-api.js";

contextBridge.exposeInMainWorld(
  "soroeru",
  createSoroeruApi((channel, ...args) => ipcRenderer.invoke(channel, ...args)),
);
