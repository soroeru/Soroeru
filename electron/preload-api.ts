// The typed Soroeru API exposed to the renderer via contextBridge. Factored as
// a factory over an `invoke` function so it can be unit-tested with a fake
// invoke (RFC-002 §8.2): the test asserts the API only ever calls allowlisted
// channels and exposes exactly the intended method surface.
//
// The `invoke` parameter is typed to `IpcChannel`, so this module is
// structurally incapable of reaching a non-allowlisted channel.

import {
  IPC_CHANNELS,
  type ConfirmDynamicAttributeCandidateRequest,
  type ConfirmDynamicAttributeCandidateResult,
  type CsvImportResult,
  type DeleteSiteAccountRequest,
  type DeleteSiteAccountResultView,
  type DomainSummary,
  type IpcChannel,
  type LedgerInsights,
  type LogsExportResult,
  type RecoveryKeyResult,
  type SavedPageManualCheckResult,
  type SavedPageImportRequest,
  type SavedPageImportResult,
  type SavedPageOpenSiteResult,
  type RevealResult,
  type SessionPersistenceMutationResult,
  type SetSessionPersistenceRequest,
  type SiteLedgerDetail,
  type SiteLedgerSummary,
  type VaultMutationResult,
  type VaultStatus,
  type VisibilityEvent,
  type VisibilityHandoffAck,
  type VisibilityRunResultView,
  type VisibilityStatusView,
} from "./ipc/contract.js";

export type IpcInvoke = (channel: IpcChannel, ...args: unknown[]) => Promise<unknown>;

/** Subscribe to one-way Visibility events; returns an unsubscribe function. */
export type VisibilityEventSubscribe = (listener: (event: VisibilityEvent) => void) => () => void;

export interface SoroeruApi {
  vault: {
    status(): Promise<VaultStatus>;
    setup(passphrase: string): Promise<VaultMutationResult>;
    unlock(passphrase: string): Promise<VaultMutationResult>;
    unlockWithRecoveryKey(recoveryKey: string): Promise<VaultMutationResult>;
    lock(): Promise<VaultMutationResult>;
    generateRecoveryKey(): Promise<RecoveryKeyResult>;
  };
  domain: {
    summary(): Promise<DomainSummary>;
  };
  csv: {
    import(data: string | Uint8Array): Promise<CsvImportResult>;
  };
  savedPage: {
    import(request: SavedPageImportRequest): Promise<SavedPageImportResult>;
    openSite(siteAccountId: string): Promise<SavedPageOpenSiteResult>;
    markManualCheck(siteAccountId: string): Promise<SavedPageManualCheckResult>;
  };
  ledger: {
    sites(): Promise<SiteLedgerSummary[]>;
    site(siteAccountId: string): Promise<SiteLedgerDetail | undefined>;
    siteDetails(): Promise<SiteLedgerDetail[]>;
    insights(): Promise<LedgerInsights>;
    reveal(disclosureId: string, passphrase: string): Promise<RevealResult>;
    confirmDynamicCandidate(
      request: ConfirmDynamicAttributeCandidateRequest,
    ): Promise<ConfirmDynamicAttributeCandidateResult>;
    deleteSite(request: DeleteSiteAccountRequest): Promise<DeleteSiteAccountResultView>;
  };
  sessionPersistence: {
    set(request: SetSessionPersistenceRequest): Promise<SessionPersistenceMutationResult>;
    clear(siteAccountId: string): Promise<SessionPersistenceMutationResult>;
  };
  visibility: {
    run(siteAccountId: string): Promise<VisibilityRunResultView>;
    resume(): Promise<VisibilityHandoffAck>;
    abort(): Promise<VisibilityHandoffAck>;
    status(): Promise<VisibilityStatusView>;
    /** Subscribe to run progress / wall hand-off events; returns an unsubscribe function. */
    onEvent(listener: (event: VisibilityEvent) => void): () => void;
  };
  logs: {
    /** Read the plain-text diagnostics log (Settings tab download button). */
    export(): Promise<LogsExportResult>;
  };
}

