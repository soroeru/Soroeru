// Real Playwright adapter for the Visibility runner (RFC-002 §2.3 / §5.1).
//
// The runner (`./visibility-runner.ts`) is written against the narrow
// `PageDriver` / `SiteSession` interface (`./page-driver.ts`) so its login /
// collection / wall-handoff logic stays unit-testable with a scripted fake.
// This module provides the production implementation: a headed browser, one
// ephemeral context per Site Account, and a `PageDriver` backed by the reused
// in-page scanner (`../agent/scan.ts`).
//
// Lifecycle (RFC-002 §2.3): contexts are ephemeral and disposed on
// `close()`; `closeAll()` disposes every open session and the browser so app
// quit leaves no orphan process and no plaintext browser profile on disk.

import { chromium, firefox, webkit, type Browser, type BrowserContext, type Page } from "playwright";
import { snapshotPage, waitForFields } from "../agent/scan.js";
import type { PageDriver, SiteSession } from "./page-driver.js";
import type { PageSnapshot } from "../types.js";

export type BrowserEngineName = "chromium" | "firefox" | "webkit";

const ENGINES = { chromium, firefox, webkit } as const;

export interface BrowserEngineOptions {
  /** Default engine is Chromium; Firefox/WebKit are compat targets (RFC-002 §2.3). */
  engine?: BrowserEngineName;
  /**
   * Headed by default: the wall hand-off model resolves CAPTCHA/MFA in the same
   * visible session (RFC-002 §5.2). Tests may pass `headless: true`.
   */
  headless?: boolean;
}

/** A `PageDriver` over a real Playwright `Page`, keyed by the scanner's data-af-id stamps. */
class PlaywrightPageDriver implements PageDriver {
  constructor(private readonly page: Page) {}

  async goto(url: string): Promise<void> {
    // egress: target-site — navigate only to the site the user imported/selected.
    await this.page.goto(url, { waitUntil: "domcontentloaded" });
  }

  currentUrl(): string {
    return this.page.url();
  }

  /** Structure-only snapshot (no values); also stamps elements with data-af-id. */
  async snapshot(): Promise<PageSnapshot> {
    const withFields = await waitForFields(this.page, 5000);
    if (withFields.fields.length > 0 || (withFields.displayValues?.length ?? 0) > 0) return withFields;
    return snapshotPage(this.page);
  }

  /**
   * Read field values locally, keyed by the same data-af-id the snapshot stamps.
   * Values never leave the machine and are never sent to a model (RFC-002 §5.1);
   * the caller (runner) hashes/redacts them before they touch the ledger.
   */
  async readValues(): Promise<Record<string, string>> {
    return this.page.evaluate(() => {
      const out: Record<string, string> = {};
      for (const el of Array.from(document.querySelectorAll("[data-af-id]"))) {
        const id = el.getAttribute("data-af-id");
        if (!id || !id.startsWith("f")) continue; // fields are "f-*"; buttons are "b-*"
        if (
          el instanceof HTMLInputElement ||
          el instanceof HTMLTextAreaElement ||
          el instanceof HTMLSelectElement
        ) {
          if (el instanceof HTMLInputElement && (el.type === "radio" || el.type === "checkbox")) {
            if (el.checked) out[id] = el.value;
            continue;
          }
          if (typeof el.value === "string" && el.value !== "") out[id] = el.value;
        }
      }
      return out;
    });
  }

  /**
   * Read read-only display values stamped "d-*" by the scanner (account pages that
   * render registered info as text). Inputs expose `.value`; other elements expose
   * `.textContent`. Like `readValues`, these stay local and never reach a model.
   */
  async readDisplayValues(): Promise<Record<string, string>> {
    return this.page.evaluate(() => {
      const out: Record<string, string> = {};
      for (const el of Array.from(document.querySelectorAll("[data-af-id]"))) {
        const id = el.getAttribute("data-af-id");
        if (!id || !id.startsWith("d")) continue; // display values are "d-*"
        const value =
          el instanceof HTMLInputElement ? el.value : (el.textContent ?? "");
        const trimmed = value.trim();
        if (trimmed !== "") out[id] = trimmed;
      }
      return out;
    });
  }

  async fillField(fieldId: string, value: string): Promise<void> {
    await this.page.fill(`[data-af-id="${cssEscape(fieldId)}"]`, value);
  }

  async click(selector: string): Promise<void> {
    await this.page.click(selector);
    // A login/submit click usually navigates; the runner snapshots immediately
    // after, so let any triggered navigation settle first. No-op when the click
    // did not navigate (already loaded).
    await this.page.waitForLoadState("domcontentloaded").catch(() => {});
  }

  async waitForReady(): Promise<void> {
    await this.page.waitForLoadState("domcontentloaded").catch(() => {});
    await this.page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
  }
}

/** One browser session bound to a Site Account; closing it disposes the context. */
class PlaywrightSiteSession implements SiteSession {
  readonly page: PageDriver;
  private closed = false;

  constructor(
    private readonly context: BrowserContext,
    page: PageDriver,
    private readonly onClosed: (session: PlaywrightSiteSession) => void,
  ) {
    this.page = page;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.context.close();
    } finally {
      this.onClosed(this);
    }
  }
}

/**
 * Owns the Playwright browser and hands out one ephemeral context per site.
 * Tracks open sessions so `closeAll()` (app quit) can dispose every one.
 */
export class BrowserEngine {
  private browser: Browser | undefined;
  private readonly sessions = new Set<PlaywrightSiteSession>();

  constructor(private readonly options: BrowserEngineOptions = {}) {}

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser) return this.browser;
    const engine = ENGINES[this.options.engine ?? "chromium"];
    this.browser = await engine.launch({ headless: this.options.headless ?? false });
    return this.browser;
  }

  /**
   * Open a fresh ephemeral context + page for one site. The site argument is
   * accepted to match the runner's `openSession(site)` shape; the context is
   * ephemeral regardless of which site it is for.
   */
  async openSession(_site?: unknown): Promise<SiteSession> {
    const browser = await this.ensureBrowser();
    const context = await browser.newContext();
    const page = await context.newPage();
    const session = new PlaywrightSiteSession(context, new PlaywrightPageDriver(page), (s) =>
      this.sessions.delete(s),
    );
    this.sessions.add(session);
    return session;
  }

  /** Whether any browser/session is currently open (for lifecycle assertions). */
  get hasOpenResources(): boolean {
    return this.sessions.size > 0 || this.browser !== undefined;
  }

  /** Dispose every open session and the browser. Idempotent; safe on app quit. */
  async closeAll(): Promise<void> {
    for (const session of [...this.sessions]) {
      try {
        await session.close();
      } catch {
        // Best-effort teardown: a context that already crashed must not block quit.
      }
    }
    this.sessions.clear();
    if (this.browser) {
      const browser = this.browser;
      this.browser = undefined;
      try {
        await browser.close();
      } catch {
        // Same: never let a wedged browser prevent the process from exiting.
      }
    }
  }
}

/** Escape a data-af-id for safe interpolation into a CSS attribute selector. */
function cssEscape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}
