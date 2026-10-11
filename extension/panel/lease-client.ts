/**
 * Side Panel client for the worker's lease protocol (Issue #558). It owns the long-lived
 * runtime port: it matches `lease.open` replies by nonce, tracks the lease epoch from
 * `page.event`, sends a keepalive while a lease is active so the MV3 worker is not suspended,
 * and reconnects with backoff. A dropped port means the worker restarted, so the lease and
 * every in-flight command fail with `worker-restarted`; the caller must open a new lease.
 */

import {
  EXTENSION_MESSAGE_VERSION,
  PANEL_PORT_NAME,
  parseExtensionMessage,
  type ExtensionMessage,
  type LeaseInvalidReason,
  type LeaseOpened,
  type PageCommand,
  type PageRejectedReason,
} from "../../src/shared/extension-messages.js";

export const KEEPALIVE_INTERVAL_MS = 20_000;
export const DEFAULT_OPEN_TIMEOUT_MS = 15_000;
export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;

export interface PortLike {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
}

export interface LeaseClientTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface LeaseClientDeps {
  connectPort: () => PortLike;
  timers?: LeaseClientTimers;
  newId?: () => string;
}

export interface LeaseOpenParams {
  tabId: number;
  origin: string;
  siteDomain?: string;
}

export interface ActiveLeaseInfo {
  leaseId: string;
  tabId: number;
  origin: string;
  siteDomain?: string;
  epoch: number;
  bootId: string;
}

/** The lease ended (or never started) for a protocol reason. */
export class LeaseInvalidatedError extends Error {
  constructor(readonly reason: LeaseInvalidReason) {
    super(`lease invalidated: ${reason}`);
    this.name = "LeaseInvalidatedError";
  }
}

/** The worker or content script refused a command. */
export class PageCommandRejectedError extends Error {
  constructor(readonly reason: PageRejectedReason) {
    super(`page command rejected: ${reason}`);
    this.name = "PageCommandRejectedError";
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: unknown;
}
interface PendingOpen {
  resolve: (lease: ActiveLeaseInfo) => void;
  reject: (error: Error) => void;
  timer: unknown;
}

const globalTimers: LeaseClientTimers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (callback, ms) => globalThis.setInterval(callback, ms),
  clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
};

export class LeaseClient {
  private readonly timers: LeaseClientTimers;
  private readonly newId: () => string;
  private port: PortLike | undefined;
  private lease: ActiveLeaseInfo | undefined;
  private keepaliveTimer: unknown;
  private reconnectTimer: unknown;
  private reconnectAttempts = 0;
  private closed = false;
  private readonly pending = new Map<string, Pending>();
  private readonly pendingOpens = new Map<string, PendingOpen>();
  private readonly invalidatedListeners = new Set<(reason: LeaseInvalidReason) => void>();
  private readonly eventListeners = new Set<(event: { epoch: number; url: string }) => void>();

  constructor(private readonly deps: LeaseClientDeps) {
    this.timers = deps.timers ?? globalTimers;
    this.newId = deps.newId ?? (() => crypto.randomUUID());
  }

  /** Open the port if it is not open. Safe to call repeatedly. */
  connect(): void {
    if (this.closed || this.port) return;
    const port = this.deps.connectPort();
    this.port = port;
    port.onMessage.addListener((raw) => this.onMessage(port, raw));
    port.onDisconnect.addListener(() => this.onDisconnect(port));
  }

  isConnected(): boolean {
    return this.port !== undefined;
  }

  isLeaseActive(): boolean {
    return this.lease !== undefined && this.port !== undefined;
  }

  currentLease(): ActiveLeaseInfo | undefined {
    return this.lease ? { ...this.lease } : undefined;
  }

  onInvalidated(listener: (reason: LeaseInvalidReason) => void): () => void {
    this.invalidatedListeners.add(listener);
    return () => this.invalidatedListeners.delete(listener);
  }

