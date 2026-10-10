// Side Panel entry (Issue #557). The master key lives only in this page's
// `VaultSession` as a non-extractable CryptoKey; closing the panel (pagehide)
// or the browser discards it together with the Web Lock.

import { createRoot } from "react-dom/client";
import { IndexedDbVaultPersistence } from "../src/store/indexeddb-vault-persistence.js";
import { VaultSession, webLockManager } from "../src/store/vault-session.js";
import { VaultPanel } from "./VaultPanel.js";
import "./sidepanel.css";

const persistence = new IndexedDbVaultPersistence();
const session = new VaultSession({ persistence, lockManager: webLockManager(navigator.locks) });
// Started once outside React so a re-mounted component never races for the Web Lock.
const started = session.start();
// VaultPanel reports the failure; this keeps an early rejection from being unhandled.
started.catch(() => undefined);
const persistGranted = navigator.storage.persist().catch(() => false);

// Closing the panel, reloading it, or quitting the browser drops the key and the Web Lock.
window.addEventListener("pagehide", () => {
  session.close();
  persistence.close();
});

const container = document.getElementById("root");
if (!container) throw new Error("missing #root");
createRoot(container).render(
  <VaultPanel session={session} started={started} persistGranted={persistGranted} />,
);
