import { createHash } from "node:crypto";
import { chromium } from "playwright";
import { snapshotPage } from "../agent/scan.js";
import type { DomainService } from "../domain/domain-service.js";
import type { SiteAccount } from "../domain/entities.js";
import { collectDisclosures, displayValueToSyntheticField } from "./disclosure-collector.js";

export const MAX_SAVED_PAGE_BYTES = 5 * 1024 * 1024;

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

export async function importSavedPage(input: SavedPageImportInput): Promise<SavedPageImportResult> {
  const now = input.now ?? Date.now;
  const sourceHash = createHash("sha256").update(input.data).digest("hex");
  const htmlText = new TextDecoder("utf-8", { fatal: false }).decode(input.data);
  const sourceUrl = savedFromUrl(htmlText);

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ javaScriptEnabled: false });
    await context.route("**/*", (route) => {
      const url = route.request().url();
      if (url.startsWith("data:") || url.startsWith("about:") || url.startsWith("blob:")) {
        void route.continue();
        return;
      }
      void route.abort();
    });
    const page = await context.newPage();
    await page.setContent(htmlText, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
    const snapshot = await snapshotPage(page);
    const values = await page.evaluate(readFieldValues);
    const displayValues = await page.evaluate(readDisplayValues);
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
  } finally {
    await browser.close().catch(() => {});
  }
}

function readFieldValues(): Record<string, string> {
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

function readDisplayValues(): Record<string, string> {
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

function savedFromUrl(html: string): string | undefined {
  const match = /<!--\s*saved from url=\(\d+\)(https?:\/\/[^\s>]+)\s*-->/i.exec(html);
  return match?.[1];
}