export function createSoroeruApi(
  invoke: IpcInvoke,
  subscribeVisibility?: VisibilityEventSubscribe,
): SoroeruApi {
  return {
    vault: {
      status: () => invoke(IPC_CHANNELS.vaultStatus) as Promise<VaultStatus>,
      setup: (passphrase) => invoke(IPC_CHANNELS.vaultSetup, passphrase) as Promise<VaultMutationResult>,
      unlock: (passphrase) => invoke(IPC_CHANNELS.vaultUnlock, passphrase) as Promise<VaultMutationResult>,
      unlockWithRecoveryKey: (recoveryKey) =>
        invoke(IPC_CHANNELS.vaultUnlockRecovery, recoveryKey) as Promise<VaultMutationResult>,
      lock: () => invoke(IPC_CHANNELS.vaultLock) as Promise<VaultMutationResult>,
      generateRecoveryKey: () => invoke(IPC_CHANNELS.recoveryGenerate) as Promise<RecoveryKeyResult>,
    },
    domain: {
      summary: () => invoke(IPC_CHANNELS.domainSummary) as Promise<DomainSummary>,
    },
    csv: {
      import: (data) => invoke(IPC_CHANNELS.csvImport, data) as Promise<CsvImportResult>,
    },
    savedPage: {
      import: (request) => invoke(IPC_CHANNELS.savedPageImport, request) as Promise<SavedPageImportResult>,
      openSite: (siteAccountId) =>
        invoke(IPC_CHANNELS.savedPageOpenSite, siteAccountId) as Promise<SavedPageOpenSiteResult>,
      markManualCheck: (siteAccountId) =>
        invoke(IPC_CHANNELS.savedPageMarkManual, siteAccountId) as Promise<SavedPageManualCheckResult>,
    },
    ledger: {
      sites: () => invoke(IPC_CHANNELS.ledgerSites) as Promise<SiteLedgerSummary[]>,
      site: (siteAccountId) =>
        invoke(IPC_CHANNELS.ledgerSite, siteAccountId) as Promise<SiteLedgerDetail | undefined>,
      siteDetails: () => invoke(IPC_CHANNELS.ledgerSiteDetails) as Promise<SiteLedgerDetail[]>,
      insights: () => invoke(IPC_CHANNELS.ledgerInsights) as Promise<LedgerInsights>,
      reveal: (disclosureId, passphrase) =>
        invoke(IPC_CHANNELS.revealValue, disclosureId, passphrase) as Promise<RevealResult>,
      confirmDynamicCandidate: (request) =>
        invoke(
          IPC_CHANNELS.ledgerConfirmDynamicCandidate,
          request,
        ) as Promise<ConfirmDynamicAttributeCandidateResult>,
      deleteSite: (request) =>
        invoke(IPC_CHANNELS.ledgerDeleteSite, request) as Promise<DeleteSiteAccountResultView>,
    },
    sessionPersistence: {
      set: (request) =>
        invoke(IPC_CHANNELS.sessionPersistenceSet, request) as Promise<SessionPersistenceMutationResult>,
      clear: (siteAccountId) =>
        invoke(
          IPC_CHANNELS.sessionPersistenceClear,
          siteAccountId,
        ) as Promise<SessionPersistenceMutationResult>,
    },
    visibility: {
      run: (siteAccountId) =>
        invoke(IPC_CHANNELS.visibilityRun, siteAccountId) as Promise<VisibilityRunResultView>,
      resume: () => invoke(IPC_CHANNELS.visibilityResume) as Promise<VisibilityHandoffAck>,
      abort: () => invoke(IPC_CHANNELS.visibilityAbort) as Promise<VisibilityHandoffAck>,
      status: () => invoke(IPC_CHANNELS.visibilityStatus) as Promise<VisibilityStatusView>,
      onEvent: (listener) => subscribeVisibility?.(listener) ?? (() => {}),
    },
    logs: {
      export: () => invoke(IPC_CHANNELS.logsExport) as Promise<LogsExportResult>,
    },
  };
}
