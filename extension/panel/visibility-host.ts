import {
  ResolutionOrchestrator,
  type ResolveClient,
  type Tier3ConsentCallback,
  type Tier3ConsentParams,
} from "../resolution-orchestrator.js";
import { deliverQueue, type DeliveryClient } from "../cloud-delivery-queue.js";
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
import type { CloudSettings } from "../../src/domain/entities.js";
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
  cloudClient?: ResolveClient;
  /**
   * Delivery client for draining the feedback/telemetry queue. May be the same
   * `CloudClient` instance as `cloudClient`; `CloudClient` satisfies `DeliveryClient`.
   * When present, `deliverQueue` is called fire-and-forget on every session unlock.
   */
  deliveryClient?: DeliveryClient;
  leaseClient: LeaseClient;
}

export class VisibilityHost {
  readonly service: VisibilityService;
  private readonly listeners = new Set<(event: VisibilityEvent) => void>();
  private readonly stopStateWatch: () => void;
  private readonly stopCloudStateWatch: () => void;
  private bound = false;
  private stopping = false;
  private consentGateProvider: Tier3ConsentCallback | undefined;
  private activeTabOrigin: string | undefined;
  private readonly resolver: ResolutionOrchestrator;
  private settingsWrite: Promise<void> = Promise.resolve();
  private pendingOff: { cloud: boolean; sharing: boolean } = { cloud: false, sharing: false };
  private feedbackEpoch = 0;
  private sharingOverride: boolean | undefined;
  /** Resolves the currently pending consent gate promise; set only while a gate is open. */
  private pendingGateResolve: ((v: "approved" | "declined" | "timeout") => void) | undefined;

