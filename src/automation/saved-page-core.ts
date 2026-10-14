// Renderer-agnostic core of the saved-page fallback import (Issue #569). The
// page is rendered offline with scripts and network disabled by a surface-
// specific renderer (Playwright in Electron, a sandboxed extension frame in the
// Side Panel); this module turns the rendered structure into disclosures.
// Browser-safe: no Node built-ins.

import type { PageSnapshot } from "../types.js";
import type { DomainService } from "../domain/domain-service.js";
import type { SiteAccount } from "../domain/entities.js";
import { collectDisclosures, displayValueToSyntheticField } from "./disclosure-collector.js";

export const MAX_SAVED_PAGE_BYTES = 5 * 1024 * 1024;

/** What a renderer returns after scanning the saved page with `scanInPage`. */
export interface RenderedSavedPage {
  snapshot: PageSnapshot;
  /** Form-field values keyed by `data-af-id` (see `readFieldValues`). */
  values: Record<string, string>;
  /** Read-only display values keyed by `data-af-id` (see `readDisplayValues`). */
  displayValues: Record<string, string>;
}

/** Render saved HTML offline (no scripts, no network) and scan it. */
export type SavedPageRenderer = (html: string) => Promise<RenderedSavedPage>;

export interface SavedPageImportInput {
  domain: DomainService;
  siteAccount: SiteAccount;
  data: Uint8Array;
  fileName: string;
  now?: () => number;
}

export interface SavedPageImportResult {
  siteAccountId: string;
  disclosures: number;
  sourceUrl?: string;
  sourceHash: string;
  recommendSourceDeletion: boolean;
}

export async function importSavedPageWith(
  render: SavedPageRenderer,
  input: SavedPageImportInput,
): Promise<SavedPageImportResult> {
  const now = input.now ?? Date.now;
  const sourceHash = await sha256HexOfBytes(input.data);
  const htmlText = new TextDecoder("utf-8", { fatal: false }).decode(input.data);
  const sourceUrl = savedFromUrl(htmlText);

  const { snapshot, values, displayValues } = await render(htmlText);
  const displayFields = (snapshot.displayValues ?? []).map(displayValueToSyntheticField);
  const collection = collectDisclosures({
    domain: input.domain,
    siteAccount: input.siteAccount,
    snapshot: sourceUrl ? { ...snapshot, url: sourceUrl } : snapshot,
    fields: [...snapshot.fields, ...displayFields],
    values: { ...values, ...displayValues },
    now,
    sourceKind: "manual-import",
  });
  input.domain.addEvidence({
    siteAccountId: input.siteAccount.id,
    observedAt: now(),
    maskedSnippet: `manual-import source:${sourceHash.slice(0, 16)}`,
    normalizedHash: sourceHash,
    ...(sourceUrl !== undefined ? { pageUrl: sourceUrl } : {}),
  });
  if (collection.disclosures > 0 || collection.dynamicCandidates > 0) {
    input.domain.saveCheckpoint({
      workflow: "visibility",
      siteAccountId: input.siteAccount.id,
      step: "manual-import",
      status: "done",
      resumeData: {
        source: "manual-import",
        fileHash: sourceHash.slice(0, 16),
        disclosures: collection.disclosures,
      },
    });
  }
  return {
    siteAccountId: input.siteAccount.id,
    disclosures: collection.disclosures,
    ...(sourceUrl !== undefined ? { sourceUrl } : {}),
    sourceHash,
    recommendSourceDeletion: true,
  };
}

/** Browser-only: form-field values stamped by `scanInPage`. Runs in the rendered page's realm. */
export function readFieldValues(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const el of Array.from(document.querySelectorAll("[data-af-id]"))) {
    const id = el.getAttribute("data-af-id");
    if (!id || !id.startsWith("f")) continue;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      if (el instanceof HTMLInputElement && (el.type === "radio" || el.type === "checkbox")) {
        if (el.checked) out[id] = el.value;
        continue;
      }
      if (typeof el.value === "string" && el.value !== "") out[id] = el.value;
    }
  }
  return out;
}

/** Browser-only: read-only display values stamped by `scanInPage`. Runs in the rendered page's realm. */
export function readDisplayValues(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const el of Array.from(document.querySelectorAll("[data-af-id]"))) {
    const id = el.getAttribute("data-af-id");
    if (!id || !id.startsWith("d")) continue;
    const value = el instanceof HTMLInputElement ? el.value : (el.textContent ?? "");
    const trimmed = value.trim();
    if (trimmed !== "") out[id] = trimmed;
  }
  return out;
}

export function savedFromUrl(html: string): string | undefined {
  const match = /<!--\s*saved from url=\(\d+\)(https?:\/\/[^\s>]+)\s*-->/i.exec(html);
  return match?.[1];
}

async function sha256HexOfBytes(data: Uint8Array): Promise<string> {
  // Copy into an ArrayBuffer-backed view: Web Crypto rejects SharedArrayBuffer views.
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(data));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
