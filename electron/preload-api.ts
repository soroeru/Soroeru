// The typed Soroeru API exposed to the renderer via contextBridge. Factored as
// a factory over an `invoke` function so it can be unit-tested with a fake
// invoke (RFC-002 §8.2): the test asserts the API only ever calls allowlisted
// channels and exposes exactly the intended method surface.
//
// The `invoke` parameter is typed to `IpcChannel`, so this module is
// structurally incapable of reaching a non-allowlisted channel.

import {
  IPC_CHANNELS,
  type DomainSummary,
  type IpcChannel,
  type VaultMutationResult,
  type VaultStatus,
} from "./ipc/contract.js";

export type IpcInvoke = (channel: IpcChannel, ...args: unknown[]) => Promise<unknown>;

export interface SoroeruApi {
  vault: {
    status(): Promise<VaultStatus>;
    setup(passphrase: string): Promise<VaultMutationResult>;
    unlock(passphrase: string): Promise<VaultMutationResult>;
    lock(): Promise<VaultMutationResult>;
  };
  domain: {
    summary(): Promise<DomainSummary>;
  };
}

export function createSoroeruApi(invoke: IpcInvoke): SoroeruApi {
  return {
    vault: {
      status: () => invoke(IPC_CHANNELS.vaultStatus) as Promise<VaultStatus>,
      setup: (passphrase) => invoke(IPC_CHANNELS.vaultSetup, passphrase) as Promise<VaultMutationResult>,
      unlock: (passphrase) => invoke(IPC_CHANNELS.vaultUnlock, passphrase) as Promise<VaultMutationResult>,
      lock: () => invoke(IPC_CHANNELS.vaultLock) as Promise<VaultMutationResult>,
    },
    domain: {
      summary: () => invoke(IPC_CHANNELS.domainSummary) as Promise<DomainSummary>,
    },
  };
}