  constructor(private readonly options: VisibilityHostOptions) {
    this.resolver = new ResolutionOrchestrator({
      session: options.session,
      clientVersion: "0.1.2",
      ...(options.cloudClient ? { client: options.cloudClient } : {}),
      ...(options.deliveryClient ? { deliveryClient: options.deliveryClient } : {}),
      sharingPolicy: {
        enabled: () =>
          this.options.session.state === "unlocked" &&
          (this.sharingOverride ??
            this.options.session.vault.get("cloudSettings", "cloud")?.telemetryEnabled ??
            false) &&
          !this.pendingOff.sharing,
        epoch: () => this.feedbackEpoch,
      },
      sendPageCommand: (command) => options.leaseClient.sendPageCommand(command),
      isActive: () => !this.stopping && options.leaseClient.isLeaseActive(),
      showConsentGate: (params: Tier3ConsentParams) => this.handleConsentGate(params),
      // currentOrigin is omitted intentionally: origin is already supplied via
      // consentGate params.origin and the worktree host has no static origin.
    });
    const cloud = options.cloudClient as
      | (ResolveClient & {
          setPolicy?: (policy: () => { cloudAssistEnabled: boolean; telemetryEnabled: boolean }) => void;
          revoke?: (kind: "cloud" | "sharing") => void;
        })
      | undefined;
    cloud?.setPolicy?.(() => {
      const settings =
        options.session.state === "unlocked"
          ? options.session.vault.get("cloudSettings", "cloud")
          : undefined;
      return {
        cloudAssistEnabled: (settings?.cloudAssistEnabled ?? false) && !this.pendingOff.cloud,
        telemetryEnabled:
          (this.sharingOverride ?? settings?.telemetryEnabled ?? false) && !this.pendingOff.sharing,
      };
    });
    const resolver = this.resolver;
    this.service = new VisibilityService({
      resolveSharedSchema: async (site) => {
        try {
          return await resolver.resolve(site.domain);
        } catch {
          return null;
        } // Deterministic collection retains its wall/lease gates.
      },
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
    this.stopCloudStateWatch = options.session.onStateChange((state) => {
      if (state === "locked" || state === "closed" || state === "in-use-elsewhere") {
        this.pendingGateResolve?.("declined");
        this.pendingGateResolve = undefined;
        cloud?.revoke?.("cloud");
      }
    });
    this.stopStateWatch = options.session.onStateChange((state) => this.onSessionState(state));
    this.onSessionState(options.session.state);
  }

  get cloudAvailable(): boolean {
    return Boolean(this.options.cloudClient);
  }
  get cloudAssistEnabled(): boolean {
    return this.options.session.vault.get("cloudSettings", "cloud")?.cloudAssistEnabled ?? false;
  }
  get telemetryEnabled(): boolean {
    return this.options.session.vault.get("cloudSettings", "cloud")?.telemetryEnabled ?? false;
  }
  get settingsConfigured(): boolean {
    return Boolean(this.options.session.vault.get("cloudSettings", "cloud"));
  }
  get settings(): Readonly<CloudSettings> | undefined {
    const current = this.options.session.vault.get("cloudSettings", "cloud");
    return current ? { ...current, queue: [...current.queue] } : undefined;
  }
  async configureSettings(): Promise<void> {
    if (this.settingsConfigured) return;
    await this.updateSettings({ cloudAssistEnabled: false, telemetryEnabled: false });
  }
  async setCloudAssistEnabled(enabled: boolean): Promise<void> {
    await this.updateSettings({ cloudAssistEnabled: enabled });
  }
  async setTelemetryEnabled(enabled: boolean): Promise<void> {
    await this.updateSettings({ telemetryEnabled: enabled });
  }
  async regenerateValidatorKey(): Promise<void> {
    await this.updateSettings({ validatorKey: crypto.randomUUID(), discardFeedback: true });
  }
  private async updateSettings(patch: Partial<CloudSettings> & { discardFeedback?: boolean }): Promise<void> {
    const session = this.options.session;
    const old = session.vault.get("cloudSettings", "cloud");
    const revokingCloud = patch.cloudAssistEnabled === false && old?.cloudAssistEnabled;
    const revokingSharing =
      (patch.telemetryEnabled === false && old?.telemetryEnabled) || patch.discardFeedback === true;
    const cloud = this.options.cloudClient as
      (ResolveClient & { revoke?: (kind: "cloud" | "sharing") => void }) | undefined;
    if (revokingCloud) cloud?.revoke?.("cloud");
    if (revokingSharing) cloud?.revoke?.("sharing");
    if (revokingCloud) this.pendingOff.cloud = true;
    if (patch.telemetryEnabled === false && old?.telemetryEnabled) this.pendingOff.sharing = true;
    if (patch.telemetryEnabled === false) this.sharingOverride = false;
    if (patch.telemetryEnabled === true) this.sharingOverride = true;
    if (patch.discardFeedback) {
      this.feedbackEpoch++;
      this.pendingOff.sharing = true;
    }
    if (!old) {
      session.vault.put("cloudSettings", {
        id: "cloud",
        cloudAssistEnabled: false,
        telemetryEnabled: false,
        validatorKey: crypto.randomUUID(),
        queue: [],
        updatedAt: Date.now(),
      });
    }
    // Off changes apply in memory before persistence. Clearing the queue here makes
    // the revocation effective even if encrypted persistence later fails.
    if (revokingCloud || (patch.telemetryEnabled === false && old?.telemetryEnabled)) {
      const current = session.vault.get("cloudSettings", "cloud")!;
      session.vault.put("cloudSettings", {
        ...current,
        cloudAssistEnabled: revokingCloud ? false : current.cloudAssistEnabled,
        telemetryEnabled: patch.telemetryEnabled === false ? false : current.telemetryEnabled,
        queue: revokingCloud
          ? []
          : current.queue.filter(
              (item) => !(revokingSharing && (item.kind === "feedback" || item.kind === "telemetry")),
            ),
        updatedAt: Date.now(),
      });
    }
    const write = this.settingsWrite
      .catch(() => undefined)
      .then(async () => {
        const current = session.vault.get("cloudSettings", "cloud");
        const { discardFeedback: _discardFeedback, ...values } = patch;
        const queue =
          current?.queue.filter(
            (item) =>
              !(
                revokingCloud ||
                (revokingSharing && (item.kind === "feedback" || item.kind === "telemetry"))
              ),
          ) ?? [];
        const next = {
          id: "cloud",
          telemetryEnabled: false,
          cloudAssistEnabled: false,
          validatorKey: crypto.randomUUID(),
          ...current,
          ...values,
          queue,
          updatedAt: Date.now(),
        };
        if (revokingCloud && patch.cloudAssistEnabled === false) next.cloudAssistEnabled = false;
        if (revokingSharing && patch.telemetryEnabled === false) next.telemetryEnabled = false;
        session.vault.put("cloudSettings", {
          ...next,
        });
        await session.save();
        if (patch.cloudAssistEnabled === true) this.pendingOff.cloud = false;
        if (patch.telemetryEnabled === true) this.pendingOff.sharing = false;
        if (patch.cloudAssistEnabled === false) this.pendingOff.cloud = false;
        if (patch.telemetryEnabled === false) this.pendingOff.sharing = false;
      });
    this.settingsWrite = write;
    await write;
  }

  get sharingEpoch(): number {
    return this.feedbackEpoch;
  }

  onEvent(listener: (event: VisibilityEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Register the UI callback that shows the Tier 3 consent gate and returns the user's decision.
   * Pass `undefined` to remove it (the panel unmounts or cloud assist is disabled).
   * If a gate is pending when the provider is removed, the gate is resolved as "declined"
   * so the orchestrator doesn't hang (B5).
   */
  setConsentGateProvider(
    provider: ((params: Tier3ConsentParams) => Promise<"approved" | "declined" | "timeout">) | undefined,
  ): void {
    if (provider === undefined && this.pendingGateResolve) {
      const resolve = this.pendingGateResolve;
      this.pendingGateResolve = undefined;
      resolve("declined");
    }
    this.consentGateProvider = provider;
  }

  private async handleConsentGate(params: Tier3ConsentParams): Promise<"approved" | "declined" | "timeout"> {
    // S4: no provider means the user hasn't configured a cloud provider, not that they declined.
    // Return "declined" so the orchestrator treats the gate as unanswered (no API call).
    if (!this.consentGateProvider) return "declined";

    // B5: the host enforces the 5-minute deadline independently of the UI countdown.
    const DEADLINE_MS = 5 * 60 * 1000;
    return new Promise<"approved" | "declined" | "timeout">((resolve) => {
      this.pendingGateResolve = resolve;

      const timer = setTimeout(() => {
        if (this.pendingGateResolve === resolve) {
          this.pendingGateResolve = undefined;
          resolve("timeout");
        }
      }, DEADLINE_MS);

      void this.consentGateProvider!(params)
        .then((decision) => {
          if (this.pendingGateResolve === resolve) {
            clearTimeout(timer);
            this.pendingGateResolve = undefined;
            resolve(decision);
          }
        })
        .catch(() => {
          if (this.pendingGateResolve === resolve) {
            clearTimeout(timer);
            this.pendingGateResolve = undefined;
            resolve("declined");
          }
        });
    });
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
    if (this.stopping) throw new VisibilityHostError("runtime is stopping");
    return this.service.runSite(site.id);
  }

  /** The user cleared the wall: re-verify the lease, then let the runner re-observe the page. */
  resume(): boolean {
    return this.service.resumeHandoff();
  }

  abort(): void {
    // B5: resolve any pending consent gate as "declined" before aborting the run.
    if (this.pendingGateResolve) {
      const resolve = this.pendingGateResolve;
      this.pendingGateResolve = undefined;
      resolve("declined");
    }
    this.service.abortRun();
  }

  /** User-initiated lock: stop, release the lease, save, then drop the key. */
  async lock(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    try {
      await this.stop(true);
      this.options.session.lock();
    } finally {
      this.stopping = false;
    }
  }

  /** Panel closing: abort, release the lease and save best-effort, then drop the key. */
  async shutdown(): Promise<void> {
    this.stopping = true;
    this.stopStateWatch();
    this.stopCloudStateWatch();
    this.service.abortRun();
    void this.options.leaseClient.releaseLease();
    const saving = this.options.session.state === "unlocked" ? this.options.session.save() : undefined;
    // save() snapshots synchronously; discard live plaintext immediately while
    // retaining the single-writer Web Lock until the pending write settles.
    this.options.session.lock();
    this.options.leaseClient.close();
    try {
      await saving;
    } finally {
      this.options.session.close();
    }
  }

  private onSessionState(state: string): void {
    if (state === "unlocked") {
      if (this.bound) return;
      this.service.setDomain(new DomainService(this.options.session.vault));
      this.bound = true;
      // Fire-and-forget: drain the queue now that the vault is unlocked.
      if (this.options.deliveryClient) {
        deliverQueue(this.options.session, this.options.deliveryClient).catch(() => {
          /* Queue delivery errors are non-fatal; items persist for the next attempt. */
        });
      }
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
    await this.service.waitForActiveRunCompletion();
    await this.options.leaseClient.releaseLease();
    if (save && this.options.session.state === "unlocked") {
      await this.options.session.save();
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
