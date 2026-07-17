/**
 * Display-only collection filter for the disclosure ledger (Issue #388).
 * Does not mutate selection; callers apply it before sort/render and when
 * computing "visible" for select-all / selected-visible counts.
 */

export type LedgerCollectionFilter = "all" | "collected" | "uncollected";

export interface FilterableLedgerSite {
  collected: boolean;
}

/** Return sites matching the collection filter; preserves input order. */
export function filterLedgerSitesByCollection<T extends FilterableLedgerSite>(
  sites: readonly T[],
  filter: LedgerCollectionFilter,
): T[] {
  if (filter === "all") return [...sites];
  if (filter === "collected") return sites.filter((site) => site.collected);
  return sites.filter((site) => !site.collected);
}
