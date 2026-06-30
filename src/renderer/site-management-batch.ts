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
