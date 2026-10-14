// Side Panel implementation of the renderer's `SoroeruApi` (Issue #569), so the
// ledger, insights, import, and settings screens shared with Electron run in the
// extension unchanged. Ledger/import/reveal go through the shared
// `LedgerAppService` on the panel's unlocked vault; Visibility runs go through
// the existing `VisibilityHost` public API. Vault lifecycle stays with
// `VaultPanel`, and Electron-only surfaces (Chrome bridge, session persistence)
// answer as unavailable.

import type { SoroeruApi } from "../../electron/preload-api.js";
import type {
  VisibilityEvent,
  VisibilityRunResultView,
  VisibilityStatusView,
} from "../../electron/ipc/contract.js";
import { LedgerAppService, type LedgerContext } from "../../src/app/ledger-app-service.js";
import type { SavedPageRenderer } from "../../src/automation/saved-page-core.js";
import { DomainService } from "../../src/domain/domain-service.js";
import type { SiteAccount } from "../../src/domain/entities.js";
import type { MemoryLogger } from "../../src/logging/memory-logger.js";
import type { VaultSession } from "../../src/store/vault-session.js";
import type { VaultV2 } from "../../src/store/vault-v2.js";

/** The `VisibilityHost` surface the adapter uses (public methods only). */
export interface PanelVisibilityHost {
  listSites(): SiteAccount[];
  run(site: SiteAccount): Promise<VisibilityRunResultView>;
  resume(): boolean;
  abort(): void;
  onEvent(listener: (event: VisibilityEvent) => void): () => void;
  readonly service: { status(): VisibilityStatusView };
}

export interface PanelApiOptions {
  session: Pick<VaultSession, "state" | "vault">;
  host: PanelVisibilityHost;
  savedPageRenderer: SavedPageRenderer;
  logger: MemoryLogger;
  /** Host-permission origins needed to run one site (see `hostPermissionOrigins`). */
  originsForSite: (site: SiteAccount) => string[];
  /** `chrome.permissions` check-then-request; must run inside the user's click. */
  requestOrigins: (origins: string[]) => Promise<boolean>;
  /** Open the site in a new tab after an explicit user action. */
  openTab: (url: string) => Promise<void>;
  now?: () => Date;
}

const UNSUPPORTED = "unsupported";

