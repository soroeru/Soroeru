// SoroeruSession: the trusted main-process owner of the Vault v2 lifecycle and
// DomainService (RFC-002 §2.1 / §3). It is the only thing that holds the
// decrypted vault and canonical values; the renderer reaches it solely through
// the typed IPC bridge, which returns sanitized views.
//
// This module is framework-free (no electron import) so it is unit-testable.
// It never logs decrypted values.

import { dirname, join } from "node:path";
import { AiEngine as AiEngineImpl, type RedactionValueSource } from "../src/automation/ai-engine.js";
import { aiProviderFromEnv, type AiProvider } from "../src/agent/ai/provider.js";
import type { AiEngine } from "../src/automation/decision-engine.js";
import { DomainService } from "../src/domain/domain-service.js";
import { FileVaultPersistence } from "../src/store/file-vault-persistence.js";
import { VaultV2 } from "../src/store/vault-v2.js";
import { vaultExists } from "../src/store/vault.js";
import { LedgerAppService } from "../src/app/ledger-app-service.js";
import type { SiteAccount } from "../src/domain/entities.js";
import type { SiteSession } from "../src/automation/page-driver.js";
import type { ChromeBridgeTransport } from "../src/automation/extension-page-driver.js";
import { openExtensionTabSession } from "../src/automation/extension-page-driver.js";
import { VisibilityService } from "../src/automation/visibility-service.js";
import { playwrightSavedPageRenderer } from "../src/automation/saved-page-importer.js";
import { FileLogger } from "../src/logging/file-logger.js";
import type { LogFields, LogLevel, Logger } from "../src/logging/logger.js";
import {
  MIN_PASSPHRASE_LENGTH,
  type ChromeBridgeConfigurationMutationResult,
  type ChromeBridgeConfigurationView,
} from "./ipc/contract.js";
import {
  isValidChromeExtensionId,
  type ChromeBridgeResolvedSettings,
  type ChromeBridgeSettingsInput,
  type ChromeBridgeStoredSettings,
} from "./chrome-bridge-settings.js";
import {
  nativeHostIsRegistered,
  registerNativeHost,
  unregisterNativeHost,
  type NativeHostPaths,
} from "../native-host/registration.js";
import type {
  ConfirmDynamicAttributeCandidateRequest,
  ConfirmDynamicAttributeCandidateResult,
  CsvImportResult,
  DeleteSiteAccountRequest,
  DeleteSiteAccountResultView,
  DomainSummary,
  LedgerInsights,
  LogsExportResult,
  RecoveryKeyResult,
  RevealResult,
  SavedPageImportRequest,
  SavedPageImportResult,
  SessionPersistenceMutationResult,
  SetSessionPersistenceRequest,
  SiteLedgerDetail,
  SiteLedgerSummary,
  UpdateSiteCredentialRequest,
  UpdateSiteCredentialResultView,
  VaultMutationResult,
  VaultStatus,
  VisibilityEvent,
  VisibilityHandoffAck,
  VisibilityRunResultView,
  VisibilityStatusView,
} from "./ipc/contract.js";

/** The minimal BrowserEngine surface `defaultOpenSession` depends on. */
export interface SessionEngine {
  openSession: (site: SiteAccount, options?: { storageState?: string }) => Promise<SiteSession>;
  closeAll: () => Promise<void>;
}

