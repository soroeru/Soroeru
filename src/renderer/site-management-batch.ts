import type { SiteLedgerSummary, VisibilityRunResultView } from "../../electron/ipc/contract.js";

export interface BatchResultEntry {
  siteAccountId: string;
  status: VisibilityRunResultView["status"];
  /** Issue #421: terminal run asked for the saved-page / current-page read path. */
  suggestSavedPageImport?: boolean;
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
      entry = {
        siteAccountId,
        status: result.status,
        ...(result.suggestSavedPageImport ? { suggestSavedPageImport: true } : {}),
      };
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