export function createPanelSoroeruApi(options: PanelApiOptions): SoroeruApi {
  const domains = new WeakMap<VaultV2, DomainService>();
  let importing = false;
  const visibilityRunning = (): boolean => options.host.service.status().running;
  const context = (): LedgerContext | undefined => {
    if (options.session.state !== "unlocked") return undefined;
    const vault = options.session.vault;
    let domain = domains.get(vault);
    if (!domain) {
      domain = new DomainService(vault);
      domains.set(vault, domain);
    }
    return { vault, domain };
  };
  const ledger = new LedgerAppService({
    context,
    acquireCollection: () => {
      if (importing || visibilityRunning()) return undefined;
      importing = true;
      return () => {
        importing = false;
      };
    },
    collectionBusy: () => importing || visibilityRunning(),
    savedPageRenderer: options.savedPageRenderer,
    logger: options.logger,
  });
  const siteById = (siteAccountId: string): SiteAccount | undefined =>
    options.host.listSites().find((site) => site.id === siteAccountId);
  const emptyResult = (
    siteAccountId: string,
    status: VisibilityRunResultView["status"],
  ): VisibilityRunResultView => ({ siteAccountId, status, disclosures: 0, relationships: 0, constraints: 0 });

  return {
    vault: {
      // VaultPanel owns setup/unlock/lock in the Side Panel; the shared screens never call these.
      status: async () => ({
        exists: options.session.state !== "absent",
        locked: options.session.state !== "unlocked",
        hasRecoveryKey: context()?.vault.hasRecoveryKey ?? false,
      }),
      setup: async () => ({ ok: false, locked: options.session.state !== "unlocked", error: UNSUPPORTED }),
      unlock: async () => ({ ok: false, locked: options.session.state !== "unlocked", error: UNSUPPORTED }),
      unlockWithRecoveryKey: async () => ({
        ok: false,
        locked: options.session.state !== "unlocked",
        error: UNSUPPORTED,
      }),
      lock: async () => ({ ok: false, locked: options.session.state !== "unlocked", error: UNSUPPORTED }),
      generateRecoveryKey: async () => ({ ok: false, error: UNSUPPORTED }),
    },
    domain: { summary: async () => ledger.domainSummary() },
    csv: { import: (data) => ledger.importCsv(data) },
    savedPage: {
      import: (request) => ledger.importSavedPage(request),
      openSite: async (siteAccountId) => {
        const target = ledger.siteUrl(siteAccountId);
        if (!target.ok) return target;
        try {
          await options.openTab(target.url);
          return { ok: true, url: target.url };
        } catch {
          return { ok: false, error: "open-failed" };
        }
      },
      markManualCheck: (siteAccountId) => ledger.markSavedPageManualCheck(siteAccountId),
    },
    ledger: {
      sites: async () => ledger.ledgerSites(),
      site: async (siteAccountId) => ledger.ledgerSite(siteAccountId),
      siteDetails: async () => ledger.ledgerSiteDetails(),
      reorderSites: (orderedIds) => ledger.reorderSiteAccounts(orderedIds),
      insights: async () => ledger.ledgerInsights(),
      reveal: (disclosureId, passphrase) => ledger.revealValue(disclosureId, passphrase),
      confirmDynamicCandidate: (request) => ledger.confirmDynamicAttributeCandidate(request),
      deleteSite: (request) => ledger.deleteSiteAccount(request),
      updateCredential: (request) => ledger.updateSiteCredential(request),
    },
    sessionPersistence: {
      // Playwright storageState persistence does not exist in the extension; the UI hides it.
      set: async () => ({ ok: false, error: "not-found" }),
      clear: async () => ({ ok: false, error: "not-found" }),
    },
    visibility: {
      prepare: async (siteAccountIds) => {
        const origins = new Set<string>();
        for (const id of siteAccountIds) {
          const site = siteById(id);
          if (site) for (const origin of options.originsForSite(site)) origins.add(origin);
        }
        if (origins.size === 0) return true;
        try {
          return await options.requestOrigins([...origins]);
        } catch {
          return false;
        }
      },
      run: async (siteAccountId) => {
        if (options.session.state !== "unlocked") return emptyResult(siteAccountId, "locked");
        if (importing) return emptyResult(siteAccountId, "busy");
        const site = siteById(siteAccountId);
        if (!site) return emptyResult(siteAccountId, "skipped");
        const result = await options.host.run(site);
        options.logger.info("visibility", "run finished", {
          domain: site.domain,
          status: result.status,
          disclosures: result.disclosures,
        });
        return result;
      },
      resume: async () => (options.host.resume() ? { ok: true } : { ok: false, error: "no-active-handoff" }),
      abort: async () => {
        const running = visibilityRunning();
        options.host.abort();
        return running ? { ok: true } : { ok: false, error: "no-active-run" };
      },
      status: async () => options.host.service.status(),
      onEvent: (listener) => options.host.onEvent(listener),
    },
    chromeBridge: {
      // The Electron-to-extension developer bridge does not exist inside the extension.
      // `enabled: false` makes the shared pre-run step proceed without a bridge tab.
      status: async () => ({ enabled: false, registered: false, connected: false }),
      configuration: async () => ({
        stored: { enabled: false, extensionId: "" },
        effective: {
          enabled: false,
          extensionId: "",
          enabledSource: "default",
          extensionIdSource: "default",
        },
        restartRequired: false,
      }),
      setConfiguration: async () => ({ ok: false, error: UNSUPPORTED }),
      connect: async () => ({ ok: false, error: UNSUPPORTED }),
      disconnect: async () => ({ ok: false, error: UNSUPPORTED }),
      permissions: async () => ({ origins: [] }),
      revokeOrigin: async () => ({ ok: false, error: UNSUPPORTED }),
      activeTab: async () => undefined,
      selectTab: async () => ({ ok: false, error: UNSUPPORTED }),
      stop: async () => ({ ok: true }),
      onEvent: () => () => undefined,
    },
    logs: {
      export: async () => ({
        ok: true,
        fileName: `soroeru-log-${(options.now?.() ?? new Date()).toISOString().replace(/[:.]/g, "-")}.log`,
        content: options.logger.read(),
      }),
    },
  };
}
