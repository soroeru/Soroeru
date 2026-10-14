// Renderer-agnostic core of the saved-page fallback import (Issue #569). The
// page is rendered offline with scripts and network disabled by a surface-
// specific renderer (Playwright in Electron, a sandboxed extension frame in the
// Side Panel); this module turns the rendered structure into disclosures.
// Browser-safe: no Node built-ins.

import type { PageSnapshot } from "../types.js";
import type { DomainService } from "../domain/domain-service.js";
import type { SiteAccount } from "../domain/entities.js";
import { collectDisclosures, displayValueToSyntheticField } from "./disclosure-collector.js";

export { readDisplayValues, readFieldValues } from "./saved-page-readers.js";

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

export function savedFromUrl(html: string): string | undefined {
  const match = /<!--\s*saved from url=\(\d+\)(https?:\/\/[^\s>]+)\s*-->/i.exec(html);
  return match?.[1];
}

async function sha256HexOfBytes(data: Uint8Array): Promise<string> {
  // Copy into an ArrayBuffer-backed view: Web Crypto rejects SharedArrayBuffer views.
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(data));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
