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
import { VisibilityHost } from "./panel/visibility-host.js";
import { VisibilityPanel } from "./panel/VisibilityPanel.js";
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
  ...(cloudClient ? { cloudClient } : {}),
});

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
    unlockedContent={<VisibilityPanel host={host} />}
    onLock={() => host.lock()}
  />,
);
