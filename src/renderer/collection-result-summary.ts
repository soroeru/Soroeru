// Turns raw per-site Visibility run results (issue #189) into the content shown
// in the collection-result modal. `results` only ever holds terminal outcomes
// (the batch loop awaits each site's run to completion), so a "handoff" entry
// here always means the user skipped/abandoned that site's wall, not that it
// is still paused — the live pause has its own dedicated amber panel and never
// reaches `results`. It is therefore treated as a failure needing follow-up,
// same as any other non-"collected" status.

import type { VisibilityRunStatus } from "../../electron/ipc/contract.js";
import { visibilityStatusLabel } from "./messages.js";

export interface CollectionFailureEntry {
  siteAccountId: string;
  siteName: string;
  status: VisibilityRunStatus;
  reason: string;
  /** Whether retry / saved-page-import actions make sense for this status. */
  actionable: boolean;
}

export interface CollectionResultModalContent {
  title: string;
  successCount: number;
  failures: CollectionFailureEntry[];
}

/** "skipped" means the credential is not a website account (e.g. an app entry
 * imported from the password manager), so neither retrying the collection nor
 * importing a saved page applies. */
function isActionable(status: VisibilityRunStatus): boolean {
  return status !== "skipped";
}

/**
 * Builds the modal content for a completed single-site or batch collection
 * run. Returns undefined when every site succeeded, so callers show no modal
 * on success alone.
 */
export function buildCollectionResultModalContent(
  results: readonly { siteAccountId: string; status: VisibilityRunStatus }[],
  siteNameOf: (siteAccountId: string) => string,
): CollectionResultModalContent | undefined {
  const failures: CollectionFailureEntry[] = results
    .filter((entry) => entry.status !== "collected")
    .map((entry) => ({
      siteAccountId: entry.siteAccountId,
      siteName: siteNameOf(entry.siteAccountId),
      status: entry.status,
      reason: visibilityStatusLabel(entry.status),
      actionable: isActionable(entry.status),
    }));

  if (failures.length === 0) return undefined;

  const successCount = results.length - failures.length;
  const title =
    results.length === 1
      ? `${failures[0]?.siteName}: 収集できませんでした`
      : `収集結果: 失敗 ${failures.length} 件 / 成功 ${successCount} 件`;

  return { title, successCount, failures };
}
