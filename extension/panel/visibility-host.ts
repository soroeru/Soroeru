/**
 * Side Panel runtime host for Visibility runs (Issue #558). It wires the unlocked
 * `VaultSession.vault` -> `DomainService` -> `VisibilityService`, and gives the service an
 * `openSession` backed by a worker lease on the user's active tab. It never logs or forwards
 * collected values; the UI only receives the sanitized events and counts of `VisibilityService`.
 */

import { DomainService } from "../../src/domain/domain-service.js";
import type { SiteAccount } from "../../src/domain/entities.js";
import type { VisibilityEvent, VisibilityRunResultView } from "../../electron/ipc/contract.js";
import { isSameSiteOrigin, isHttpsOrigin } from "../../src/shared/extension-messages.js";
import { leasePageTransport, openExtensionTabSession } from "../../src/automation/extension-page-driver.js";
import type { SiteSession } from "../../src/automation/page-driver.js";
import { VisibilityService } from "../../src/automation/visibility-service.js";
import type { VaultSession } from "../../src/store/vault-session.js";
import type { LeaseClient } from "./lease-client.js";

const TAB_LOAD_TIMEOUT_MS = 15_000;

export class VisibilityHostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VisibilityHostError";
  }
}

/** Host-permission match patterns for a site and its subdomains. */
export function hostPermissionOrigins(domain: string): string[] {
  // egress: target-site — host permission patterns for the user's selected site and its subdomains.
  return [`https://${domain}/*`, `https://*.${domain}/*`];
}

export interface VisibilityHostOptions {
  session: VaultSession;
  leaseClient: LeaseClient;
}

export class VisibilityHost {
  readonly service: VisibilityService;
  private readonly listeners = new Set<(event: VisibilityEvent) => void>();
  private readonly stopStateWatch: () => void;
  private bound = false;

  constructor(private readonly options: VisibilityHostOptions) {
    this.service = new VisibilityService({
      openSession: (site) => this.openSession(site),
      emit: (event) => {
        for (const listener of this.listeners) listener(event);
      },
      persist: () => options.session.save(),
      beforeResume: () => this.verifyLeaseForResume(),
    });
    // A lease that ends under a running collection (tab closed, left the site) stops the run.
    options.leaseClient.onInvalidated(() => {
      this.service.abortRun();
    });
    this.stopStateWatch = options.session.onStateChange((state) => this.onSessionState(state));
    this.onSessionState(options.session.state);
  }

  onEvent(listener: (event: VisibilityEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Ledger sites in the user's order; empty while the vault is locked. */
  listSites(): SiteAccount[] {
    if (this.options.session.state !== "unlocked") return [];
    return new DomainService(this.options.session.vault).listSiteAccountsInManualOrder();
  }

  /**
   * Ask for tab/host access to one site. Chrome requires a user gesture, so call this
   * directly from the click handler before `run`.
   */
  async requestSitePermission(site: SiteAccount): Promise<boolean> {
    const origins = hostPermissionOrigins(site.domain);
    if (await chrome.permissions.contains({ origins })) return true;
    return chrome.permissions.request({ origins });
  }

  async run(site: SiteAccount): Promise<VisibilityRunResultView> {
    return this.service.runSite(site.id);
  }

  /** The user cleared the wall: re-verify the lease, then let the runner re-observe the page. */
  resume(): boolean {
    return this.service.resumeHandoff();
  }

  abort(): void {
    this.service.abortRun();
  }

  /** User-initiated lock: stop, release the lease, save, then drop the key. */
  async lock(): Promise<void> {
    await this.stop(true);
    this.options.session.lock();
  }

  /** Panel closing: abort, release the lease and save best-effort, then drop the key. */
  shutdown(): void {
    this.stopStateWatch();
    this.service.abortRun();
    void this.options.leaseClient.releaseLease();
    const saving = this.options.session.state === "unlocked" ? this.options.session.save() : undefined;
    saving?.catch(() => undefined);
    this.options.leaseClient.close();
    this.options.session.close();
  }

  private onSessionState(state: string): void {
    if (state === "unlocked") {
      if (this.bound) return;
      this.service.setDomain(new DomainService(this.options.session.vault));
      this.bound = true;
      return;
    }
    if (!this.bound) return;
    this.bound = false;
    this.service.clearDomain();
    void this.options.leaseClient.releaseLease();
  }

  private async stop(save: boolean): Promise<void> {
    this.service.abortRun();
    await this.service.waitForActiveSessionClose();
    await this.options.leaseClient.releaseLease();
    if (save && this.options.session.state === "unlocked") {
      await this.options.session.save().catch(() => undefined);
    }
  }

  private async verifyLeaseForResume(): Promise<void> {
    if (!this.options.leaseClient.isLeaseActive()) {
      throw new VisibilityHostError("lease is no longer active");
    }
    // The worker re-verifies lease, epoch, tab, and site scope for every command.
    await this.options.leaseClient.sendPageCommand({ command: "currentUrl" });
  }

  private async openSession(site: SiteAccount): Promise<SiteSession> {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tab?.id;
    if (!tab || tabId === undefined) throw new VisibilityHostError("no active tab");
    if (!(await chrome.permissions.contains({ origins: hostPermissionOrigins(site.domain) }))) {
      throw new VisibilityHostError("host permission required");
    }
    let current = tab.url;
    const inScope = (url: string | undefined): url is string => {
      if (!url) return false;
      try {
        const origin = new URL(url).origin;
        return isHttpsOrigin(origin) && isSameSiteOrigin(origin, site.domain);
      } catch {
        return false;
      }
    };
    if (!inScope(current)) {
      // The panel moves the user's tab to the site's own entry page; the worker only navigates
      // inside an existing lease scope.
      // egress: target-site — navigate the user's selected tab after validating the site's origin.
      current = await this.navigateTab(tabId, site.url ?? `https://${site.domain}/`, site.domain);
    }
    const origin = new URL(current).origin;
    const lease = await this.options.leaseClient.openLease({ tabId, origin, siteDomain: site.domain });
    return openExtensionTabSession(leasePageTransport(this.options.leaseClient), {
      tabId: lease.tabId,
      siteDomain: site.domain,
    });
  }

  private async navigateTab(tabId: number, target: string, domain: string): Promise<string> {
    const origin = new URL(target).origin;
    if (!isHttpsOrigin(origin) || !isSameSiteOrigin(origin, domain)) {
      throw new VisibilityHostError("site URL is outside the site scope");
    }
    const loaded = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new VisibilityHostError("tab load timed out"));
      }, TAB_LOAD_TIMEOUT_MS);
      const listener = (id: number, change: { status?: string }): void => {
        if (id !== tabId || change.status !== "complete") return;
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
    loaded.catch(() => undefined);
    await chrome.tabs.update(tabId, { url: target });
    await loaded;
    const landed = (await chrome.tabs.get(tabId)).url;
    if (!landed) throw new VisibilityHostError("tab has no URL");
    return landed;
  }
}
