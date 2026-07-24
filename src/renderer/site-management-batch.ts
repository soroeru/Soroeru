import type { SiteLedgerSummary, VisibilityRunResultView } from "../../electron/ipc/contract.js";

export interface BatchResultEntry {
  siteAccountId: string;
  status: VisibilityRunResultView["status"];
}

export interface BatchSummary {
  completed: number;
  canceled: boolean;
  results: BatchResultEntry[];
}

export interface VisibilityBatchRunner {
  run: (siteAccountId: string) => Promise<VisibilityRunResultView>;
  refreshAfterSite?: (siteAccountId: string, result: BatchResultEntry) => Promise<void> | void;
  isCanceled: () => boolean;
}

export function collectVisibleSelectedSiteIds(
  visibleSites: readonly SiteLedgerSummary[],
  selected: ReadonlySet<string>,
): string[] {
  return visibleSites
    .map((site) => site.siteAccountId)
    .filter((siteAccountId) => selected.has(siteAccountId));
}

export async function runVisibilityBatch(
  siteAccountIds: readonly string[],
  runner: VisibilityBatchRunner,
): Promise<BatchSummary> {
  const results: BatchResultEntry[] = [];

  for (const siteAccountId of siteAccountIds) {
    if (runner.isCanceled()) break;

    let entry: BatchResultEntry;
    try {
      const result = await runner.run(siteAccountId);
      entry = { siteAccountId, status: result.status };
    } catch {
      entry = { siteAccountId, status: "failed" };
    }

    results.push(entry);
    await runner.refreshAfterSite?.(siteAccountId, entry);
  }

  return {
    completed: results.length,
    canceled: runner.isCanceled(),
    results,
  };
}

export interface SessionPersistenceBulkResultEntry {
  siteAccountId: string;
  ok: boolean;
  error?: string;
}

export interface SessionPersistenceBulkSummary {
  results: SessionPersistenceBulkResultEntry[];
  failedCount: number;
}

/** Sequential so each site's `vault.save()` completes before the next mutation starts. */
export async function enableSessionPersistenceForSites(
  siteAccountIds: readonly string[],
  set: (siteAccountId: string) => Promise<{ ok: boolean; error?: string }>,
): Promise<SessionPersistenceBulkSummary> {
  const results: SessionPersistenceBulkResultEntry[] = [];

  for (const siteAccountId of siteAccountIds) {
    try {
      const result = await set(siteAccountId);
      results.push({
        siteAccountId,
        ok: result.ok,
        ...(result.error !== undefined ? { error: result.error } : {}),
      });
    } catch {
      results.push({ siteAccountId, ok: false, error: "unknown" });
    }
  }

  return {
    results,
    failedCount: results.filter((entry) => !entry.ok).length,
  };
}

export interface DeleteSitesResultEntry {
  siteAccountId: string;
  ok: boolean;
  error?: string;
}

export interface DeleteSitesSummary {
  results: DeleteSitesResultEntry[];
  failedCount: number;
}

/** Sequential batch deletion of selected site accounts. */
export async function deleteSitesForBatch(
  siteAccountIds: readonly string[],
  deleteSite: (siteAccountId: string) => Promise<{ ok: boolean; error?: string }>,
): Promise<DeleteSitesSummary> {
  const results: DeleteSitesResultEntry[] = [];

  for (const siteAccountId of siteAccountIds) {
    try {
      const result = await deleteSite(siteAccountId);
      results.push({
        siteAccountId,
        ok: result.ok,
        ...(result.error !== undefined ? { error: result.error } : {}),
      });
    } catch {
      results.push({ siteAccountId, ok: false, error: "delete-failed" });
    }
  }

  return {
    results,
    failedCount: results.filter((entry) => !entry.ok).length,
  };
}

/** Fourth absolute boundary: deletion may proceed only with explicit acknowledgment. */
export function canConfirmSiteDeletion(options: {
  targetCount: number;
  acknowledged: boolean;
  deleting: boolean;
}): boolean {
  return options.targetCount > 0 && options.acknowledged && !options.deleting;
}

/** Default number of delete-target site names shown before the modal list folds. */
export const DELETE_TARGET_LIST_PREVIEW_LIMIT = 10;

/** Preview vs full list for the batch-delete confirmation modal (Issue #384). */
export function deleteTargetListVisibility(
  totalCount: number,
  expanded: boolean,
  previewLimit: number = DELETE_TARGET_LIST_PREVIEW_LIMIT,
): { visibleCount: number; hiddenCount: number; foldable: boolean } {
  const foldable = totalCount > previewLimit;
  if (!foldable || expanded) {
    return { visibleCount: totalCount, hiddenCount: 0, foldable };
  }
  return {
    visibleCount: previewLimit,
    hiddenCount: totalCount - previewLimit,
    foldable,
  };
}