/** Construction-time hooks; production defaults to a lazily-created headed BrowserEngine. */
export interface SoroeruSessionOptions {
  /** Override how a per-site browser session is opened (tests / scripted E2E). */
  openSession?: (site: SiteAccount) => Promise<SiteSession>;
  /**
   * Inject a fake `SessionEngine` in place of the real (lazily-created)
   * BrowserEngine, so tests can exercise the default persistence-aware opener
   * (`defaultOpenSession` / `wrapSessionForPersistence`, Issue #294) without
   * driving real Playwright. Ignored when `openSession` is also provided.
   */
  engine?: SessionEngine;
  /** Tear down an injected engine on shutdown (paired with a custom `openSession`). */
  closeEngine?: () => Promise<void>;
  /** Open a URL in the user's default browser (injected by Electron main). */
  openExternal?: (url: string) => Promise<void>;
  /** Max chained wall hand-offs before a run gives up. */
  maxHandoffs?: number;
  /**
   * Inject a fake AI fallback (tests only) in place of the production
   * lazy-per-unlock construction from `aiProviderFromEnv()` (Issue #310).
   * When provided, it is used for the lifetime of this session and is never
   * rebuilt or cleared on lock/unlock — that reset behavior is specific to
   * the production `.env`-sourced instance.
   */
  aiEngine?: AiEngine;
  /**
   * Override how the production per-unlock `AiEngine` sources its `AiProvider`
   * (tests only). Defaults to `aiProviderFromEnv`; injecting a fake provider
   * here exercises the real `refreshAiEngine()` → `AiEngineImpl` construction
   * path without real network egress. Ignored when `aiEngine` is also
   * provided (that override bypasses `refreshAiEngine()` entirely).
   */
  aiProviderFactory?: () => AiProvider | undefined;
  /**
   * Plain-text diagnostics log sink (Issue #314). Defaults to a `FileLogger`
   * at `logPath`, so the local test suite (which constructs many sessions
   * against tmpdirs) gets real-but-harmless log files alongside the vault;
   * inject a fake here to assert on log calls without touching disk.
   */
  logger?: Logger;
  /** Override where the default `FileLogger` writes (tests only). Defaults to a `logs/` dir next to the vault file. */
  logPath?: string;
  /**
   * Developer-only Chrome extension bridge (Issue #338). When set and
   * `SOROERU_CHROME_BRIDGE_TAB_ID` is a positive integer, Visibility uses
   * ExtensionPageDriver against that bound tab instead of Playwright.
   * Renderer tab-selection UI is a later Issue (#339).
   */
  chromeBridge?: ChromeBridgeTransport & {
    openTabSession?: (tabId: number, options?: { siteDomain?: string }) => SiteSession;
    start?: () => Promise<void>;
    close?: () => Promise<void>;
    stopImmediately?: () => Promise<void>;
  };
  /** Developer-only install inputs. Absent when the feature flag is off. */
  chromeBridgeSetup?: {
    sourceBinary: string;
    extensionId: string;
    paths: NativeHostPaths;
  };
  /** Non-sensitive local bridge configuration loaded before session construction. */
  chromeBridgeSettings?: {
    initial: ChromeBridgeResolvedSettings;
    save: (input: ChromeBridgeSettingsInput) => Promise<ChromeBridgeStoredSettings>;
  };
}

export class SoroeruSession {
  private vault: VaultV2 | undefined;
  private domain: DomainService | undefined;
  private readonly visibility: VisibilityService;
  /** Lazily-created real engine in production; a test-injected `SessionEngine` otherwise. */
  private engine: SessionEngine | undefined;
  private readonly closeInjectedEngine: (() => Promise<void>) | undefined;
  private readonly openExternal: ((url: string) => Promise<void>) | undefined;
  private eventSink: ((event: VisibilityEvent) => void) | undefined;
  private collectionRunning = false;
  /** Vault-backed ledger/import/reveal handlers shared with the extension Side Panel (Issue #569). */
  private readonly ledger: LedgerAppService;
  /** True when a test injected `SoroeruSessionOptions.aiEngine` directly (skips the per-unlock lazy rebuild/clear below). */
  private readonly aiEngineOverride: boolean;
  /** `aiProviderFromEnv` in production; test-injectable via `SoroeruSessionOptions.aiProviderFactory`. */
  private readonly aiProviderFactory: () => AiProvider | undefined;
  /** Where the plain-text diagnostics log lives on disk, regardless of which `Logger` is injected (Issue #314). */
  private readonly logPath: string;
  private readonly logger: Logger;
  /** Optional Chrome extension bridge for the developer-only extension automation path (Issue #338). */
  private readonly chromeBridge:
    | (ChromeBridgeTransport & {
        openTabSession?: (tabId: number, options?: { siteDomain?: string }) => SiteSession;
        start?: () => Promise<void>;
        close?: () => Promise<void>;
        stopImmediately?: () => Promise<void>;
      })
    | undefined;
  private readonly chromeBridgeSetup: SoroeruSessionOptions["chromeBridgeSetup"];
  private readonly chromeBridgeSettings: SoroeruSessionOptions["chromeBridgeSettings"];
  private chromeBridgeStoredSettings: ChromeBridgeStoredSettings | undefined;
  private selectedChromeTab: { tabId: number; origin: string } | undefined;
  /**
   * Local-only value source for AI-prompt redaction (Issue #310, design §8):
   * canonical Personal Attribute values, read fresh on every call so lock/
   * unlock state is always reflected. Never logged, never sent as-is — only
   * matched against locally before a prompt is built (ai-engine.ts `redact`).
   */
  private readonly redactionSource: RedactionValueSource = {
    currentValues: () => this.domain?.listPersonalAttributes().map((attr) => attr.value) ?? [],
  };

