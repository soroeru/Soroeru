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
    [IPC_CHANNELS.vaultLock]: () => session.lock(),
    [IPC_CHANNELS.domainSummary]: () => session.domainSummary(),
  };
}
