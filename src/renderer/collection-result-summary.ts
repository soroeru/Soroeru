// Turns raw per-site Visibility run results (issue #189) into the content shown
// in the collection-result modal. "handoff" is excluded: it has its own
// dedicated hand-off UX (the amber panel) while the run is paused, so it never
// doubles up as a failure card here.

import type { VisibilityRunStatus } from "../../electron/ipc/contract.js";
import { visibilityStatusLabel } from "./messages.js";

export interface CollectionFailureEntry {
  siteAccountId: string;
  siteName: string;
  status: VisibilityRunStatus;
  reason: string;
}

export interface CollectionResultModalContent {
  title: string;
  successCount: number;
  failures: CollectionFailureEntry[];
}

function isFailureStatus(status: VisibilityRunStatus): boolean {
  return status !== "collected" && status !== "handoff";
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
    .filter((entry) => isFailureStatus(entry.status))
    .map((entry) => ({
      siteAccountId: entry.siteAccountId,
      siteName: siteNameOf(entry.siteAccountId),
      status: entry.status,
      reason: visibilityStatusLabel(entry.status),
    }));

  if (failures.length === 0) return undefined;

  const successCount = results.length - failures.length;
  const title =
    results.length === 1
      ? `${failures[0]?.siteName}: 収集できませんでした`
      : `収集結果: 失敗 ${failures.length} 件 / 成功 ${successCount} 件`;

  return { title, successCount, failures };
}
