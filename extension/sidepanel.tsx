import { CloudClient } from "./cloud-client.js";
declare const __SOROERU_CLOUD_API_URL__: string;
// Side Panel entry (Issue #557). The master key lives only in this page's
// `VaultSession` as a non-extractable CryptoKey; closing the panel (pagehide)
// or the browser discards it together with the Web Lock.

import { createRoot } from "react-dom/client";
import { IndexedDbVaultPersistence } from "../src/store/indexeddb-vault-persistence.js";
import { VaultSession, webLockManager } from "../src/store/vault-session.js";
import { VaultPanel } from "./VaultPanel.js";
import { createChromeLeaseClient } from "./panel/lease-client.js";
import { VisibilityHost, hostPermissionOrigins } from "./panel/visibility-host.js";
import { PanelShell } from "./panel/PanelShell.js";
import { createPanelSoroeruApi } from "./panel/panel-api.js";
import { createFrameSavedPageRenderer } from "./panel/saved-page-frame-renderer.js";
import { MemoryLogger } from "../src/logging/memory-logger.js";
import { configureSurface } from "../src/renderer/surface.js";
import "./sidepanel.css";

const persistence = new IndexedDbVaultPersistence();
const session = new VaultSession({ persistence, lockManager: webLockManager(navigator.locks) });
// Started once outside React so a re-mounted component never races for the Web Lock.
const started = session.start();
// VaultPanel reports the failure; this keeps an early rejection from being unhandled.
started.catch(() => undefined);
const persistGranted = navigator.storage.persist().catch(() => false);

const cloudClient = (() => {
  if (!__SOROERU_CLOUD_API_URL__) return undefined;
  try {
    return new CloudClient({
      apiBaseUrl: __SOROERU_CLOUD_API_URL__,
      fallbackBaseUrl: __SOROERU_CLOUD_API_URL__,
    });
  } catch {
    return undefined;
  } // Invalid optional Cloud configuration must not disable the local vault.
})();
const host = new VisibilityHost({
  session,
  leaseClient: createChromeLeaseClient(),
  // CloudClient satisfies both ResolveClient and DeliveryClient; pass it for both roles.
  ...(cloudClient ? { cloudClient, deliveryClient: cloudClient } : {}),
});

// The ledger, insights, and settings screens are shared with the Electron renderer and call
// `window.soroeru`; here that API is the panel adapter over this page's vault (Issue #569).
configureSurface({ sessionPersistence: false, chromeBridge: false });
const panelApi = createPanelSoroeruApi({
  session,
  host,
  logger: new MemoryLogger(),
  savedPageRenderer: createFrameSavedPageRenderer({
    document,
    window,
    origin: location.origin,
    frameUrl: chrome.runtime.getURL("saved-page-frame.html"),
    createNonce: () => crypto.randomUUID(),
  }),
  originsForSite: (site) => hostPermissionOrigins(site.domain),
  requestOrigins: async (origins) =>
    (await chrome.permissions.contains({ origins })) || chrome.permissions.request({ origins }),
  openTab: async (url) => {
    await chrome.tabs.create({ url });
  },
});
Object.defineProperty(window, "soroeru", { value: panelApi, configurable: false, writable: false });

// Closing the panel, reloading it, or quitting the browser aborts any run, releases the lease,
// saves best-effort, and drops the key and the Web Lock.
window.addEventListener("pagehide", () => {
  void host
    .shutdown()
    .catch(() => undefined)
    .finally(() => persistence.close());
});

const container = document.getElementById("root");
if (!container) throw new Error("missing #root");
createRoot(container).render(
  <VaultPanel
    session={session}
    started={started}
    persistGranted={persistGranted}
    unlockedContent={<PanelShell host={host} />}
    onLock={() => host.lock()}
  />,
);
