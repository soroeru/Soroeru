// ExtensionPageDriver: PageDriver over the Chrome extension bridge (Issue #338,
// design issue-291 §5). VisibilityRunner / login / collection / wall-handoff /
// checkpoints stay surface-agnostic; this module only maps the narrow PageDriver
// contract onto timed bridge command round-trips against one bound tab.
//
// close() unbinds the session only — it never closes the user's tab.
// exportStorageState is intentionally unimplemented: the extension path must
// not export the real Chrome profile's session (#294 stays Playwright-only).

import type { PageSnapshot } from "../types.js";
import type { PageDriver, SiteSession } from "./page-driver.js";

/** Default per-command timeout so a hung extension/host never blocks the runner forever. */
export const DEFAULT_EXTENSION_COMMAND_TIMEOUT_MS = 30_000;

/**
 * Minimal transport the driver needs. Production uses ChromeExtensionBridge;
 * unit tests inject a scripted fake. The transport must not log or persist
 * payloads (values travel only as fill/read command bodies).
 */
export interface ChromeBridgeTransport {
  /**
   * Send one allowed command and wait for its matching result.
   * Rejects on transport disconnect, timeout, or `ok: false` result.
   * Returns the result payload (may be undefined when the command has none).
   */
  sendCommand(command: string, payload?: unknown, options?: { timeoutMs?: number }): Promise<unknown>;
  /** Whether a host/extension socket is currently authenticated and open. */
  isConnected(): boolean;
}

export interface ExtensionTabSessionOptions {
  /** Bound Chrome tab id (positive integer). */
  tabId: number;
  /** SiteAccount domain; permits this domain and its subdomains only. */
  siteDomain?: string;
  /** Override the per-command timeout (ms). */
  commandTimeoutMs?: number;
}

export class ExtensionBridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtensionBridgeError";
  }
}

/** PageDriver for one bound extension tab. */
export class ExtensionPageDriver implements PageDriver {
  private url = "";
  private closed = false;

  constructor(
    private readonly transport: ChromeBridgeTransport,
    private readonly tabId: number,
    private readonly commandTimeoutMs: number = DEFAULT_EXTENSION_COMMAND_TIMEOUT_MS,
    private readonly siteDomain?: string,
  ) {
    if (!Number.isInteger(tabId) || tabId < 1) {
      throw new ExtensionBridgeError("tabId must be a positive integer");
    }
  }

  async goto(url: string): Promise<void> {
    this.assertOpen();
    await this.command("goto", {
      tabId: this.tabId,
      url,
      ...(this.siteDomain === undefined ? {} : { siteDomain: this.siteDomain }),
    });
    this.url = url;
  }

  currentUrl(): string {
    return this.url;
  }

  async snapshot(): Promise<PageSnapshot> {
    this.assertOpen();
    const payload = await this.command("snapshot", { tabId: this.tabId });
    const snapshot = asPageSnapshot(payload);
    this.url = snapshot.url;
    return snapshot;
  }

  async readValues(): Promise<Record<string, string>> {
    this.assertOpen();
    const payload = await this.command("readValues", { tabId: this.tabId });
    return asStringRecord(payload);
  }

  async readDisplayValues(): Promise<Record<string, string>> {
    this.assertOpen();
    const payload = await this.command("readDisplayValues", { tabId: this.tabId });
    return asStringRecord(payload);
  }

  async fillField(fieldId: string, value: string): Promise<void> {
    this.assertOpen();
    await this.command("fillField", { tabId: this.tabId, fieldId, value });
  }

  async click(selector: string): Promise<void> {
    this.assertOpen();
    await this.command("click", { tabId: this.tabId, selector });
  }

  async waitForReady(): Promise<void> {
    this.assertOpen();
    await this.command("waitForReady", { tabId: this.tabId });
    this.url = asCurrentUrl(await this.command("currentUrl", { tabId: this.tabId }));
  }

  /** Mark this driver closed so further commands fail immediately (session unbind). */
  markClosed(): void {
    this.closed = true;
  }

  private assertOpen(): void {
    if (this.closed) throw new ExtensionBridgeError("extension tab session is closed");
    if (!this.transport.isConnected()) {
      throw new ExtensionBridgeError("chrome bridge disconnected");
    }
  }

  private async command(command: string, payload: Record<string, unknown>): Promise<unknown> {
    try {
      return await this.transport.sendCommand(command, payload, {
        timeoutMs: this.commandTimeoutMs,
      });
    } catch (err) {
      // Re-wrap so callers always see ExtensionBridgeError; preserve timeout wording
      // so VisibilityRunner's unreachableReasonFor maps timed-out navigations.
      if (err instanceof ExtensionBridgeError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new ExtensionBridgeError(message);
    }
  }
}

/** SiteSession that unbinds on close and never exports storageState. */
class ExtensionSiteSession implements SiteSession {
  readonly page: ExtensionPageDriver;
  private closed = false;

  constructor(page: ExtensionPageDriver) {
    this.page = page;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.page.markClosed();
    // Intentionally does not close the user's Chrome tab (design §5).
  }
}

/**
 * Open a SiteSession bound to an already-selected Chrome tab.
 * Second factory entry alongside BrowserEngine.openSession (feature-flag selected).
 */
export function openExtensionTabSession(
  transport: ChromeBridgeTransport,
  options: ExtensionTabSessionOptions,
): SiteSession {
  if (!transport.isConnected()) {
    throw new ExtensionBridgeError("chrome bridge not connected");
  }
  const page = new ExtensionPageDriver(
    transport,
    options.tabId,
    options.commandTimeoutMs,
    options.siteDomain,
  );
  return new ExtensionSiteSession(page);
}

function asPageSnapshot(payload: unknown): PageSnapshot {
  if (!isRecord(payload)) throw new ExtensionBridgeError("invalid snapshot payload");
  if (typeof payload.url !== "string") throw new ExtensionBridgeError("invalid snapshot payload");
  if (!Array.isArray(payload.fields)) throw new ExtensionBridgeError("invalid snapshot payload");
  if (!Array.isArray(payload.buttons)) throw new ExtensionBridgeError("invalid snapshot payload");
  if (!Array.isArray(payload.links)) throw new ExtensionBridgeError("invalid snapshot payload");
  if (typeof payload.visibleText !== "string") throw new ExtensionBridgeError("invalid snapshot payload");
  if (!Array.isArray(payload.iframeSrcs)) throw new ExtensionBridgeError("invalid snapshot payload");
  if (!Array.isArray(payload.wallMarkers)) throw new ExtensionBridgeError("invalid snapshot payload");
  return payload as unknown as PageSnapshot;
}

function asStringRecord(payload: unknown): Record<string, string> {
  if (payload === undefined || payload === null) return {};
  if (!isRecord(payload) || Array.isArray(payload)) {
    throw new ExtensionBridgeError("invalid string-record payload");
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

function asCurrentUrl(payload: unknown): string {
  if (!isRecord(payload) || typeof payload.url !== "string") {
    throw new ExtensionBridgeError("invalid current-url payload");
  }
  return payload.url;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
