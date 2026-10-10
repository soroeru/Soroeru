// Side Panel vault session (Issue #557, design #554 §4.1 / §6.1–§6.2,
// architecture §3.6).
//
// Owns the unlocked vault for one extension Side Panel:
//   - the master key is a non-extractable `CryptoKey` held only in this
//     object's memory; `lock()` / `close()` drop it, and closing the panel or
//     restarting the browser discards the page and therefore the key;
//   - an exclusive Web Lock makes the holding panel the single writer; a panel
//     that cannot take it reports "in use elsewhere" and never unlocks;
//   - recovery-key setup derives a short-lived extractable copy of the key only
//     to wrap it (VaultV2.setupRecoveryKey), then drops it;
//   - it tracks when an encrypted export should be offered, because IndexedDB
//     eviction or "clear site data" cannot be prevented.
// Portable: no `chrome.*`, `node:` or DOM-only APIs beyond the injected ones.

import { MIN_PASSPHRASE_LENGTH } from "../../electron/ipc/contract.js";
import type { KdfAlgo } from "./crypto.js";
import { VaultLockedError } from "./vault-errors.js";
import type { VaultPersistence } from "./vault-persistence.js";
import { VaultV2 } from "./vault-v2.js";

export const VAULT_WEB_LOCK_NAME = "soroeru-vault";

/** Saves since the last export after which an export is offered again (a "large change"). */
export const EXPORT_REMINDER_SAVE_COUNT = 20;

export type VaultSessionState =
  /** `start()` has not finished. */
  | "starting"
  /** Another Side Panel holds the vault lock. */
  | "in-use-elsewhere"
  /** No vault is stored yet: offer setup. */
  | "absent"
  | "locked"
  | "unlocked"
  /** Released by `close()`; the session cannot be reused. */
  | "closed";

/** A held exclusive lock; `release` is idempotent. */
export interface VaultLockHandle {
  release(): void;
}

/** Acquires the single-writer vault lock without waiting; `null` when another holder has it. */
export interface VaultLockManager {
  tryAcquire(): Promise<VaultLockHandle | null>;
}

export class VaultSessionStateError extends Error {
  constructor(
    readonly state: VaultSessionState,
    action: string,
  ) {
    super(`cannot ${action} while the vault session is ${state}`);
    this.name = "VaultSessionStateError";
  }
}

export class PassphraseTooShortError extends Error {
  constructor() {
    super(`passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`);
    this.name = "PassphraseTooShortError";
  }
}

export interface VaultSessionOptions {
  persistence: VaultPersistence;
  lockManager: VaultLockManager;
  kdfAlgo?: KdfAlgo;
}

export class VaultSession {
  private stateValue: VaultSessionState = "starting";
  private vaultValue: VaultV2 | null = null;
  private lockHandle: VaultLockHandle | null = null;
  private savesSinceExport = 0;
  private exportDue = false;
  private readonly listeners = new Set<(state: VaultSessionState) => void>();

  constructor(private readonly options: VaultSessionOptions) {}

  get state(): VaultSessionState {
    return this.stateValue;
  }

  /** True after vault creation or many saves since the last encrypted export. */
  get exportRecommended(): boolean {
    return this.exportDue;
  }

  /** The unlocked vault. Throws `VaultLockedError` unless the session is unlocked. */
  get vault(): VaultV2 {
    if (this.stateValue !== "unlocked" || !this.vaultValue) throw new VaultLockedError();
    return this.vaultValue;
  }

