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
  /** Whether retrying the collection makes sense for this status. */
  canRetry: boolean;
  /** Whether offering the saved-page import fallback makes sense for this status. */
  canImportSavedPage: boolean;
  /**
   * Issue #421: the engine explicitly suggested the “read the page you opened”
   * path (same-kind wall repeat or hand-off budget exhaustion).
   */
  suggestSavedPageImport?: boolean;
}

export interface CollectionResultModalContent {
  title: string;
  successCount: number;
  failures: CollectionFailureEntry[];
}

/** "skipped" means the credential is not a website account (e.g. an app entry
 * imported from the password manager), so no action applies. "locked" / "busy"
 * are local/environmental blockers — the run never reached the site itself, so
 * retrying may help once the blocker clears, but suggesting a saved-page import
 * would wrongly imply the site was unreachable. */
function canRetry(status: VisibilityRunStatus): boolean {
  return status !== "skipped";
}

function canImportSavedPage(status: VisibilityRunStatus): boolean {
  return status !== "skipped" && status !== "locked" && status !== "busy";
}

/**
 * Builds the modal content for a completed single-site or batch collection
 * run. Returns undefined when every site succeeded, so callers show no modal
 * on success alone.
 */
export function buildCollectionResultModalContent(
  results: readonly {
    siteAccountId: string;
    status: VisibilityRunStatus;
    suggestSavedPageImport?: boolean;
  }[],
  siteNameOf: (siteAccountId: string) => string,
): CollectionResultModalContent | undefined {
  const failures: CollectionFailureEntry[] = results
    .filter((entry) => entry.status !== "collected")
    .map((entry) => {
      const suggest = entry.suggestSavedPageImport === true;
      return {
        siteAccountId: entry.siteAccountId,
        siteName: siteNameOf(entry.siteAccountId),
        status: entry.status,
        reason: suggest
          ? "自動収集が難しいため、表示したページから読み取る方法を試してください"
          : visibilityStatusLabel(entry.status),
        canRetry: canRetry(entry.status),
        // Engine suggestion always implies the alternate path is available.
        canImportSavedPage: suggest || canImportSavedPage(entry.status),
        ...(suggest ? { suggestSavedPageImport: true } : {}),
      };
    });

  if (failures.length === 0) return undefined;

  const successCount = results.length - failures.length;
  const title =
    results.length === 1
      ? `${failures[0]?.siteName}: 収集できませんでした`
      : `収集結果: 失敗 ${failures.length} 件 / 成功 ${successCount} 件`;

  return { title, successCount, failures };
}
