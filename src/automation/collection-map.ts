import type { SiteCollectionMap } from "../domain/entities.js";
import { SITE_COLLECTION_MAP_LIMITS } from "../domain/site-collection-map.js";
import { KNOWN_PROFILE_KEYS, type KnownProfileKey } from "../types.js";
import { classifyFields } from "../agent/classifier.js";
import { permittedCollectionItem, type CollectionFact, type PAGE_PURPOSES, type VerifiedCollectionCandidate } from "./ai-visibility-contract.js";
import type { CollectionObservation } from "./collection-observation.js";
import { collectionUrlAllowed } from "./visibility-navigation-policy.js";

// Issue #518: turns #517's value-free facts into SiteCollectionMap pages and matches them
// on rerun. Only locally corroborated items with locally derived fingerprints become
// entries; model output contributes the (enum-validated) page purpose and attribute key,
// never coordinates.

export type SiteCollectionMapPage = SiteCollectionMap["pages"][number];
type PagePurpose = (typeof PAGE_PURPOSES)[number];

const PURPOSE: Record<PagePurpose, SiteCollectionMapPage["purpose"]> = {
  profile: "profile", address: "profile", contact: "profile", billing: "billing",
  notification: "notifications", security: "security", other: "other", unknown: "other",
};
const SHA256_HEX = /^[a-f0-9]{64}$/;
const FIELD_ID = /^[fd]-[1-9][0-9]{0,5}$/;

/**
 * Map-storable page URL: same-site policy URL without fragment. A query string may
 * select the page's content, so such pages are not mapped rather than stored lossy.
 */
export function mapPageUrl(url: string, siteUrl: string): string | undefined {
  if (!collectionUrlAllowed(url, siteUrl)) return undefined;
  const u = new URL(url);
  if (u.search) return undefined;
  u.hash = "";
  return u.href.length <= SITE_COLLECTION_MAP_LIMITS.urlLength ? u.href : undefined;
}

export function buildMapPage(
  observation: CollectionObservation, purpose: PagePurpose, facts: readonly CollectionFact[], siteUrl: string,
): SiteCollectionMapPage | undefined {
  const prints = observation.fingerprints;
  const url = mapPageUrl(observation.snapshot.url, siteUrl);
  if (!prints || !SHA256_HEX.test(prints.page) || !url) return undefined;
  const items: SiteCollectionMapPage["items"] = [];
  for (const fact of facts) {
    const print = prints.items[fact.itemId];
    if (!fact.corroborated || fact.observationId !== observation.token.observationId || !FIELD_ID.test(fact.itemId) ||
      !print || !SHA256_HEX.test(print) || !observation.items.some(i => i.id === fact.itemId)) continue;
    if (items.length >= SITE_COLLECTION_MAP_LIMITS.itemsPerPage) break;
    items.push({ attributeKey: fact.attributeKey, locator: { kind: "field-id", fieldId: fact.itemId }, fingerprint: print });
  }
  return items.length ? { url, purpose: PURPOSE[purpose], fingerprint: prints.page, items } : undefined;
}

/** Later observations of the same URL replace earlier ones; storage ceilings are enforced. */
export function mergeMapPages(pages: readonly SiteCollectionMapPage[]): SiteCollectionMapPage[] {
  const byUrl = new Map<string, SiteCollectionMapPage>();
  for (const page of pages) { byUrl.delete(page.url); byUrl.set(page.url, page); }
  return [...byUrl.values()].slice(-SITE_COLLECTION_MAP_LIMITS.pages);
}

export type MapMismatch = "page-gone" | "page-changed" | "selector-miss" | "item-changed" | "classification";
export interface MapPageMatch {
  matched: VerifiedCollectionCandidate[];
  mismatched: { attributeKey: string; reason: MapMismatch }[];
}

/**
 * Per-entry isolation for map-based recollection (no AI). An entry is read only when the
 * observed page and item fingerprints agree and the local classifier still assigns the
 * mapped key; otherwise that entry alone is reported, never read from another element.
 */
export function matchMapPage(page: SiteCollectionMapPage, observation: CollectionObservation, siteUrl: string): MapPageMatch {
  const result: MapPageMatch = { matched: [], mismatched: [] };
  const prints = observation.fingerprints;
  if (mapPageUrl(observation.snapshot.url, siteUrl) !== page.url || !prints || prints.page !== page.fingerprint) {
    const reason: MapMismatch = mapPageUrl(observation.snapshot.url, siteUrl) === page.url ? "page-changed" : "page-gone";
    result.mismatched = page.items.map(e => ({ attributeKey: e.attributeKey, reason }));
    return result;
  }
  const used = new Set<string>();
  for (const entry of page.items) {
    const id = entry.locator.kind === "field-id" ? entry.locator.fieldId : undefined;
    const item = id ? observation.items.find(i => i.id === id) : undefined;
    if (!item) { result.mismatched.push({ attributeKey: entry.attributeKey, reason: "selector-miss" }); continue; }
    if (prints.items[item.id] !== entry.fingerprint) { result.mismatched.push({ attributeKey: entry.attributeKey, reason: "item-changed" }); continue; }
    const key = entry.attributeKey as KnownProfileKey;
    const local = classifyFields([item.field], []).entries[0]?.profileKey;
    if (!KNOWN_PROFILE_KEYS.includes(key) || local !== key || !permittedCollectionItem(item) || used.has(item.id) ||
      (key === "card.number" && /[*•xX]/.test(item.value))) {
      result.mismatched.push({ attributeKey: entry.attributeKey, reason: "classification" }); continue;
    }
    used.add(item.id);
    result.matched.push({ item, attributeKey: key });
  }
  return result;
}