  onStateChange(listener: (state: VaultSessionState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Take the single-writer lock and inspect storage. Safe to call again from
   * `in-use-elsewhere` to retry. Unreadable stored data rejects (fail closed)
   * and leaves the session unusable rather than offering to create a new vault.
   */
  async start(): Promise<VaultSessionState> {
    if (this.stateValue !== "starting" && this.stateValue !== "in-use-elsewhere") {
      throw new VaultSessionStateError(this.stateValue, "start");
    }
    if (!this.lockHandle) {
      this.lockHandle = await this.options.lockManager.tryAcquire();
      if (!this.lockHandle) {
        this.setState("in-use-elsewhere");
        return this.stateValue;
      }
    }
    const stored = await this.options.persistence.load();
    this.setState(stored === null ? "absent" : "locked");
    return this.stateValue;
  }

  /**
   * Create a new vault, set up its recovery key, and save it. Returns the
   * recovery key for one-time display; the caller must not log or persist it.
   */
  async create(passphrase: string): Promise<string> {
    this.requireState("absent", "create a vault");
    if (passphrase.length < MIN_PASSPHRASE_LENGTH) throw new PassphraseTooShortError();
    // Never overwrite stored data that appeared since start() (fail closed).
    const existing = await this.options.persistence.load();
    this.requireState("absent", "create a vault");
    if (existing !== null) {
      this.setState("locked");
      throw new VaultSessionStateError("locked", "create a vault");
    }
    const vault = await VaultV2.open(this.options.persistence, passphrase, this.options.kdfAlgo ?? "argon2id", {
      extractableKey: false,
    });
    try {
      const recoveryKey = await vault.setupRecoveryKey(passphrase);
      // close() may have run during the KDF: never write after the Web Lock is released.
      this.requireState("absent", "create a vault");
      await vault.save();
      // ...or during the save: never resurrect a key on a closed panel.
      this.requireState("absent", "create a vault");
      this.vaultValue = vault;
      this.exportDue = true;
      this.savesSinceExport = 0;
      this.setState("unlocked");
      return recoveryKey;
    } catch (err) {
      vault.lock();
      throw err;
    }
  }

  async unlock(passphrase: string): Promise<void> {
    this.requireState("locked", "unlock");
    this.adopt(
      await VaultV2.open(this.options.persistence, passphrase, this.options.kdfAlgo ?? "argon2id", {
        extractableKey: false,
      }),
    );
  }

  async unlockWithRecoveryKey(recoveryKey: string): Promise<void> {
    this.requireState("locked", "unlock");
    this.adopt(
      await VaultV2.openWithRecoveryKey(this.options.persistence, recoveryKey, { extractableKey: false }),
    );
  }

  /** Persist the unlocked vault. A failure (e.g. quota) rejects; the previous stored version remains. */
  async save(): Promise<void> {
    await this.vault.save();
    this.savesSinceExport++;
    if (this.savesSinceExport >= EXPORT_REMINDER_SAVE_COUNT) this.exportDue = true;
  }

  /** Encrypted export (same shape as the stored document) for the user to keep elsewhere. */
  async exportEncrypted(): Promise<string> {
    const exported = await this.vault.exportEncrypted();
    this.exportDue = false;
    this.savesSinceExport = 0;
    return exported;
  }

  /** Drop the key and decrypted records. The Web Lock stays held so this panel can unlock again. */
  lock(): void {
    if (this.stateValue !== "unlocked") return;
    this.dropVault();
    this.setState("locked");
  }

  /** Lock and release the Web Lock (Side Panel closing). Idempotent. */
  close(): void {
    if (this.stateValue === "closed") return;
    this.dropVault();
    this.lockHandle?.release();
    this.lockHandle = null;
    this.setState("closed");
  }

  private adopt(vault: VaultV2): void {
    if (this.stateValue !== "locked") {
      // Closed while the KDF ran: do not resurrect a key on a closed panel.
      vault.lock();
      throw new VaultSessionStateError(this.stateValue, "unlock");
    }
    this.vaultValue = vault;
    this.setState("unlocked");
  }

  private dropVault(): void {
    this.vaultValue?.lock();
    this.vaultValue = null;
  }

  private requireState(expected: VaultSessionState, action: string): void {
    if (this.stateValue !== expected) throw new VaultSessionStateError(this.stateValue, action);
  }

  private setState(state: VaultSessionState): void {
    if (this.stateValue === state) return;
    this.stateValue = state;
    for (const listener of this.listeners) listener(state);
  }
}

/** Minimal `navigator.locks` surface used by `webLockManager`. */
export interface WebLocksLike {
  request(
    name: string,
    options: { mode: "exclusive"; ifAvailable: true },
    callback: (lock: unknown) => Promise<void> | void,
  ): Promise<unknown>;
}

/**
 * Exclusive Web Lock (`navigator.locks`) shared by every extension page of this
 * profile. The lock is held until `release()` or until the holding page closes
 * or crashes, which the browser releases automatically.
 */
export function webLockManager(locks: WebLocksLike, name: string = VAULT_WEB_LOCK_NAME): VaultLockManager {
  return {
    tryAcquire: () =>
      new Promise<VaultLockHandle | null>((resolve, reject) => {
        locks
          .request(name, { mode: "exclusive", ifAvailable: true }, (lock) => {
            if (lock === null) {
              resolve(null);
              return;
            }
            return new Promise<void>((releaseLock) => {
              let released = false;
              resolve({
                release: () => {
                  if (released) return;
                  released = true;
                  releaseLock();
                },
              });
            });
          })
          .catch(reject);
      }),
  };
}
