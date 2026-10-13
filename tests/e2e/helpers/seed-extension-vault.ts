// Bundled into a disposable extension copy for the browser demo test.
// It uses the production encrypted vault and domain APIs; no test hook is added to the app.
import { IndexedDbVaultPersistence } from "../../../src/store/indexeddb-vault-persistence.js";
import { VaultSession, webLockManager } from "../../../src/store/vault-session.js";
import { DomainService } from "../../../src/domain/domain-service.js";

declare global {
  interface Window {
    demoSeed?: Promise<{ status?: string; message?: string; disclosures?: number; cloudEnabled?: boolean }>;
  }
}

window.demoSeed = (async () => {
  const persistence = new IndexedDbVaultPersistence();
  const session = new VaultSession({ persistence, lockManager: webLockManager(navigator.locks) });
  try {
    const mode = new URL(location.href).searchParams.get("mode");
    const state = await session.start();
    if (mode === "inspect") {
      if (state !== "locked") throw new Error("demo vault unavailable");
      await session.unlock("fake-demo-passphrase-565");
      const domain = new DomainService(session.vault);
      const site = domain.listSiteAccounts()[0];
      const checkpoint = domain.listCheckpoints()[0];
      return {
        status: checkpoint?.status ?? "none",
        message: String(checkpoint?.resumeData?.message ?? ""),
        disclosures: site ? domain.listDisclosuresForSite(site.id).length : 0,
        cloudEnabled: session.vault.get("cloudSettings", "cloud")?.cloudAssistEnabled ?? false,
      };
    }
    if (state !== "absent") throw new Error("demo profile was not empty");
    await session.create("fake-demo-passphrase-565");
    const page = new URL(location.href).searchParams.get("page");
    if (!page || !/^(tier1|tier2|tier3|wall)$/.test(page)) throw new Error("invalid demo page");
    new DomainService(session.vault).upsertSiteAccount({
      domain: "demo.example",
      displayName: `Demo ${page}`,
      url: `https://demo.example/${page}`,
    });
    await session.save();
    return {};
  } finally {
    session.close();
    persistence.close();
  }
})();
