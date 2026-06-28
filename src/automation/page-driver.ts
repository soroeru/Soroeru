// PageDriver: the narrow surface the Visibility runner needs from a browser
// page (RFC-002 §5.1). The runner is written against this interface so its
// login / collection / wall-handoff / checkpoint logic is unit-testable with a
// scripted fake; the real Playwright adapter lives in ./browser-engine.ts.
//
// Structure and values are kept separate on purpose: `snapshot()` returns
// structure only (labels, attributes, wall markers) — the shape an optional AI
// proposal may see — while `readValues()` returns the collected values locally,
// which never leave the machine and are never sent to a model.

import type { PageSnapshot } from "../types.js";

export interface PageDriver {
  /** Navigate to a URL within the site the user acts on. */
  goto(url: string): Promise<void>;
  /** Current page URL. */
  currentUrl(): string;
  /** Structure-only snapshot (no field values), for classification + wall detection. */
  snapshot(): Promise<PageSnapshot>;
  /** Locally-read field values, keyed by FormField.fieldId. Never sent to a model. */
  readValues(): Promise<Record<string, string>>;
  /** Fill a field (e.g. login) by its FormField.fieldId. */
  fillField(fieldId: string, value: string): Promise<void>;
  /** Click an element by CSS selector (e.g. a PageButton.selector). */
  click(selector: string): Promise<void>;
  /** Wait briefly for a likely post-navigation page to settle before snapshotting. */
  waitForReady(): Promise<void>;
}

/** A browser session bound to one Site Account; closing it disposes the context. */
export interface SiteSession {
  readonly page: PageDriver;
  close(): Promise<void>;
}
