export type LedgerSortMode = "manual" | "name-asc" | "name-desc";

export interface OrderableLedgerSite {
  siteAccountId: string;
  displayName: string;
}

export function orderLedgerSites<T extends OrderableLedgerSite>(
  sites: readonly T[],
  mode: LedgerSortMode,
): T[] {
  if (mode === "manual") return [...sites];
  const direction = mode === "name-asc" ? 1 : -1;
  return [...sites].sort(
    (a, b) =>
      direction * a.displayName.localeCompare(b.displayName, "ja") ||
      direction * a.siteAccountId.localeCompare(b.siteAccountId),
  );
}

export function moveLedgerSite<T extends OrderableLedgerSite>(
  sites: readonly T[],
  draggedId: string,
  targetId: string,
): T[] {
  const from = sites.findIndex((site) => site.siteAccountId === draggedId);
  const to = sites.findIndex((site) => site.siteAccountId === targetId);
  if (from < 0 || to < 0 || from === to) return [...sites];
  const next = [...sites];
  const [dragged] = next.splice(from, 1);
  if (!dragged) return [...sites];
  next.splice(to, 0, dragged);
  return next;
}
