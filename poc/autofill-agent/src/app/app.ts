// Local Playwright app shell (RFC-001 v3 §7, APP-001 / #43).
//
// Owns the lifecycle the UI and automation layers share: encrypted-store
// unlock/lock (including idle auto-lock) and Playwright browser instances.
// The UI <-> automation boundary is `AppRunner` (./runner.ts); neither module
// reaches into the agent/automation internals directly.

import type { Browser } from "playwright";
import { chromium, firefox, webkit } from "playwright";
import { join } from "node:path";
import { PocStore } from "../store/store.js";

export type EngineName = "chromium" | "firefox" | "webkit";

const ENGINES = { chromium, firefox, webkit } as const;

/** Default idle auto-lock timeout: 10 minutes. 0 disables idle auto-lock. */
export const DEFAULT_IDLE_LOCK_MS = 10 * 60 * 1000;

export class AutofillAppError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AutofillAppError";
  }
}

export type BrowserLauncher = (engine: EngineName, options?: { headless?: boolean }) => Promise<Browser>;

const defaultLauncher: BrowserLauncher = (engine, options) =>
  ENGINES[engine].launch({ headless: options?.headless ?? false });

export interface AutofillAppOptions {
  /** Local state directory; the encrypted store lives at `<stateDir>/store.json`. */
  stateDir: string;
  /** Idle auto-lock timeout in ms. 0 disables. Default: DEFAULT_IDLE_LOCK_MS. */
  idleLockMs?: number;
  /** Injectable browser launcher (tests substitute a fake `Browser`). */
  launchBrowserFn?: BrowserLauncher;
  /** Injectable timer (tests drive idle auto-lock without real delays). */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

/**
 * Local app shell: owns the encrypted store's unlock/lock lifecycle (incl.
 * idle auto-lock) and tracks Playwright browser instances so they can be
 * closed cleanly on shutdown. The UI and the automation runner (`AppRunner`)
 * both go through this shell rather than opening the store or launching
 * browsers directly.
 */
export class AutofillApp {
  private readonly idleLockMs: number;
  private readonly launchBrowserFn: BrowserLauncher;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;
  private idleHandle: unknown;
  private _store: PocStore | undefined;
  private readonly browsers = new Set<Browser>();

  readonly storeFilePath: string;

  constructor(options: AutofillAppOptions) {
    this.storeFilePath = join(options.stateDir, "store.json");
    this.idleLockMs = options.idleLockMs ?? DEFAULT_IDLE_LOCK_MS;
    this.launchBrowserFn = options.launchBrowserFn ?? defaultLauncher;
    this.setTimeoutFn = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((h) => clearTimeout(h as Parameters<typeof clearTimeout>[0]));
  }

  get isUnlocked(): boolean {
    return this._store !== undefined && !this._store.isLocked;
  }

  /**
   * Unlock (or create) the encrypted store with the master passphrase. A
   * wrong passphrase on an existing store fails AES-GCM authentication; the
   * shell never falls back to an unauthenticated read and instead fails
   * closed with `AutofillAppError`.
   */
  async unlock(passphrase: string): Promise<PocStore> {
    let store: PocStore;
    try {
      store = await PocStore.open(this.storeFilePath, passphrase);
    } catch (err) {
      throw new AutofillAppError("failed to unlock the store (wrong passphrase or corrupted store file)", {
        cause: err,
      });
    }
    this._store = store;
    this.resetIdleTimer();
    return store;
  }

  /**
   * Unlock the encrypted store with a recovery key instead of the passphrase
   * (SEC-003 / #44). Fails closed with `AutofillAppError` if no recovery key
   * was configured, or the given key does not unwrap the stored master key.
   */
  async unlockWithRecoveryKey(recoveryKey: string): Promise<PocStore> {
    let store: PocStore;
    try {
      store = await PocStore.openWithRecoveryKey(this.storeFilePath, recoveryKey);
    } catch (err) {
      throw new AutofillAppError("failed to unlock the store with the recovery key (invalid key or no recovery key configured)", {
        cause: err,
      });
    }
    this._store = store;
    this.resetIdleTimer();
    return store;
  }

  /** The unlocked store. Throws if `unlock()` has not been called or the store is locked. */
  get store(): PocStore {
    if (!this._store || this._store.isLocked) throw new AutofillAppError("store is not unlocked");
    return this._store;
  }

  /** Drop the derived key and all decrypted in-memory data (idle / explicit lock). */
  lock(): void {
    this._store?.lock();
    this.clearIdleTimer();
  }

  /** Reset the idle auto-lock timer. Call on user/agent activity. */
  touch(): void {
    if (!this._store || this._store.isLocked) return;
    this.resetIdleTimer();
  }

  private resetIdleTimer(): void {
    this.clearIdleTimer();
    if (this.idleLockMs <= 0) return;
    this.idleHandle = this.setTimeoutFn(() => this.lock(), this.idleLockMs);
  }

  private clearIdleTimer(): void {
    if (this.idleHandle !== undefined) {
      this.clearTimeoutFn(this.idleHandle);
      this.idleHandle = undefined;
    }
  }

  /** Launch a tracked Playwright browser. Closed automatically by `shutdown()`. */
  async launchBrowser(engine: EngineName, options?: { headless?: boolean }): Promise<Browser> {
    const browser = await this.launchBrowserFn(engine, options);
    this.browsers.add(browser);
    return browser;
  }

  /** Close a browser launched via `launchBrowser` and stop tracking it. */
  async closeBrowser(browser: Browser): Promise<void> {
    this.browsers.delete(browser);
    await browser.close();
  }

  /** Close every tracked browser and lock the store. Call on app shutdown. */
  async shutdown(): Promise<void> {
    for (const browser of [...this.browsers]) await this.closeBrowser(browser);
    this.lock();
  }
}