  constructor(
    private readonly vaultPath: string,
    options: SoroeruSessionOptions = {},
  ) {
    this.engine = options.engine;
    this.closeInjectedEngine = options.closeEngine;
    this.openExternal = options.openExternal;
    this.chromeBridge = options.chromeBridge;
    this.chromeBridgeSetup = options.chromeBridgeSetup;
    this.chromeBridgeSettings = options.chromeBridgeSettings;
    this.chromeBridgeStoredSettings = options.chromeBridgeSettings?.initial.stored;
    this.aiEngineOverride = options.aiEngine !== undefined;
    this.aiProviderFactory = options.aiProviderFactory ?? aiProviderFromEnv;
    this.logPath = options.logPath ?? join(dirname(vaultPath), "logs", "soroeru.log");
    this.logger = options.logger ?? new FileLogger(this.logPath);
    this.ledger = new LedgerAppService({
      context: () => (this.vault && this.domain ? { vault: this.vault, domain: this.domain } : undefined),
      acquireCollection: () => {
        if (this.collectionRunning) return undefined;
        this.collectionRunning = true;
        return () => {
          this.collectionRunning = false;
        };
      },
      collectionBusy: () => this.collectionRunning,
      savedPageRenderer: playwrightSavedPageRenderer,
      logger: this.logger,
    });
    const openSession = options.openSession ?? ((site: SiteAccount) => this.defaultOpenSession(site));
    this.visibility = new VisibilityService({
      openSession,
      emit: (event) => this.eventSink?.(event),
      logger: this.logger,
      ...(options.maxHandoffs !== undefined ? { maxHandoffs: options.maxHandoffs } : {}),
      ...(options.aiEngine !== undefined ? { aiEngine: options.aiEngine } : {}),
    });
  }

  /**
   * Production-only: (re)build the `.env`-sourced AI fallback for the vault
   * session that just unlocked (Issue #310). A fresh `AiEngine` means a fresh
   * per-site call budget and consecutive-failure breaker for this session,
   * matching its "one instance per run" lifecycle (design §8). No-op when a
   * test supplied `SoroeruSessionOptions.aiEngine` directly, and silently
   * absent (rules-only, today's behavior) when no provider is configured.
   *
   * This is a deliberately minimal, dev/manual-verification-only mechanism:
   * it activates as soon as `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` is present
   * in the environment, with no settings-level user consent gate. It is not
   * the eventual production "AI mode" toggle (a real encrypted `ProviderConfig`
   * settings store is separate, deferred scope — see Issue #310's Non-Scope).
   */
  private refreshAiEngine(): void {
    if (this.aiEngineOverride) return;
    const provider = this.aiProviderFactory();
    this.visibility.setCollectionProvider(provider);
    if (!provider) {
      this.visibility.setAiEngine(undefined);
      return;
    }
    // `AiConsultationLog` (ai-engine.ts) is a closed, structural type — kind /
    // url (origin+path only) / providerId / latencyMs / outcome — with no
    // prompt/response/value field to ever accidentally log; that guarantee is
    // enforced and tested at ai-engine.ts's own sentinel tests, not here.
    this.visibility.setAiEngine(
      new AiEngineImpl(provider, this.redactionSource, {}, (log) => console.log("[ai-engine]", log)),
    );
  }

  /** Register the main-process sink that forwards Visibility events to the renderer. */
  setVisibilityEventSink(sink: (event: VisibilityEvent) => void): void {
    this.eventSink = sink;
  }

  /** Default production session opener: a headed Chromium BrowserEngine, created on first use. */
  private async defaultOpenSession(site: SiteAccount): Promise<SiteSession> {
    const extensionSession = this.tryOpenExtensionSession(site);
    if (extensionSession) return extensionSession;

    if (!this.engine) {
      // Dynamic import keeps Playwright out of the module graph until a run starts.
      const { BrowserEngine } = await import("../src/automation/browser-engine.js");
      this.engine = new BrowserEngine();
    }
    const persisted = site.persistSessionEnabled ? this.domain?.getPersistedSessionState(site.id) : undefined;
    // getPersistedSessionState() discards an expired record in-memory as a side
    // effect; flush that discard now so a stale encrypted session blob does not
    // keep living on disk past its documented expiry until some unrelated save.
    if (site.persistSessionEnabled) await this.vault?.save();
    const session = await this.engine.openSession(
      site,
      persisted ? { storageState: persisted.storageState } : undefined,
    );
    return this.wrapSessionForPersistence(site, session);
  }