  onPageEvent(listener: (event: { epoch: number; url: string }) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /** Ask the worker for a lease on one tab. Rejects with LeaseInvalidatedError when refused. */
  openLease(params: LeaseOpenParams, timeoutMs: number = DEFAULT_OPEN_TIMEOUT_MS): Promise<ActiveLeaseInfo> {
    this.connect();
    const port = this.port;
    if (!port) return Promise.reject(new Error("lease client closed"));
    const nonce = this.newId();
    return new Promise<ActiveLeaseInfo>((resolve, reject) => {
      const timer = this.timers.setTimeout(() => {
        this.pendingOpens.delete(nonce);
        reject(new Error("lease open timed out"));
      }, timeoutMs);
      this.pendingOpens.set(nonce, { resolve, reject, timer });
      this.post(port, {
        version: EXTENSION_MESSAGE_VERSION,
        kind: "lease.open",
        nonce,
        tabId: params.tabId,
        origin: params.origin,
        ...(params.siteDomain === undefined ? {} : { siteDomain: params.siteDomain }),
      });
    });
  }

  /** Send one page command under the current lease and epoch. */
  sendPageCommand(command: PageCommand, options: { timeoutMs?: number } = {}): Promise<unknown> {
    const port = this.port;
    const lease = this.lease;
    if (!port || !lease) return Promise.reject(new LeaseInvalidatedError("worker-restarted"));
    const requestId = this.newId();
    return new Promise<unknown>((resolve, reject) => {
      const timer = this.timers.setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("page command timed out"));
      }, options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, reject, timer });
      this.post(port, {
        version: EXTENSION_MESSAGE_VERSION,
        kind: "page.command",
        requestId,
        leaseId: lease.leaseId,
        epoch: lease.epoch,
        command,
      });
    });
  }

  /** Release the active lease (the page banner is removed by the worker). */
  async releaseLease(): Promise<void> {
    const lease = this.lease;
    const port = this.port;
    if (!lease) return;
    this.clearLease();
    this.failPending(new LeaseInvalidatedError("released"));
    if (port)
      this.post(port, { version: EXTENSION_MESSAGE_VERSION, kind: "lease.release", leaseId: lease.leaseId });
  }

  /** Permanently close; no reconnect. */
  close(): void {
    this.closed = true;
    this.timers.clearTimeout(this.reconnectTimer);
    this.clearLease();
    this.failPending(new LeaseInvalidatedError("panel-closed"));
    const port = this.port;
    this.port = undefined;
    port?.disconnect();
  }

  private post(port: PortLike, message: unknown): void {
    try {
      port.postMessage(message);
    } catch {
      this.onDisconnect(port);
    }
  }

  private onMessage(port: PortLike, raw: unknown): void {
    if (port !== this.port) return;
    let message: ExtensionMessage;
    try {
      message = parseExtensionMessage(raw);
    } catch {
      return; // Ignore anything that is not a valid lease-protocol message.
    }
    this.reconnectAttempts = 0; // The worker answered, so the connection is healthy.
    switch (message.kind) {
      case "lease.opened":
        this.onOpened(message);
        return;
      case "lease.invalidated":
        this.onInvalidatedMessage(message.leaseId, message.reason);
        return;
      case "page.event":
        if (this.lease?.leaseId === message.leaseId && message.epoch >= this.lease.epoch) {
          this.lease.epoch = message.epoch;
          for (const listener of this.eventListeners) listener({ epoch: message.epoch, url: message.url });
        }
        return;
      case "page.result": {
        const entry = this.takePending(message.requestId);
        if (!entry) return;
        if (message.ok) entry.resolve(message.payload);
        else entry.reject(new Error(message.error ?? "page command failed"));
        return;
      }
      case "page.rejected": {
        const entry = this.takePending(message.requestId);
        entry?.reject(new PageCommandRejectedError(message.reason));
        return;
      }
      default:
        return;
    }
  }

  private onOpened(message: LeaseOpened): void {
    const entry = this.pendingOpens.get(message.nonce);
    if (!entry) return;
    this.pendingOpens.delete(message.nonce);
    this.timers.clearTimeout(entry.timer);
    this.lease = {
      leaseId: message.leaseId,
      tabId: message.tabId,
      origin: message.origin,
      ...(message.siteDomain === undefined ? {} : { siteDomain: message.siteDomain }),
      epoch: message.epoch,
      bootId: message.bootId,
    };
    this.startKeepalive();
    entry.resolve({ ...this.lease });
  }

  private onInvalidatedMessage(leaseId: string, reason: LeaseInvalidReason): void {
    // A refused open is keyed by its nonce because no lease id exists yet.
    const open = this.pendingOpens.get(leaseId);
    if (open) {
      this.pendingOpens.delete(leaseId);
      this.timers.clearTimeout(open.timer);
      open.reject(new LeaseInvalidatedError(reason));
      return;
    }
    if (this.lease?.leaseId !== leaseId) return;
    this.endLease(reason);
  }

  private onDisconnect(port: PortLike): void {
    if (port !== this.port) return;
    this.port = undefined;
    const hadLease = this.lease !== undefined;
    this.clearLease();
    const error = new LeaseInvalidatedError("worker-restarted");
    this.failPending(error);
    if (hadLease) for (const listener of this.invalidatedListeners) listener("worker-restarted");
    this.scheduleReconnect();
  }

  private endLease(reason: LeaseInvalidReason): void {
    this.clearLease();
    this.failPending(new LeaseInvalidatedError(reason));
    for (const listener of this.invalidatedListeners) listener(reason);
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempts, RECONNECT_MAX_MS);
    this.reconnectAttempts += 1;
    this.reconnectTimer = this.timers.setTimeout(() => {
      if (this.closed || this.port) return;
      try {
        this.connect();
      } catch {
        this.scheduleReconnect();
      }
    }, delay);
  }

  private startKeepalive(): void {
    this.timers.clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = this.timers.setInterval(() => {
      const port = this.port;
      if (port && this.lease) this.post(port, { version: EXTENSION_MESSAGE_VERSION, kind: "keepalive" });
    }, KEEPALIVE_INTERVAL_MS);
  }

  private clearLease(): void {
    this.lease = undefined;
    this.timers.clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = undefined;
  }

  private takePending(requestId: string): Pending | undefined {
    const entry = this.pending.get(requestId);
    if (!entry) return undefined;
    this.pending.delete(requestId);
    this.timers.clearTimeout(entry.timer);
    return entry;
  }

  private failPending(error: Error): void {
    for (const entry of this.pending.values()) {
      this.timers.clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    for (const entry of this.pendingOpens.values()) {
      this.timers.clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pendingOpens.clear();
  }
}

/** Production wiring: connect to the worker over chrome.runtime. */
export function createChromeLeaseClient(): LeaseClient {
  return new LeaseClient({ connectPort: () => chrome.runtime.connect({ name: PANEL_PORT_NAME }) });
}
