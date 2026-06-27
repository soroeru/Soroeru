// The only capability the renderer has is `window.soroeru`, the typed bridge
// exposed by the preload (RFC-002 §3). It carries no fs/network/vault handles —
// just sanitized request/response methods over the IPC allowlist.

import type { SoroeruApi } from "../../electron/preload-api.js";

declare global {
  interface Window {
    readonly soroeru: SoroeruApi;
  }
}

export {};