  /**
   * Developer-only extension path (Issue #338): when the bridge is injected and
   * `SOROERU_CHROME_BRIDGE_TAB_ID` names a positive tab id, open an
   * ExtensionPageDriver session. No storageState export — real-profile sessions
   * are never sucked out (design §4 / §5). Returns undefined to keep Playwright.
   */
  private tryOpenExtensionSession(site: SiteAccount): SiteSession | undefined {
    const bridge = this.chromeBridge;
    if (!bridge) return undefined;
    const raw = process.env["SOROERU_CHROME_BRIDGE_TAB_ID"];
    const tabId = this.selectedChromeTab?.tabId ?? Number(raw);
    if (!this.selectedChromeTab && (!raw || raw.length === 0)) return undefined;
    if (!Number.isInteger(tabId) || tabId < 1) {
      throw new Error("SOROERU_CHROME_BRIDGE_TAB_ID must be a positive integer");
    }
    if (!bridge.isConnected()) {
      throw new Error("chrome bridge not connected");
    }
    if (bridge.openTabSession) return bridge.openTabSession(tabId, { siteDomain: site.domain });
    return openExtensionTabSession(bridge, { tabId, siteDomain: site.domain });
  }

  async chromeBridgeStatus() {
    return {
      enabled: this.chromeBridge !== undefined,
      registered: this.chromeBridgeSetup ? await nativeHostIsRegistered(this.chromeBridgeSetup.paths) : false,
      connected: this.chromeBridge?.isConnected() ?? false,
      ...(this.selectedChromeTab ? { selectedTab: this.selectedChromeTab } : {}),
    };
  }

  async chromeBridgeConfiguration(): Promise<ChromeBridgeConfigurationView> {
    const initial = this.chromeBridgeSettings?.initial;
    const stored = this.chromeBridgeStoredSettings ?? {
      version: 1 as const,
      enabled: false,
      extensionId: "",
    };
    const effective = initial?.effective ?? {
      enabled: false,
      extensionId: "",
      enabledSource: "default" as const,
      extensionIdSource: "default" as const,
    };
    const restartRequired =
      (effective.enabledSource !== "environment" && stored.enabled !== effective.enabled) ||
      (effective.extensionIdSource !== "environment" && stored.extensionId !== effective.extensionId);
    return {
      stored: { enabled: stored.enabled, extensionId: stored.extensionId },
      effective,
      restartRequired,
      ...(initial?.validationError ? { validationError: initial.validationError } : {}),
    };
  }

