// IPC bridge: maps each allowlisted channel to a main-process handler over a
// SoroeruSession (RFC-002 §3, §8.2). Built as a plain channel→handler record so
// it is unit-testable without launching Electron, and so the main process can
// register exactly these channels and nothing else.

import { IPC_CHANNELS, type IpcChannel } from "./contract.js";
import type { SoroeruSession } from "../session.js";

export type IpcHandler = (...args: unknown[]) => Promise<unknown> | unknown;

/**
 * Construct the complete handler table. The record is keyed by `IpcChannel`, so
 * TypeScript guarantees every allowlisted channel has a handler and no extra
 * channel can be added without a contract change.
 */
export function createIpcBridge(session: SoroeruSession): Record<IpcChannel, IpcHandler> {
  return {
    [IPC_CHANNELS.vaultStatus]: () => session.status(),
    [IPC_CHANNELS.vaultSetup]: (passphrase: unknown) => session.setup(String(passphrase ?? "")),
    [IPC_CHANNELS.vaultUnlock]: (passphrase: unknown) => session.unlock(String(passphrase ?? "")),
    [IPC_CHANNELS.vaultUnlockRecovery]: (recoveryKey: unknown) =>
      session.unlockWithRecoveryKey(String(recoveryKey ?? "")),
    [IPC_CHANNELS.vaultLock]: () => session.lock(),
    [IPC_CHANNELS.recoveryGenerate]: () => session.generateRecoveryKey(),
    [IPC_CHANNELS.domainSummary]: () => session.domainSummary(),
    [IPC_CHANNELS.csvImport]: (data: unknown) => session.importCsv(toCsvData(data)),
    [IPC_CHANNELS.ledgerSites]: () => session.ledgerSites(),
    [IPC_CHANNELS.ledgerSite]: (siteAccountId: unknown) => session.ledgerSite(String(siteAccountId ?? "")),
    [IPC_CHANNELS.ledgerInsights]: () => session.ledgerInsights(),
    [IPC_CHANNELS.revealValue]: (disclosureId: unknown, passphrase: unknown) =>
      session.revealValue(String(disclosureId ?? ""), String(passphrase ?? "")),
    [IPC_CHANNELS.visibilityRun]: (siteAccountId: unknown) =>
      session.runVisibility(String(siteAccountId ?? "")),
    [IPC_CHANNELS.visibilityResume]: () => session.resumeVisibility(),
    [IPC_CHANNELS.visibilityAbort]: () => session.abortVisibility(),
    [IPC_CHANNELS.visibilityStatus]: () => session.visibilityStatus(),
  };
}

/**
 * Coerce the renderer-supplied CSV payload into the importer's `string | Uint8Array`
 * shape. Structured clone may deliver an ArrayBuffer, a typed array, or text;
 * anything else becomes empty bytes (the importer then reports an empty CSV).
 */
function toCsvData(data: unknown): string | Uint8Array {
  if (typeof data === "string") return data;
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return new Uint8Array(0);
}