  async setChromeBridgeConfiguration(request: unknown): Promise<ChromeBridgeConfigurationMutationResult> {
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      return { ok: false, error: "invalid-request" };
    }
    const input = request as Record<string, unknown>;
    if (
      Object.keys(input).some((key) => key !== "enabled" && key !== "extensionId") ||
      typeof input["enabled"] !== "boolean" ||
      typeof input["extensionId"] !== "string"
    ) {
      return { ok: false, error: "invalid-request" };
    }
    if (!this.chromeBridgeSettings) {
      return { ok: false, error: "settings-unavailable" };
    }
    const enabled = input["enabled"];
    const extensionId = input["extensionId"];
    if (
      (extensionId !== "" && !isValidChromeExtensionId(extensionId)) ||
      (enabled && !isValidChromeExtensionId(extensionId))
    ) {
      return { ok: false, error: "invalid-extension-id" };
    }
    const { effective } = this.chromeBridgeSettings.initial;
    const stored = this.chromeBridgeStoredSettings ?? this.chromeBridgeSettings.initial.stored;
    if (
      (effective.enabledSource === "environment" && enabled !== stored.enabled) ||
      (effective.extensionIdSource === "environment" && extensionId !== stored.extensionId)
    ) {
      return { ok: false, error: "environment-override" };
    }
    if (effective.enabled && !enabled) {
      const status = await this.chromeBridgeStatus();
      if (status.registered || status.connected) {
        const cleanup = await this.disconnectChromeBridge();
        if (
          !cleanup.ok ||
          cleanup.permissionsCleanupUnknown ||
          (cleanup.manualCleanupOrigins?.length ?? 0) > 0
        ) {
          return { ...cleanup, ok: false, error: "cleanup-incomplete" };
        }
      } else {
        try {
          await this.chromeBridge?.close?.();
        } catch {
          return { ok: false, error: "cleanup-incomplete" };
        }
      }
    }
    try {
      this.chromeBridgeStoredSettings = await this.chromeBridgeSettings.save({ enabled, extensionId });
      return { ok: true, configuration: await this.chromeBridgeConfiguration() };
    } catch {
      return { ok: false, error: "persistence-failed" };
    }
  }

  async connectChromeBridge() {
    if (!this.chromeBridge || !this.chromeBridgeSetup) return { ok: false, error: "feature-disabled" };
    const configuration = await this.chromeBridgeConfiguration();
    if (configuration.restartRequired && !configuration.stored.enabled) {
      return { ok: false, error: "restart-required" };
    }
    // Prefer the latest stored ID when not environment-overridden. Setup is
    // fixed at process start; registering the startup ID after the user saved a
    // different extension ID leave Chrome's allowlist mismatched and the
    // service worker stuck OFFLINE (connectNative refused).
    const extensionId =
      configuration.effective.extensionIdSource === "environment"
        ? configuration.effective.extensionId
        : configuration.stored.extensionId || this.chromeBridgeSetup.extensionId;
    if (!isValidChromeExtensionId(extensionId)) {
      return { ok: false, error: "invalid-extension-id" };
    }
    try {
      this.log("info", "chrome-bridge", "registering native host", {
        hasSourceBinary: !!this.chromeBridgeSetup.sourceBinary,
        hasExtensionId: true,
        hasPaths: !!this.chromeBridgeSetup.paths,
      });
      await registerNativeHost(
        this.chromeBridgeSetup.sourceBinary,
        extensionId,
        this.chromeBridgeSetup.paths,
      );
      this.log("info", "chrome-bridge", "native host registered successfully");
      this.log("info", "chrome-bridge", "starting chrome bridge");
      await this.chromeBridge.start?.();
      this.log("info", "chrome-bridge", "chrome bridge started successfully");
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const reason = message.includes("extensionId must be a 32-character")
        ? "invalid-extension-id"
        : message.includes("Node.js runtime not found")
          ? "node-not-found"
          : "registration-failed";
      this.log("error", "chrome-bridge", "native host registration failed", {
        reason,
        hasSourceBinary: !!this.chromeBridgeSetup.sourceBinary,
        hasExtensionId: true,
        hasPaths: !!this.chromeBridgeSetup.paths,
      });
      return { ok: false, error: "registration-failed" };
    }
  }

  async disconnectChromeBridge() {
    if (!this.chromeBridge || !this.chromeBridgeSetup) return { ok: false, error: "feature-disabled" };
    const manualCleanupOrigins: string[] = [];
    let permissionsCleanupUnknown = false;
    this.log("info", "chrome-bridge", "disconnecting chrome bridge");
    try {
      const response = (await this.chromeBridge.sendCommand("listPermissions")) as { origins?: string[] };
      const approvedOrigins = (response.origins ?? [])
        .map(normalizeChromePermissionOrigin)
        .filter((origin): origin is string => origin !== undefined);
      for (const origin of approvedOrigins) {
        try {
          const removal = (await this.chromeBridge.sendCommand("removePermission", { origin })) as {
            removed?: boolean;
          };
          if (removal.removed !== true) manualCleanupOrigins.push(origin);
        } catch {
          manualCleanupOrigins.push(origin);
        }
      }
    } catch (err) {
      // If Chrome is gone, extension-owned permissions require manual cleanup.
      permissionsCleanupUnknown = true;
      this.log("warn", "chrome-bridge", "failed to list/remove permissions during disconnect", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    let cleanupFailed = false;
    try {
      await this.chromeBridge.close?.();
      this.log("info", "chrome-bridge", "chrome bridge closed");
    } catch (err) {
      cleanupFailed = true;
      this.log("error", "chrome-bridge", "failed to close chrome bridge", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      await unregisterNativeHost(this.chromeBridgeSetup.paths);
      this.log("info", "chrome-bridge", "native host unregistered successfully");
    } catch (err) {
      cleanupFailed = true;
      this.log("error", "chrome-bridge", "failed to unregister native host", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    this.selectedChromeTab = undefined;
    return {
      ok: !cleanupFailed,
      ...(cleanupFailed ? { error: "cleanup-failed" } : {}),
      ...(manualCleanupOrigins.length ? { manualCleanupOrigins } : {}),
      ...(permissionsCleanupUnknown ? { permissionsCleanupUnknown: true } : {}),
    };
  }

  async chromeBridgePermissions() {
    if (!this.chromeBridge?.isConnected()) return { origins: [], error: "not-connected" };
    try {
      const result = (await this.chromeBridge.sendCommand("listPermissions")) as { origins?: string[] };
      return { origins: result.origins ?? [] };
    } catch {
      return { origins: [], error: "permission-read-failed" };
    }
  }

  async revokeChromeBridgeOrigin(origin: string) {
    if (!this.chromeBridge?.isConnected()) return { ok: false, error: "not-connected" };
    if (!isSafeChromeOrigin(origin)) return { ok: false, error: "invalid-origin" };
    try {
      const removal = (await this.chromeBridge.sendCommand("removePermission", { origin })) as {
        removed?: boolean;
      };
      return removal.removed === true ? { ok: true } : { ok: false, error: "permission-remove-failed" };
    } catch {
      return { ok: false, error: "permission-remove-failed" };
    }
  }

  async chromeBridgeActiveTab() {
    if (!this.chromeBridge?.isConnected()) return undefined;
    try {
      const tab = (await this.chromeBridge.sendCommand("activeTab")) as {
        tabId?: number;
        origin?: string;
      };
      if (!Number.isInteger(tab.tabId) || !tab.origin || !isSafeChromeOrigin(tab.origin)) return undefined;
      return { tabId: tab.tabId as number, origin: tab.origin };
    } catch {
      return undefined;
    }
  }

  async selectChromeBridgeTab(tabId: number) {
    const tab = await this.chromeBridgeActiveTab();
    if (!tab || tab.tabId !== tabId) return { ok: false, error: "tab-changed" };
    this.selectedChromeTab = tab;
    return { ok: true };
  }

  async stopChromeBridge() {
    this.selectedChromeTab = undefined;
    const stopExtension = this.chromeBridge?.isConnected()
      ? (this.chromeBridge.stopImmediately?.() ?? this.chromeBridge.sendCommand("stop")).catch(
          () => undefined,
        )
      : Promise.resolve();
    // Unconditional shrink: release the extension binding and abort the runner
    // concurrently, rather than waiting for the current command to unwind first.
    await Promise.all([stopExtension, this.abortVisibility()]);
    return { ok: true };
  }

  /**
   * Wrap a session's `close()` so that, when the site has opted into session
   * persistence (Issue #294), the current `storageState` is exported and saved
   * to the vault *before* the underlying context is disposed. Best-effort: an
   * export/save failure must never block session teardown, so it is swallowed
   * here rather than propagated.
   */
  private wrapSessionForPersistence(site: SiteAccount, session: SiteSession): SiteSession {
    return {
      page: session.page,
      // A class instance (the real PlaywrightSiteSession) declares these as
      // prototype methods, not own properties, so a plain `{ ...session }`
      // spread would silently drop them from the wrapper. Bind explicitly.
      ...(session.exportStorageState ? { exportStorageState: session.exportStorageState.bind(session) } : {}),
      close: async () => {
        try {
          if (this.domain?.getSiteAccount(site.id)?.persistSessionEnabled && session.exportStorageState) {
            const storageState = await session.exportStorageState();
            this.domain.savePersistedSessionState({ siteAccountId: site.id, storageState });
            await this.vault?.save();
          }
        } catch {
          // Best-effort persistence: never let an export/save failure block teardown.
        } finally {
          await session.close();
        }
      },
    };
  }

  async status(): Promise<VaultStatus> {
    return {
      exists: await vaultExists(this.vaultPath),
      locked: this.vault === undefined || this.vault.isLocked,
      hasRecoveryKey: this.vault?.hasRecoveryKey ?? false,
    };
  }

  /** First-run vault creation. Fails if a vault already exists at the path. */
  async setup(passphrase: string): Promise<VaultMutationResult> {
    if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
      this.logger.warn("vault", "setup rejected", { reason: "passphrase-too-short" });
      return { ok: false, locked: true, error: "passphrase-too-short" };
    }
    if (await vaultExists(this.vaultPath)) {
      this.logger.warn("vault", "setup rejected", { reason: "vault-already-exists" });
      return { ok: false, locked: true, error: "vault-already-exists" };
    }
    this.vault = await VaultV2.open(new FileVaultPersistence(this.vaultPath), passphrase);
    this.domain = new DomainService(this.vault);
    this.visibility.setDomain(this.domain);
    this.refreshAiEngine();
    await this.vault.save();
    this.logger.info("vault", "vault created");
    return { ok: true, locked: false };
  }

  /** Unlock an existing vault. A wrong passphrase fails GCM auth and is reported. */
  async unlock(passphrase: string): Promise<VaultMutationResult> {
    if (!(await vaultExists(this.vaultPath))) {
      this.logger.warn("vault", "unlock rejected", { reason: "vault-not-found" });
      return { ok: false, locked: true, error: "vault-not-found" };
    }
    try {
      this.vault = await VaultV2.open(new FileVaultPersistence(this.vaultPath), passphrase);
      this.domain = new DomainService(this.vault);
      if (this.domain.ensureSiteAccountSortOrders()) await this.vault.save();
      this.visibility.setDomain(this.domain);
      this.refreshAiEngine();
      this.logger.info("vault", "vault unlocked");
      return { ok: true, locked: false };
    } catch {
      // Do not surface the underlying error: it must not leak vault internals.
      this.vault = undefined;
      this.domain = undefined;
      this.logger.warn("vault", "unlock failed", { reason: "unlock-failed" });
      return { ok: false, locked: true, error: "unlock-failed" };
    }
  }

  /** Unlock an existing vault with its recovery key instead of the passphrase (RFC-002 §6). */
  async unlockWithRecoveryKey(recoveryKey: string): Promise<VaultMutationResult> {
    if (!(await vaultExists(this.vaultPath))) {
      this.logger.warn("vault", "recovery unlock rejected", { reason: "vault-not-found" });
      return { ok: false, locked: true, error: "vault-not-found" };
    }
    try {
      this.vault = await VaultV2.openWithRecoveryKey(new FileVaultPersistence(this.vaultPath), recoveryKey);
      this.domain = new DomainService(this.vault);
      if (this.domain.ensureSiteAccountSortOrders()) await this.vault.save();
      this.visibility.setDomain(this.domain);
      this.refreshAiEngine();
      this.logger.info("vault", "vault unlocked with recovery key");
      return { ok: true, locked: false };
    } catch {
      // Wrong recovery key, or none configured: report uniformly, leak nothing.
      this.vault = undefined;
      this.domain = undefined;
      this.logger.warn("vault", "recovery unlock failed", { reason: "unlock-failed" });
      return { ok: false, locked: true, error: "unlock-failed" };
    }
  }

  lock(): VaultMutationResult {
    this.visibility.clearDomain();
    if (!this.aiEngineOverride) this.visibility.setAiEngine(undefined);
    this.vault?.lock();
    this.vault = undefined;
    this.domain = undefined;
    this.logger.info("vault", "vault locked");
    return { ok: true, locked: true };
  }

  // --- Visibility run (auto-login / collection, RFC-002 §5.1 / §5.2) ---

  /** Run Visibility collection for one site in a headed browser. Counts-only result. */
  async runVisibility(siteAccountId: string): Promise<VisibilityRunResultView> {
    if (this.collectionRunning) {
      return { siteAccountId, status: "busy", disclosures: 0, relationships: 0, constraints: 0 };
    }
    this.collectionRunning = true;
    try {
      return await this.visibility.runSite(siteAccountId);
    } finally {
      this.collectionRunning = false;
      // A run mutates the domain even on failure or an escaped throw (Constraint /
      // Evidence records), and VaultV2 holds records in memory only — flush so the
      // collected ledger survives lock/quit instead of silently vanishing.
      await this.vault?.save();
    }
  }

  /** Resume the active run after the user cleared a wall in the headed session. */
  resumeVisibility(): VisibilityHandoffAck {
    return this.visibility.resumeHandoff() ? { ok: true } : { ok: false, error: "no-active-handoff" };
  }

  /** Cancel the active Visibility run; it never bypasses a wall. */
  abortVisibility(): VisibilityHandoffAck {
    return this.visibility.abortRun() ? { ok: true } : { ok: false, error: "no-active-run" };
  }

  visibilityStatus(): VisibilityStatusView {
    return this.visibility.status();
  }

  /**
   * Orderly teardown for app quit (RFC-002 §5.2): stop any paused hand-off,
   * close every Playwright session + the browser (no orphan process), and lock
   * the vault (drop the derived key and decrypted records from memory).
   */
  async shutdown(): Promise<void> {
    this.visibility.abortRun();
    // Let an in-flight persisted-session export finish before the engine (and
    // its browser process) is torn down out from under it (Issue #294).
    await this.visibility.waitForActiveSessionClose();
    if (this.engine) {
      await this.engine.closeAll();
      this.engine = undefined;
    } else if (this.closeInjectedEngine) {
      await this.closeInjectedEngine();
    }
    this.lock();
  }

  /**
   * Generate a one-time recovery key for the unlocked vault and persist its
   * wrap. The plaintext is returned exactly once for immediate display and is
   * never logged or re-fetchable.
   */
  async generateRecoveryKey(): Promise<RecoveryKeyResult> {
    if (!this.vault || this.vault.isLocked) return { ok: false, error: "locked" };
    try {
      const recoveryKey = await this.vault.setupRecoveryKey();
      await this.vault.save();
      return { ok: true, recoveryKey };
    } catch {
      return { ok: false, error: "recovery-failed" };
    }
  }

  /** Build the sanitized domain summary. Returns a locked, empty view when locked. */
  domainSummary(): DomainSummary {
    return this.ledger.domainSummary();
  }

  // --- CSV import, saved pages, and the disclosure ledger (shared with the Side Panel, Issue #569) ---

  importCsv(data: string | Uint8Array): Promise<CsvImportResult> {
    return this.ledger.importCsv(data);
  }

  /**
   * Read the plain-text diagnostics log for the Settings tab's download button
   * (Issue #314). Unencrypted by design — this file never carries a raw
   * personal value, only operational/structural facts, so it is safe to read
   * whether the vault is locked or unlocked.
   */
  async exportLogs(): Promise<LogsExportResult> {
    try {
      // Reuse the injected logger when it is a real `FileLogger` (production,
      // and most tests) so this reads exactly what was logged through it;
      // only fall back to a fresh instance at `logPath` when a test injected
      // a non-`FileLogger` spy in `logger`'s place.
      const fileLogger = this.logger instanceof FileLogger ? this.logger : new FileLogger(this.logPath);
      const content = await fileLogger.read();
      const fileName = `soroeru-log-${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
      return { ok: true, fileName, content };
    } catch {
      return { ok: false, error: "read-failed" };
    }
  }

  /** Cross-cutting diagnostics entry point for main-process lifecycle/crash logging (Issue #314). */
  log(level: LogLevel, category: string, message: string, fields?: LogFields): void {
    this.logger[level](category, message, fields);
  }

  importSavedPage(request: SavedPageImportRequest): Promise<SavedPageImportResult> {
    return this.ledger.importSavedPage(request);
  }

  async openSiteInDefaultBrowser(
    siteAccountId: string,
  ): Promise<{ ok: boolean; url?: string; error?: string }> {
    const target = this.ledger.siteUrl(siteAccountId);
    if (!target.ok) return target;
    if (!this.openExternal) return { ok: false, error: "open-failed" };
    try {
      await this.openExternal(target.url);
      return { ok: true, url: target.url };
    } catch {
      return { ok: false, error: "open-failed" };
    }
  }

  markSavedPageManualCheck(siteAccountId: string): Promise<{ ok: boolean; error?: string }> {
    return this.ledger.markSavedPageManualCheck(siteAccountId);
  }

  ledgerSites(): SiteLedgerSummary[] {
    return this.ledger.ledgerSites();
  }

  ledgerInsights(): LedgerInsights {
    return this.ledger.ledgerInsights();
  }

  ledgerSite(siteAccountId: string): SiteLedgerDetail | undefined {
    return this.ledger.ledgerSite(siteAccountId);
  }

  ledgerSiteDetails(): SiteLedgerDetail[] {
    return this.ledger.ledgerSiteDetails();
  }

  reorderSiteAccounts(orderedIds: string[]): Promise<{ ok: boolean; error?: string }> {
    return this.ledger.reorderSiteAccounts(orderedIds);
  }

  confirmDynamicAttributeCandidate(
    request: ConfirmDynamicAttributeCandidateRequest,
  ): Promise<ConfirmDynamicAttributeCandidateResult> {
    return this.ledger.confirmDynamicAttributeCandidate(request);
  }

  deleteSiteAccount(request: DeleteSiteAccountRequest): Promise<DeleteSiteAccountResultView> {
    return this.ledger.deleteSiteAccount(request);
  }

  updateSiteCredential(request: UpdateSiteCredentialRequest): Promise<UpdateSiteCredentialResultView> {
    return this.ledger.updateSiteCredential(request);
  }

  setSessionPersistence(request: SetSessionPersistenceRequest): Promise<SessionPersistenceMutationResult> {
    return this.ledger.setSessionPersistence(request);
  }

  clearSessionPersistence(siteAccountId: string): Promise<SessionPersistenceMutationResult> {
    return this.ledger.clearSessionPersistence(siteAccountId);
  }

  revealValue(disclosureId: string, passphrase: string): Promise<RevealResult> {
    return this.ledger.revealValue(disclosureId, passphrase);
  }
}

function isSafeChromeOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value;
  } catch {
    return false;
  }
}

export function normalizeChromePermissionOrigin(pattern: string): string | undefined {
  try {
    const url = new URL(pattern.replace(/\/\*$/, "/"));
    return url.protocol === "https:" ? url.origin : undefined;
  } catch {
    return undefined;
  }
}
