// Disclosure ledger (issue #160, RFC-002 §4.2 / §5.1; spreadsheet-style table
// layout added for Issue #301; Site Management folded in for Issue #341). Shows
// the composed per-site view: what each Site Account holds, with stale flags and
// Account Relationship chips. Values are masked by default; a single value is
// revealed only through an explicit re-authenticated flow (master passphrase
// re-checked in the trusted layer). A revealed value is held in component state
// only after that explicit reveal, stays until the user hides it or the
// row/cell unmounts, and is never persisted.
//
// Issue #341 also owns selection, batch Visibility collection, session
// persistence bulk-enable, per-row detail / saved-page import / delete, and
// status chips that used to live on the dedicated Site Management tab.

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Label } from "@radix-ui/react-label";
import type {
  DisclosureView,
  PendingAttributeCandidateView,
  SessionPersistenceView,
  SiteCredentialView,
  SiteLedgerDetail,
  SiteLedgerSummary,
  VisibilityEvent,
} from "../../../electron/ipc/contract.js";
import {
  buildCollectionResultModalContent,
  type CollectionResultModalContent,
} from "../collection-result-summary.js";
import {
  buildLedgerColumns,
  buildSiteDetailDisclosureGroups,
  clampLedgerAttributeColumnWidth,
  disclosureFor,
  LEDGER_EMPTY_ATTRIBUTE_AREA_WIDTH_PX,
  ledgerAttributeColumnWidthPx,
  ledgerTableWidthPx,
} from "../ledger-table.js";
import { reasonMessage, relationshipLabel, staleLabel } from "../messages.js";
import { prepareChromeBridgeRun } from "../chrome-bridge-ui.js";
import { filterLedgerSitesByCollection, type LedgerCollectionFilter } from "../ledger-filter.js";
import { moveLedgerSite, orderLedgerSites, type LedgerSortMode } from "../ledger-ordering.js";
import {
  collectVisibleSelectedSiteIds,
  enableSessionPersistenceForSites,
  runVisibilityBatch,
  type BatchResultEntry,
} from "../site-management-batch.js";
import { SavedPageImportPanel } from "./SavedPageImportPanel.js";
import {
  BatchCollectionBar,
  CollectionResultModal,
  DeleteSiteModal,
  HandoffPanel,
  SavedPageImportGuide,
  type BatchProgress,
  type HandoffState,
} from "./SiteCollectionUi.js";

const emptyBatchProgress: BatchProgress = {
  phase: "idle",
  queue: [],
  currentSiteId: undefined,
  completed: 0,
  results: [],
};

interface LedgerPanelProps {
  /** Bumped by the parent after a CSV import or collection so the ledger refetches. */
  reloadToken: number;
  /** Notify the parent that collection/import/delete changed vault-backed data. */
  onCollected: () => void;
  /**
   * True while a Visibility batch is running, paused at a wall, or canceling.
   * The parent uses this to keep other tabs disabled so this panel (and its
   * hand-off subscription) is not abandoned mid-run.
   */
  onCollectionBusyChange?: (busy: boolean) => void;
}

/**
 * Spreadsheet-style Disclosure ledger with integrated site collection controls
 * (Issue #341). Rows are sites, columns are the disclosed common comparison
 * attributes observed across all sites, plus selection, status, and actions.
 */
export function LedgerPanel({
  reloadToken,
  onCollected,
  onCollectionBusyChange,
}: LedgerPanelProps): React.JSX.Element {
  const [sites, setSites] = useState<SiteLedgerDetail[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loadError, setLoadError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [runningSiteId, setRunningSiteId] = useState<string | undefined>();
  const [savedPageSiteId, setSavedPageSiteId] = useState<string | undefined>();
  const [guideSiteId, setGuideSiteId] = useState<string | undefined>();
  const [handoff, setHandoff] = useState<HandoffState | undefined>();
  const [detail, setDetail] = useState<SiteLedgerDetail | undefined>();
  const [detailError, setDetailError] = useState<string | undefined>();
  const [batch, setBatch] = useState<BatchProgress>(emptyBatchProgress);
  const [sessionPersistenceBulkRunning, setSessionPersistenceBulkRunning] = useState(false);
  const [sessionPersistenceBulkError, setSessionPersistenceBulkError] = useState<string | undefined>();
  const [resultModal, setResultModal] = useState<CollectionResultModalContent | undefined>();
  const [deleteTarget, setDeleteTarget] = useState<SiteLedgerSummary | undefined>();
  const [deleteAcknowledged, setDeleteAcknowledged] = useState(false);
  const [deletingSite, setDeletingSite] = useState(false);
  const [sortMode, setSortMode] = useState<LedgerSortMode>("name-asc");
  /** Display-only; does not clear selection of hidden rows (Issue #388). */
  const [collectionFilter, setCollectionFilter] = useState<LedgerCollectionFilter>("all");
  const [draggedSiteId, setDraggedSiteId] = useState<string | undefined>();
  const [orderAnnouncement, setOrderAnnouncement] = useState("");
  /**
   * Per-attribute column widths in px (Issue #382). Unset keys use the default.
   * Session-only: remember widths while the panel is mounted, including if a
   * column disappears and reappears later; not persisted across app restarts.
   */
  const [attributeColumnWidths, setAttributeColumnWidths] = useState<Record<string, number>>({});
  const resumedHandoffSites = useRef<Set<string>>(new Set());
  const cancelBatchRef = useRef(false);
  /** True while `runVisibilityBatch` is in progress (including cancel unwind). */
  const batchInFlightRef = useRef(false);
  const onCollectedRef = useRef(onCollected);
  const sitesRef = useRef(sites);
  const columnResizeRef = useRef<{
    attributeKey: string;
    startX: number;
    startWidth: number;
    pointerId: number;
  } | null>(null);

  useEffect(() => {
    onCollectedRef.current = onCollected;
  }, [onCollected]);

  useEffect(() => {
    sitesRef.current = sites;
  }, [sites]);

  const loadSites = useCallback(async () => {
    try {
      const nextSites = await window.soroeru.ledger.siteDetails();
      setSites(nextSites);
      setLoadError(undefined);
      setSelected((current) => {
        const validIds = new Set(nextSites.map((site) => site.siteAccountId));
        return new Set([...current].filter((siteAccountId) => validIds.has(siteAccountId)));
      });
      setDetail((current) => {
        if (!current) return current;
        return nextSites.find((site) => site.siteAccountId === current.siteAccountId);
      });
    } catch {
      setLoadError(reasonMessage(undefined));
    } finally {
      setLoading(false);
    }
  }, []);

  /** Mid-batch: re-fetch one composed site row instead of the entire ledger. */
  const patchSite = useCallback(async (siteAccountId: string) => {
    try {
      const next = await window.soroeru.ledger.site(siteAccountId);
      if (!next) return;
      setSites((current) => {
        const index = current.findIndex((site) => site.siteAccountId === siteAccountId);
        if (index < 0) return [...current, next];
        const copy = current.slice();
        copy[index] = next;
        return copy;
      });
      setDetail((current) => (current?.siteAccountId === siteAccountId ? next : current));
    } catch {
      // Non-fatal for mid-batch progress; a full load at batch end reconciles.
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadSites();
  }, [loadSites, reloadToken]);

  useEffect(() => {
    const unsubscribe = window.soroeru.visibility.onEvent((event: VisibilityEvent) => {
      switch (event.type) {
        case "run-started":
          // Still track the site id so cancel/abort targets stay correct, but
          // do not clear a guide the user opened after cancel.
          setRunningSiteId(event.siteAccountId);
          if (!cancelBatchRef.current) {
            setHandoff(undefined);
            setGuideSiteId(undefined);
          }
          resumedHandoffSites.current.delete(event.siteAccountId);
          break;
        case "handoff":
          // Late hand-off after cancel / showGuide must not reopen the modal or
          // pull the batch bar out of "canceling".
          if (cancelBatchRef.current) break;
          setBatch((current) => {
            if (current.phase === "canceling") return current;
            return { ...current, phase: "paused" };
          });
          setHandoff({
            siteAccountId: event.siteAccountId,
            instruction: event.instruction,
            fallbackSuggested: resumedHandoffSites.current.has(event.siteAccountId),
            credential: event.credential,
          });
          if (resumedHandoffSites.current.has(event.siteAccountId)) {
            // Expand the saved-page strip so the nested guide is actually visible.
            setGuideSiteId(event.siteAccountId);
            setSavedPageSiteId(event.siteAccountId);
          }
          break;
        case "resumed":
          if (cancelBatchRef.current) {
            setHandoff(undefined);
            break;
          }
          resumedHandoffSites.current.add(event.siteAccountId);
          setBatch((current) => {
            if (current.phase === "canceling") return current;
            return {
              ...current,
              phase: current.queue.length > 0 ? "running" : current.phase,
            };
          });
          setHandoff(undefined);
          break;
        case "run-finished":
          // Batch progress owns ledger refresh (`refreshAfterSite`); this event
          // only clears transient run UI so we do not re-fetch full siteDetails
          // three extra times per site after folding collection into the ledger.
          setRunningSiteId(undefined);
          setHandoff(undefined);
          resumedHandoffSites.current.delete(event.result.siteAccountId);
          break;
      }
    });
    return unsubscribe;
  }, []);

  const visibleSites = useMemo(
    () => filterLedgerSitesByCollection(sites, collectionFilter),
    [collectionFilter, sites],
  );
  const selectedVisibleIds = useMemo(
    () => collectVisibleSelectedSiteIds(visibleSites, selected),
    [selected, visibleSites],
  );
  const orderedSites = useMemo(() => orderLedgerSites(visibleSites, sortMode), [sortMode, visibleSites]);
  const batchBusy = batch.phase === "running" || batch.phase === "paused" || batch.phase === "canceling";
  // Saved-page guide / import stay usable after showGuide even while the batch is canceling.
  const guideInteractiveDisabled = batch.phase === "running" || batch.phase === "paused";
  const currentSite = sites.find((site) => site.siteAccountId === batch.currentSiteId);
  const allSelected = visibleSites.length > 0 && selectedVisibleIds.length === visibleSites.length;

  const persistManualOrder = useCallback(async (nextSites: SiteLedgerDetail[], movedName: string) => {
    const previous = sitesRef.current;
    sitesRef.current = nextSites;
    setSites(nextSites);
    try {
      const result = await window.soroeru.ledger.reorderSites(nextSites.map((site) => site.siteAccountId));
      if (!result.ok) throw new Error(result.error);
      setOrderAnnouncement(`${movedName} の並び順を保存しました`);
    } catch {
      sitesRef.current = previous;
      setSites(previous);
      setLoadError("並び順を保存できませんでした。元の順序に戻しました。");
    }
  }, []);

  const moveManualSite = useCallback(
    (draggedId: string, targetId: string) => {
      if (sortMode !== "manual") return;
      const moved = sitesRef.current.find((site) => site.siteAccountId === draggedId);
      const next = moveLedgerSite(sitesRef.current, draggedId, targetId);
      if (
        !moved ||
        next.every((site, index) => site.siteAccountId === sitesRef.current[index]?.siteAccountId)
      ) {
        return;
      }
      void persistManualOrder(next, moved.displayName);
    },
    [persistManualOrder, sortMode],
  );

  const moveManualSiteBy = useCallback(
    (siteAccountId: string, offset: -1 | 1) => {
      if (sortMode !== "manual") return;
      // Neighbors must follow the filtered table, not the full list (Issue #388).
      const visible = filterLedgerSitesByCollection(sitesRef.current, collectionFilter);
      const index = visible.findIndex((site) => site.siteAccountId === siteAccountId);
      const target = visible[index + offset];
      if (target) moveManualSite(siteAccountId, target.siteAccountId);
    },
    [collectionFilter, moveManualSite, sortMode],
  );

  useEffect(() => {
    onCollectionBusyChange?.(batchBusy);
    return () => onCollectionBusyChange?.(false);
  }, [batchBusy, onCollectionBusyChange]);

  const refreshAfterSite = useCallback(
    async (siteAccountId: string, result: BatchResultEntry) => {
      // Patch only this site mid-batch; full siteDetails runs once when the batch ends.
      await patchSite(siteAccountId);
      setBatch((current) => ({
        ...current,
        completed: current.completed + 1,
        results: [...current.results, result],
        currentSiteId: siteAccountId,
      }));
    },
    [patchSite],
  );

  const startBatch = useCallback(
    async (overrideIds?: string[]) => {
      const queue = overrideIds ?? [...selectedVisibleIds];
      if (queue.length === 0 || batchBusy || batchInFlightRef.current) return;
      const ready = await prepareChromeBridgeRun(window.soroeru.chromeBridge, (message) =>
        window.confirm(message),
      );
      if (!ready) {
        setLoadError(
          "Chrome の対象タブを確認できませんでした。対象サイトを開き、拡張アイコンからオリジンを許可してから再実行してください。",
        );
        return;
      }
      cancelBatchRef.current = false;
      batchInFlightRef.current = true;
      setLoadError(undefined);
      setResultModal(undefined);
      setBatch({ phase: "running", queue, currentSiteId: queue[0], completed: 0, results: [] });
      try {
        const summary = await runVisibilityBatch(queue, {
          run: async (siteAccountId) => {
            setBatch((current) => {
              // Do not leave "canceling" if the user already aborted this batch.
              if (cancelBatchRef.current || current.phase === "canceling") return current;
              return { ...current, phase: "running", currentSiteId: siteAccountId };
            });
            return window.soroeru.visibility.run(siteAccountId);
          },
          refreshAfterSite,
          isCanceled: () => cancelBatchRef.current,
        });
        setBatch((current) => ({
          ...current,
          phase: summary.canceled ? "idle" : "done",
          currentSiteId: undefined,
          completed: summary.completed,
          results: summary.results,
        }));
        // Single full reload via parent reloadToken (avoids loadSites + token double-fetch).
        onCollectedRef.current();
        if (!summary.canceled) {
          const content = buildCollectionResultModalContent(
            summary.results,
            (siteAccountId) =>
              sitesRef.current.find((site) => site.siteAccountId === siteAccountId)?.displayName ??
              siteAccountId,
          );
          if (content) setResultModal(content);
        }
      } catch {
        setLoadError(reasonMessage(undefined));
        setBatch((current) => ({ ...current, phase: "idle", currentSiteId: undefined }));
        onCollectedRef.current();
      } finally {
        batchInFlightRef.current = false;
      }
    },
    [batchBusy, refreshAfterSite, selectedVisibleIds],
  );

  const cancelBatch = useCallback(() => {
    cancelBatchRef.current = true;
    if (runningSiteId !== undefined || handoff) void window.soroeru.visibility.abort();
    void window.soroeru.chromeBridge.stop();
    // Drop the hand-off modal so 「解決して再開」 cannot race cancel.
    setHandoff(undefined);
    setBatch((current) => ({ ...current, phase: "canceling" }));
  }, [handoff, runningSiteId]);

  const resume = useCallback(() => {
    if (cancelBatchRef.current) return;
    void window.soroeru.visibility.resume();
  }, []);
  const skipCurrentSite = useCallback(() => void window.soroeru.visibility.abort(), []);
  /**
   * Poll until Visibility reports idle. Returns false if still running after
   * the timeout so callers do not open guide/import while a run is live.
   */
  const waitForVisibilityIdle = useCallback(async (maxAttempts = 100, intervalMs = 100): Promise<boolean> => {
    for (let i = 0; i < maxAttempts; i++) {
      const status = await window.soroeru.visibility.status();
      if (!status.running) return true;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return false;
  }, []);
  const showGuide = useCallback(
    async (siteAccountId: string) => {
      // Stay in "canceling" until startBatch's runVisibilityBatch promise settles so
      // "選択したサイトを収集" remains disabled and a second batch cannot overlap.
      // Guide / import controls use guideInteractiveDisabled (false) instead of batchBusy.
      cancelBatchRef.current = true;
      setBatch((current) => ({ ...current, phase: "canceling" }));
      setHandoff(undefined);
      await window.soroeru.visibility.abort();
      let idle = await waitForVisibilityIdle();
      if (!idle) {
        // One more abort + shorter wait before giving up on opening the guide.
        await window.soroeru.visibility.abort();
        idle = await waitForVisibilityIdle(50, 100);
      }
      if (!idle) {
        setRunningSiteId(undefined);
        setHandoff(undefined);
        setLoadError(
          "収集の停止を確認できませんでした。停止が終わるまでお待ちください。終わらない場合はしばらくしてから再試行してください。",
        );
        // Unlock the shell only when no batch loop is still owning the phase;
        // otherwise startBatch's finally will settle canceling → idle/done.
        if (!batchInFlightRef.current) {
          setBatch((current) => ({ ...current, phase: "idle", currentSiteId: undefined }));
        }
        return;
      }
      setRunningSiteId(undefined);
      setGuideSiteId(siteAccountId);
      setSavedPageSiteId(siteAccountId);
    },
    [waitForVisibilityIdle],
  );
  const markManual = useCallback(
    async (siteAccountId: string) => {
      await window.soroeru.visibility.abort();
      let idle = await waitForVisibilityIdle();
      if (!idle) {
        await window.soroeru.visibility.abort();
        idle = await waitForVisibilityIdle(50, 100);
      }
      if (!idle) {
        setLoadError(
          "収集の停止を確認できませんでした。停止が終わるまでお待ちください。終わらない場合はしばらくしてから再試行してください。",
        );
        return;
      }
      const result = await window.soroeru.savedPage.markManualCheck(siteAccountId);
      if (!result.ok) {
        setLoadError(reasonMessage(result.error));
        return;
      }
      setGuideSiteId(undefined);
      setSavedPageSiteId(undefined);
      await loadSites();
      onCollectedRef.current();
    },
    [loadSites, waitForVisibilityIdle],
  );
  const openSite = useCallback(async (siteAccountId: string) => {
    const result = await window.soroeru.savedPage.openSite(siteAccountId);
    if (!result.ok) setLoadError(reasonMessage(result.error));
  }, []);

  const openDetail = useCallback(async (siteAccountId: string, opts?: { refresh?: boolean }) => {
    if (!opts?.refresh) {
      const cached = sitesRef.current.find((site) => site.siteAccountId === siteAccountId);
      if (cached) {
        setDetailError(undefined);
        setDetail(cached);
        return;
      }
    }
    const result = await window.soroeru.ledger.site(siteAccountId);
    if (!result) {
      setDetail(undefined);
      setDetailError("詳細を取得できませんでした。");
      return;
    }
    setDetailError(undefined);
    setDetail(result);
  }, []);
  const enableSessionPersistenceForSelected = useCallback(async () => {
    const ids = [...selectedVisibleIds];
    if (ids.length === 0 || sessionPersistenceBulkRunning) return;
    setSessionPersistenceBulkRunning(true);
    setSessionPersistenceBulkError(undefined);
    try {
      const summary = await enableSessionPersistenceForSites(ids, (siteAccountId) =>
        window.soroeru.sessionPersistence.set({ siteAccountId, enabled: true }),
      );
      if (summary.failedCount > 0) {
        const firstFailure = summary.results.find((entry) => !entry.ok);
        setSessionPersistenceBulkError(reasonMessage(firstFailure?.error));
      }
      await loadSites();
      if (detail && ids.includes(detail.siteAccountId)) {
        await openDetail(detail.siteAccountId, { refresh: true });
      }
    } finally {
      setSessionPersistenceBulkRunning(false);
    }
  }, [detail, loadSites, openDetail, selectedVisibleIds, sessionPersistenceBulkRunning]);
  const retrySite = useCallback(
    (siteAccountId: string) => {
      setResultModal(undefined);
      void startBatch([siteAccountId]);
    },
    [startBatch],
  );
  const importSavedPageFor = useCallback((siteAccountId: string) => {
    setResultModal(undefined);
    setSavedPageSiteId(siteAccountId);
  }, []);
  const requestDelete = useCallback((site: SiteLedgerSummary) => {
    setLoadError(undefined);
    setDeleteAcknowledged(false);
    setDeleteTarget(site);
  }, []);
  const closeDeleteModal = useCallback(() => {
    if (deletingSite) return;
    setDeleteTarget(undefined);
    setDeleteAcknowledged(false);
  }, [deletingSite]);
  const confirmDelete = useCallback(async () => {
    if (!deleteTarget || !deleteAcknowledged || deletingSite) return;
    setDeletingSite(true);
    try {
      const siteAccountId = deleteTarget.siteAccountId;
      const result = await window.soroeru.ledger.deleteSite({
        siteAccountId,
        confirmedFourthBoundary: true,
      });
      if (!result.ok) {
        setLoadError(reasonMessage(result.error));
        return;
      }
      setSelected((current) => {
        const next = new Set(current);
        next.delete(siteAccountId);
        return next;
      });
      setDetail((current) => (current?.siteAccountId === siteAccountId ? undefined : current));
      setSavedPageSiteId((current) => (current === siteAccountId ? undefined : current));
      setGuideSiteId((current) => (current === siteAccountId ? undefined : current));
      setDeleteTarget(undefined);
      setDeleteAcknowledged(false);
      await loadSites();
      onCollectedRef.current();
    } catch {
      setLoadError(reasonMessage("delete-failed"));
    } finally {
      setDeletingSite(false);
    }
  }, [deleteAcknowledged, deleteTarget, deletingSite, loadSites]);

  const selectSite = useCallback((siteAccountId: string, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(siteAccountId);
      else next.delete(siteAccountId);
      return next;
    });
  }, []);
  const selectAllVisible = useCallback(() => {
    setSelected((current) => {
      const next = new Set(current);
      for (const site of visibleSites) next.add(site.siteAccountId);
      return next;
    });
  }, [visibleSites]);
  /** Clears checks on currently visible rows only; hidden selections stay. */
  const clearVisible = useCallback(() => {
    setSelected((current) => {
      const visibleIds = new Set(visibleSites.map((site) => site.siteAccountId));
      return new Set([...current].filter((siteAccountId) => !visibleIds.has(siteAccountId)));
    });
  }, [visibleSites]);

  const endAttributeColumnResize = useCallback(() => {
    columnResizeRef.current = null;
  }, []);

  const onAttributeColumnResizePointerDown = useCallback(
    (attributeKey: string, event: React.PointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const startWidth = ledgerAttributeColumnWidthPx(attributeColumnWidths, attributeKey);
      columnResizeRef.current = {
        attributeKey,
        startX: event.clientX,
        startWidth,
        pointerId: event.pointerId,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [attributeColumnWidths],
  );

  const onAttributeColumnResizePointerMove = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    const active = columnResizeRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const nextWidth = clampLedgerAttributeColumnWidth(active.startWidth + (event.clientX - active.startX));
    setAttributeColumnWidths((current) => {
      if (current[active.attributeKey] === nextWidth) return current;
      return { ...current, [active.attributeKey]: nextWidth };
    });
  }, []);

  const onAttributeColumnResizePointerUp = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      const active = columnResizeRef.current;
      if (!active || active.pointerId !== event.pointerId) return;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      endAttributeColumnResize();
    },
    [endAttributeColumnResize],
  );

  const onAttributeColumnResizeLostPointerCapture = useCallback(() => {
    endAttributeColumnResize();
  }, [endAttributeColumnResize]);

  const nudgeAttributeColumnWidth = useCallback((attributeKey: string, deltaPx: number) => {
    setAttributeColumnWidths((current) => {
      const nextWidth = clampLedgerAttributeColumnWidth(
        ledgerAttributeColumnWidthPx(current, attributeKey) + deltaPx,
      );
      if (current[attributeKey] === nextWidth) return current;
      return { ...current, [attributeKey]: nextWidth };
    });
  }, []);

  if (loading) return <p className="text-sm text-neutral-500">読み込み中…</p>;

  if (loadError && sites.length === 0) {
    return (
      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-medium">開示台帳</h2>
        <p className="text-sm text-red-600">{loadError}</p>
        <button type="button" onClick={() => void loadSites()} className="self-start text-sm underline">
          再読み込み
        </button>
      </section>
    );
  }

  if (sites.length === 0) {
    return (
      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-medium">開示台帳</h2>
        <p className="text-sm text-neutral-500">
          まだサイトがありません。設定タブの「CSV を取り込む」から CSV
          を取り込むと、ここに開示台帳が表示されます。
        </p>
      </section>
    );
  }

  const columns = buildLedgerColumns(sites);
  const tableWidthPx = ledgerTableWidthPx(
    attributeColumnWidths,
    columns.map((column) => column.attributeKey),
  );

  return (
    <section className="flex w-full min-w-0 flex-1 flex-col self-stretch gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-medium">
          開示台帳（
          {collectionFilter === "all"
            ? `${sites.length} サイト`
            : `${sites.length} 件中 ${visibleSites.length} 件を表示`}
          ）
        </h2>
        <p className="text-sm text-neutral-500">
          サイトを行、項目を列にした表形式です。チェックしたサイトを収集できます。CAPTCHA / MFA /
          検証ウォールは自動で突破せず、表示中のブラウザでご自身に解決をお願いします。
        </p>
      </div>

      {loadError && <p className="text-sm text-red-600">{loadError}</p>}
      {detailError && <p className="text-sm text-red-600">{detailError}</p>}

      <BatchCollectionBar
        selectedCount={selectedVisibleIds.length}
        totalVisible={visibleSites.length}
        batch={batch}
        currentSiteName={currentSite?.displayName}
        disabled={batchBusy}
        onStart={() => void startBatch()}
        onCancel={cancelBatch}
        onEnableSessionPersistence={() => void enableSessionPersistenceForSelected()}
        sessionPersistenceBulkRunning={sessionPersistenceBulkRunning}
        sessionPersistenceBulkError={sessionPersistenceBulkError}
      />

      {handoff && (
        <HandoffPanel
          handoff={handoff}
          onResume={resume}
          onSkip={skipCurrentSite}
          onCancelBatch={cancelBatch}
          onShowGuide={() => void showGuide(handoff.siteAccountId)}
        />
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor="ledger-collection-filter" className="text-sm font-medium">
          収集状態
        </Label>
        <select
          id="ledger-collection-filter"
          value={collectionFilter}
          disabled={batchBusy}
          onChange={(event) => {
            const value = event.target.value;
            if (value === "all" || value === "collected" || value === "uncollected") {
              setCollectionFilter(value);
            }
          }}
          className="rounded border border-neutral-300 bg-white px-2 py-1 text-sm"
          aria-label="収集状態で絞り込む"
        >
          <option value="all">すべて</option>
          <option value="collected">収集済み</option>
          <option value="uncollected">未収集</option>
        </select>
        <Label htmlFor="ledger-sort-mode" className="text-sm font-medium">
          並び順
        </Label>
        <select
          id="ledger-sort-mode"
          value={sortMode}
          disabled={batchBusy}
          onChange={(event) => setSortMode(event.target.value as LedgerSortMode)}
          className="rounded border border-neutral-300 bg-white px-2 py-1 text-sm"
        >
          <option value="manual">手動（ドラッグ）</option>
          <option value="name-asc">サイト名 昇順</option>
          <option value="name-desc">サイト名 降順</option>
        </select>
        {!allSelected && (
          <button
            type="button"
            disabled={batchBusy || visibleSites.length === 0}
            onClick={selectAllVisible}
            className="text-sm underline"
          >
            表示中をすべて選択
          </button>
        )}
        {selectedVisibleIds.length > 0 && (
          <button type="button" disabled={batchBusy} onClick={clearVisible} className="text-sm underline">
            表示中のチェックを外す
          </button>
        )}
      </div>

      <p className="sr-only" aria-live="polite">
        {orderAnnouncement}
      </p>

      <div className="ledger-table-viewport max-h-[60vh] overflow-x-auto rounded border border-neutral-200">
        <table
          className="border-collapse text-left text-sm"
          style={{ width: `${tableWidthPx}px`, minWidth: `${tableWidthPx}px` }}
        >
          <colgroup>
            <col className="ledger-col-select" />
            <col className="ledger-col-reorder" />
            <col className="ledger-col-site" />
            <col className="ledger-col-actions" />
            {columns.length === 0 ? (
              <col
                className="ledger-col-attribute"
                style={{
                  width: `${LEDGER_EMPTY_ATTRIBUTE_AREA_WIDTH_PX}px`,
                  minWidth: `${LEDGER_EMPTY_ATTRIBUTE_AREA_WIDTH_PX}px`,
                  maxWidth: `${LEDGER_EMPTY_ATTRIBUTE_AREA_WIDTH_PX}px`,
                }}
              />
            ) : (
              columns.map((column) => {
                const widthPx = ledgerAttributeColumnWidthPx(attributeColumnWidths, column.attributeKey);
                return (
                  <col
                    key={column.attributeKey}
                    className="ledger-col-attribute"
                    style={{
                      width: `${widthPx}px`,
                      minWidth: `${widthPx}px`,
                      maxWidth: `${widthPx}px`,
                    }}
                  />
                );
              })
            )}
          </colgroup>
          <thead>
            <tr className="border-b border-neutral-200 bg-neutral-50">
              <th
                scope="col"
                className="ledger-sticky-select ledger-col-select sticky top-0 bg-neutral-50 px-2 py-2"
              >
                <span className="sr-only">選択</span>
              </th>
              <th
                scope="col"
                className="ledger-sticky-reorder ledger-col-reorder sticky top-0 bg-neutral-50 px-1 py-2"
              >
                <span className="sr-only">並び替え</span>
              </th>
              <th
                scope="col"
                className="ledger-sticky-site ledger-col-site sticky top-0 bg-neutral-50 px-3 py-2 font-medium"
              >
                サイト
              </th>
              <th
                scope="col"
                className="ledger-sticky-actions ledger-col-actions sticky top-0 bg-neutral-50 px-3 py-2 font-medium"
              >
                操作
              </th>
              {columns.map((column) => {
                const widthPx = ledgerAttributeColumnWidthPx(attributeColumnWidths, column.attributeKey);
                return (
                  <th
                    key={column.attributeKey}
                    scope="col"
                    className="ledger-attribute-header"
                    style={{ width: `${widthPx}px` }}
                  >
                    <span className="ledger-attribute-header-inner">
                      {column.label}
                      <button
                        type="button"
                        className="ledger-col-resize-handle"
                        aria-label={`${column.label}列の幅を変更。左右矢印キーで調整`}
                        title="ドラッグまたは左右矢印で列幅を変更"
                        onPointerDown={(event) =>
                          onAttributeColumnResizePointerDown(column.attributeKey, event)
                        }
                        onPointerMove={onAttributeColumnResizePointerMove}
                        onPointerUp={onAttributeColumnResizePointerUp}
                        onPointerCancel={onAttributeColumnResizePointerUp}
                        onLostPointerCapture={onAttributeColumnResizeLostPointerCapture}
                        onKeyDown={(event) => {
                          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                            event.preventDefault();
                            const step = event.shiftKey ? 24 : 8;
                            nudgeAttributeColumnWidth(
                              column.attributeKey,
                              event.key === "ArrowRight" ? step : -step,
                            );
                          }
                        }}
                      />
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {orderedSites.map((site) => {
              const detailOpen = detail?.siteAccountId === site.siteAccountId;
              const savedPageOpen = savedPageSiteId === site.siteAccountId;
              const guideOpen = guideSiteId === site.siteAccountId;
              const expanded = detailOpen || savedPageOpen;
              const attributeColSpan = Math.max(columns.length, 1);
              return (
                <Fragment key={site.siteAccountId}>
                  <tr
                    className={`border-b border-neutral-100 ${draggedSiteId === site.siteAccountId ? "ledger-row-dragging" : ""}`}
                    onDragOver={(event) => {
                      if (sortMode === "manual" && draggedSiteId) event.preventDefault();
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      if (draggedSiteId) moveManualSite(draggedSiteId, site.siteAccountId);
                      setDraggedSiteId(undefined);
                    }}
                  >
                    <td className="ledger-sticky-select ledger-col-select bg-white px-2 py-2 align-top">
                      <input
                        type="checkbox"
                        checked={selected.has(site.siteAccountId)}
                        disabled={batchBusy}
                        onChange={(event) => selectSite(site.siteAccountId, event.target.checked)}
                        aria-label={site.displayName}
                        className="mt-1"
                      />
                    </td>
                    <td className="ledger-sticky-reorder ledger-col-reorder bg-white px-1 py-2 align-top">
                      <button
                        type="button"
                        draggable={sortMode === "manual" && !batchBusy}
                        disabled={sortMode !== "manual" || batchBusy}
                        onDragStart={(event) => {
                          event.dataTransfer.effectAllowed = "move";
                          setDraggedSiteId(site.siteAccountId);
                        }}
                        onDragEnd={() => setDraggedSiteId(undefined)}
                        onKeyDown={(event) => {
                          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                            event.preventDefault();
                            moveManualSiteBy(site.siteAccountId, event.key === "ArrowUp" ? -1 : 1);
                          }
                        }}
                        aria-label={`${site.displayName} を並び替え。上下矢印キーでも移動できます`}
                        title={
                          sortMode === "manual"
                            ? "ドラッグまたは上下矢印キーで並び替え"
                            : "手動モードで利用できます"
                        }
                        className="ledger-drag-handle rounded px-2 py-1 text-lg leading-none disabled:cursor-not-allowed disabled:opacity-30"
                      >
                        <span aria-hidden="true">⋮⋮</span>
                      </button>
                    </td>
                    <th
                      scope="row"
                      className="ledger-sticky-site ledger-col-site bg-white px-3 py-2 text-left align-top font-medium"
                    >
                      <span className="flex flex-col gap-1">
                        <span>{site.displayName}</span>
                        {(site.url ?? site.domain) ? (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              void openSite(site.siteAccountId);
                            }}
                            className="break-all text-left text-xs font-normal text-sky-700 underline decoration-sky-400 decoration-dotted underline-offset-2 hover:text-sky-800"
                            title="既定ブラウザで開く"
                          >
                            {site.url ?? site.domain}
                          </button>
                        ) : (
                          <span className="break-all text-xs font-normal text-neutral-400">URL なし</span>
                        )}
                        <SiteStatusChips site={site} running={runningSiteId === site.siteAccountId} />
                      </span>
                    </th>
                    <td className="ledger-sticky-actions ledger-col-actions bg-white px-3 py-2 align-top">
                      <span className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            if (detail?.siteAccountId === site.siteAccountId) {
                              setDetail(undefined);
                              return;
                            }
                            void openDetail(site.siteAccountId);
                          }}
                          className="rounded border border-neutral-300 px-3 py-1.5 text-sm"
                        >
                          詳細
                        </button>
                        <button
                          type="button"
                          disabled={batchBusy}
                          onClick={() =>
                            setSavedPageSiteId((current) =>
                              current === site.siteAccountId ? undefined : site.siteAccountId,
                            )
                          }
                          className="rounded border border-neutral-300 px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          保存ページを取り込む
                        </button>
                        <button
                          type="button"
                          disabled={batchBusy}
                          onClick={() => requestDelete(site)}
                          title={`${site.displayName} の情報を削除`}
                          aria-label={`${site.displayName} の情報を削除`}
                          className="rounded border border-red-300 px-3 py-1.5 text-sm text-red-700 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          削除
                        </button>
                      </span>
                    </td>
                    {columns.length === 0 ? (
                      <td
                        className="px-3 py-2 align-top text-neutral-500"
                        style={{
                          width: `${LEDGER_EMPTY_ATTRIBUTE_AREA_WIDTH_PX}px`,
                          minWidth: `${LEDGER_EMPTY_ATTRIBUTE_AREA_WIDTH_PX}px`,
                        }}
                      >
                        未収集 — 上の「選択したサイトを収集」で開示を集められます
                      </td>
                    ) : site.collected ? (
                      columns.map((column) => (
                        <LedgerCell
                          key={column.attributeKey}
                          disclosure={disclosureFor(site, column.attributeKey)}
                        />
                      ))
                    ) : (
                      <td colSpan={columns.length} className="px-3 py-2 text-neutral-400">
                        未収集
                      </td>
                    )}
                  </tr>
                  {expanded && (
                    <tr className="border-b border-neutral-100 bg-neutral-50">
                      <td colSpan={4 + attributeColSpan} className="px-3 py-3">
                        <div className="flex flex-col gap-3">
                          {savedPageOpen && (
                            <div className="flex flex-col gap-2">
                              {guideOpen && (
                                <SavedPageImportGuide
                                  site={site}
                                  disabled={guideInteractiveDisabled}
                                  onOpenSite={() => void openSite(site.siteAccountId)}
                                  onSkip={() => void markManual(site.siteAccountId)}
                                />
                              )}
                              <SavedPageImportPanel
                                siteAccountId={site.siteAccountId}
                                disabled={guideInteractiveDisabled}
                                onImported={() => {
                                  setGuideSiteId(undefined);
                                  void loadSites();
                                  onCollectedRef.current();
                                }}
                                onClose={() => setSavedPageSiteId(undefined)}
                              />
                            </div>
                          )}
                          {detailOpen && detail && (
                            <SiteDetail
                              detail={detail}
                              onClose={() => setDetail(undefined)}
                              onReload={() => openDetail(site.siteAccountId, { refresh: true })}
                            />
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {resultModal && (
        <CollectionResultModal
          content={resultModal}
          onClose={() => setResultModal(undefined)}
          onRetry={retrySite}
          onImportSavedPage={importSavedPageFor}
        />
      )}
      {deleteTarget && (
        <DeleteSiteModal
          site={deleteTarget}
          acknowledged={deleteAcknowledged}
          deleting={deletingSite}
          onAcknowledgedChange={setDeleteAcknowledged}
          onCancel={closeDeleteModal}
          onConfirm={() => void confirmDelete()}
        />
      )}
    </section>
  );
}

function SiteStatusChips({
  site,
  running,
}: {
  site: SiteLedgerSummary;
  running: boolean;
}): React.JSX.Element {
  return (
    <span className="flex flex-wrap items-center gap-2 text-xs font-normal text-neutral-500">
      {site.collected ? (
        <span className="text-green-700">収集済み（開示 {site.disclosureCount}）</span>
      ) : (
        <span className="text-neutral-400">未収集</span>
      )}
      {site.stale.stale > 0 && (
        <span className="rounded bg-red-100 px-1.5 py-0.5 text-red-700">古い {site.stale.stale}</span>
      )}
      {site.stale.unknown > 0 && (
        <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-neutral-600">
          不明 {site.stale.unknown}
        </span>
      )}
      {site.relationshipKinds.map((kind) => (
        <span key={kind} className="rounded bg-blue-50 px-1.5 py-0.5 text-blue-700">
          {relationshipLabel(kind)}
        </span>
      ))}
      {site.constraintCount > 0 && (
        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-800">
          要確認 {site.constraintCount}
        </span>
      )}
      {running && <span className="text-neutral-700">収集中…</span>}
    </span>
  );
}

/** One spreadsheet cell: a site's value for one attribute column, if collected. */
function LedgerCell({ disclosure }: { disclosure: DisclosureView | undefined }): React.JSX.Element {
  const reveal = useDisclosureReveal(disclosure?.disclosureId ?? "");

  if (!disclosure) {
    return <td className="ledger-attribute-cell text-neutral-400">—</td>;
  }

  return (
    <td className="ledger-attribute-cell">
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-start gap-2">
          <span className="font-mono">{reveal.value ?? (disclosure.preview || "—")}</span>
          {disclosure.revealable && reveal.value === undefined && !reveal.revealing && (
            <button type="button" onClick={() => reveal.setRevealing(true)} className="text-xs underline">
              表示
            </button>
          )}
          {reveal.value !== undefined && (
            <button type="button" onClick={reveal.hide} className="text-xs underline">
              隠す
            </button>
          )}
        </div>
        <div className="flex items-center gap-1">
          <StaleBadge state={disclosure.staleState} />
          <SourceBadge sourceKind={disclosure.sourceKind} />
        </div>

        {reveal.revealing && (
          <form
            className="flex flex-col gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              void reveal.reveal();
            }}
          >
            <Label htmlFor={`reveal-cell-${disclosure.disclosureId}`} className="sr-only">
              パスフレーズ
            </Label>
            <input
              id={`reveal-cell-${disclosure.disclosureId}`}
              type="password"
              autoComplete="off"
              placeholder="パスフレーズを再入力"
              value={reveal.passphrase}
              onChange={(event) => reveal.setPassphrase(event.target.value)}
              className="rounded border border-neutral-300 px-2 py-1 text-xs"
            />
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={reveal.busy || reveal.passphrase.length === 0}
                className="rounded bg-neutral-900 px-2 py-1 text-xs text-white disabled:opacity-50"
              >
                確認して表示
              </button>
              <button type="button" onClick={reveal.cancel} className="text-xs underline">
                取消
              </button>
            </div>
          </form>
        )}

        {reveal.error && <p className="text-xs text-red-600">{reveal.error}</p>}
      </div>
    </td>
  );
}

export function SiteDetail({
  detail,
  onClose,
  onReload,
}: {
  detail: SiteLedgerDetail;
  onClose: () => void;
  /** Re-fetches this site's detail, e.g. after confirming a pending candidate. */
  onReload: () => void | Promise<void>;
}): React.JSX.Element {
  const disclosureGroups = buildSiteDetailDisclosureGroups(detail.disclosures);

  return (
    <div className="flex max-w-2xl flex-col gap-3 rounded border border-neutral-200 bg-white p-3 sm:p-4">
      <div className="flex flex-col gap-2">
        <button type="button" onClick={onClose} className="self-start text-sm underline">
          閉じる
        </button>
        <h3 className="font-medium">{detail.displayName}</h3>
      </div>

      {detail.disclosures.length === 0 ? (
        <p className="text-sm text-neutral-500">このサイトの開示はまだ収集されていません。</p>
      ) : (
        <div className="flex flex-col gap-4">
          {disclosureGroups.map((group) => (
            <section
              key={group.label}
              className="flex flex-col gap-2"
              aria-labelledby={`disclosure-${group.label}`}
            >
              <h4 id={`disclosure-${group.label}`} className="text-xs font-medium text-neutral-600">
                {group.label}
              </h4>
              <ul className="flex flex-col gap-2">
                {group.disclosures.map((disclosure) => (
                  <DisclosureRow key={disclosure.disclosureId} disclosure={disclosure} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {detail.pendingAttributeCandidates.length > 0 && (
        <div className="flex flex-col gap-2 rounded border border-blue-100 bg-blue-50 p-2">
          <p className="text-xs font-medium text-blue-900">新しい項目が見つかりました</p>
          <ul className="flex flex-col gap-2">
            {detail.pendingAttributeCandidates.map((candidate) => (
              <PendingCandidateRow key={candidate.id} candidate={candidate} onConfirmed={onReload} />
            ))}
          </ul>
        </div>
      )}

      {detail.relationships.length > 0 && (
        <div className="text-xs text-neutral-500">
          関係: {detail.relationships.map((r) => relationshipLabel(r.kind)).join("、")}
        </div>
      )}

      {detail.constraints.length > 0 && (
        <ul className="flex flex-col gap-1 text-xs text-amber-800">
          {detail.constraints.map((constraint, index) => (
            <li key={index}>要確認: {constraint.detail}</li>
          ))}
        </ul>
      )}

      <SiteCredentialUpdateControl
        siteAccountId={detail.siteAccountId}
        credentials={detail.credentials}
        onReload={onReload}
      />

      <SessionPersistenceControl
        siteAccountId={detail.siteAccountId}
        sessionPersistence={detail.sessionPersistence}
        onReload={onReload}
      />
    </div>
  );
}

/**
 * Update stored site login credentials from the ledger (Issue #362). Password
 * is write-only (type=password, never prefilled). Overwrite needs a light
 * confirmation checkbox — not the fourth absolute boundary (deletion).
 */
function SiteCredentialUpdateControl({
  siteAccountId,
  credentials,
  onReload,
}: {
  siteAccountId: string;
  credentials: SiteCredentialView[];
  onReload: () => void | Promise<void>;
}): React.JSX.Element {
  const primary = credentials[0];
  if (!primary) {
    return (
      <div className="rounded border border-neutral-200 p-2 text-xs text-neutral-500">
        保存済みのログイン認証情報がありません。CSV 取り込みで追加するか、再取り込みしてください。
      </div>
    );
  }

  // Remount only when the credential id changes (site switch / different row).
  // Do not key on updatedAt — a successful save reloads detail and would wipe
  // the success banner if the form remounted.
  return (
    <SiteCredentialUpdateForm
      key={primary.credentialId}
      siteAccountId={siteAccountId}
      credential={primary}
      credentialCount={credentials.length}
      onReload={onReload}
    />
  );
}

function SiteCredentialUpdateForm({
  siteAccountId,
  credential,
  credentialCount,
  onReload,
}: {
  siteAccountId: string;
  credential: SiteCredentialView;
  credentialCount: number;
  onReload: () => void | Promise<void>;
}): React.JSX.Element {
  const [username, setUsername] = useState(credential.username);
  const [password, setPassword] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [savedAt, setSavedAt] = useState<number | undefined>();
  // Local mirror of last-known server metadata so "最終更新" updates after save
  // even though the form is keyed only by credentialId.
  const [metaUpdatedAt, setMetaUpdatedAt] = useState(credential.updatedAt);
  const [metaSource, setMetaSource] = useState(credential.source);

  const save = useCallback(async () => {
    const trimmedUsername = username.trim();
    const usernameChanged = trimmedUsername !== "" && trimmedUsername !== credential.username;
    // Match domain: non-empty after trim only (spaces-only is not a password change).
    const passwordChanged = password !== "" && password.trim() !== "";
    if (!usernameChanged && !passwordChanged) {
      setError(reasonMessage("invalid-request"));
      return;
    }
    if (!confirmed) {
      setError(reasonMessage("confirmation-required"));
      return;
    }

    setBusy(true);
    setError(undefined);
    setSavedAt(undefined);
    try {
      const result = await window.soroeru.ledger.updateCredential({
        siteAccountId,
        credentialId: credential.credentialId,
        ...(usernameChanged ? { username: trimmedUsername } : {}),
        ...(passwordChanged ? { password } : {}),
        confirmedOverwrite: true,
      });
      if (!result.ok) {
        setError(reasonMessage(result.error));
        return;
      }
      setPassword("");
      setConfirmed(false);
      setSavedAt(result.credential?.updatedAt ?? Date.now());
      if (result.credential) {
        setUsername(result.credential.username);
        setMetaUpdatedAt(result.credential.updatedAt);
        setMetaSource(result.credential.source);
      }
      // Reload parent list after painting success so the banner is not wiped by
      // a remount (form key is credentialId only).
      await onReload();
    } catch {
      setError(reasonMessage(undefined));
    } finally {
      setBusy(false);
    }
  }, [confirmed, credential.credentialId, credential.username, onReload, password, siteAccountId, username]);

  return (
    <div className="flex flex-col gap-2 rounded border border-neutral-200 p-2 text-xs">
      <p className="font-medium text-neutral-800">ログイン認証情報を更新</p>
      <p className="text-neutral-500">
        サイト側でパスワードを変更した場合などに、Soroeru
        内の保存値を上書きします。既存のパスワードは表示しません（入力はマスク）。
      </p>
      {credentialCount > 1 && (
        <p className="text-amber-800">
          このサイトには認証情報が {credentialCount} 件あります。先頭の 1 件を編集します（ログイン ID:{" "}
          {credential.username}）。
        </p>
      )}
      <label className="flex flex-col gap-1 text-neutral-700">
        <span>ログイン ID</span>
        <input
          type="text"
          autoComplete="off"
          value={username}
          disabled={busy}
          onChange={(event) => setUsername(event.target.value)}
          className="rounded border border-neutral-300 px-2 py-1 text-sm"
        />
      </label>
      <label className="flex flex-col gap-1 text-neutral-700">
        <span>新しいパスワード</span>
        <input
          type="password"
          autoComplete="new-password"
          value={password}
          disabled={busy}
          placeholder="変更する場合のみ入力"
          onChange={(event) => setPassword(event.target.value)}
          className="rounded border border-neutral-300 px-2 py-1 text-sm"
        />
      </label>
      <label className="flex items-start gap-2 text-neutral-700">
        <input
          type="checkbox"
          checked={confirmed}
          disabled={busy}
          onChange={(event) => setConfirmed(event.target.checked)}
          className="mt-0.5"
        />
        <span>既存のログイン認証情報を上書きすることを確認しました（旧パスワードは失われます）。</span>
      </label>
      <button
        type="button"
        disabled={busy || !confirmed}
        onClick={() => void save()}
        className="self-start rounded bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? "保存中…" : "認証情報を保存"}
      </button>
      {savedAt !== undefined && (
        <p className="text-green-700">保存しました（{new Date(savedAt).toLocaleString("ja-JP")}）。</p>
      )}
      {error && <p className="text-red-600">{error}</p>}
      <p className="text-neutral-400">
        最終更新: {new Date(metaUpdatedAt).toLocaleString("ja-JP")}
        {metaSource === "csv-import" ? "（CSV 取り込み）" : "（手動更新）"}
      </p>
    </div>
  );
}

/**
 * Opt-in per-site toggle for persisting a browser session across Visibility
 * runs (Issue #294). Disabling clears any persisted session immediately
 * (server-enforced, unconditional/immediate — this control is just the UI for
 * it); "今すぐ削除" clears one on demand while staying enabled.
 */
function SessionPersistenceControl({
  siteAccountId,
  sessionPersistence,
  onReload,
}: {
  siteAccountId: string;
  sessionPersistence: SessionPersistenceView;
  onReload: () => void | Promise<void>;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const toggle = useCallback(async () => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await window.soroeru.sessionPersistence.set({
        siteAccountId,
        enabled: !sessionPersistence.enabled,
      });
      if (!result.ok) setError(reasonMessage(result.error));
    } catch {
      setError(reasonMessage(undefined));
    } finally {
      await onReload();
      setBusy(false);
    }
  }, [onReload, sessionPersistence.enabled, siteAccountId]);

  const clearNow = useCallback(async () => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await window.soroeru.sessionPersistence.clear(siteAccountId);
      if (!result.ok) setError(reasonMessage(result.error));
    } catch {
      setError(reasonMessage(undefined));
    } finally {
      await onReload();
      setBusy(false);
    }
  }, [onReload, siteAccountId]);

  return (
    <div className="flex flex-col gap-1 rounded border border-neutral-200 p-2 text-xs">
      <label className="flex items-center gap-2 text-neutral-700">
        <input
          type="checkbox"
          checked={sessionPersistence.enabled}
          disabled={busy}
          onChange={() => void toggle()}
        />
        <span>ログインセッションを保持する（収集のたびに毎回ログインし直さない）</span>
      </label>
      <p className="text-neutral-500">
        {sessionPersistence.hasPersistedSession
          ? `保存済み（最終更新: ${new Date(sessionPersistence.updatedAt ?? 0).toLocaleString("ja-JP")}）`
          : "保存されたセッションはありません。"}
      </p>
      {sessionPersistence.hasPersistedSession && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void clearNow()}
          className="self-start text-red-700 underline"
        >
          今すぐ削除
        </button>
      )}
      {error && <p className="text-red-600">{error}</p>}
    </div>
  );
}

function PendingCandidateRow({
  candidate,
  onConfirmed,
}: {
  candidate: PendingAttributeCandidateView;
  onConfirmed: () => void | Promise<void>;
}): React.JSX.Element {
  const [label, setLabel] = useState(candidate.label);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const confirm = useCallback(async () => {
    const trimmed = label.trim();
    if (trimmed === "") return;
    setBusy(true);
    setError(undefined);
    let confirmedOk = false;
    try {
      const result = await window.soroeru.ledger.confirmDynamicCandidate({
        proposedAttributeKey: candidate.proposedAttributeKey,
        label: trimmed,
        matchTerms: [...candidate.matchTerms, trimmed],
      });
      confirmedOk = result.ok;
      if (!result.ok) {
        setError(reasonMessage(result.error));
      }
    } catch {
      setError(reasonMessage(undefined));
    } finally {
      setBusy(false);
    }
    if (confirmedOk) await onConfirmed();
  }, [candidate.matchTerms, candidate.proposedAttributeKey, label, onConfirmed]);

  return (
    <li className="flex flex-col gap-1 text-sm">
      <form
        className="flex flex-col gap-2 sm:flex-row sm:items-center"
        onSubmit={(event) => {
          event.preventDefault();
          void confirm();
        }}
      >
        <Label htmlFor={`candidate-${candidate.id}`} className="sr-only">
          項目名
        </Label>
        <input
          id={`candidate-${candidate.id}`}
          type="text"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          className="flex-1 rounded border border-neutral-300 px-2 py-1 text-xs"
        />
        <button
          type="submit"
          disabled={busy || label.trim() === ""}
          className="rounded bg-neutral-900 px-2 py-1 text-xs text-white disabled:opacity-50"
        >
          この項目として追加する
        </button>
      </form>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </li>
  );
}

/**
 * Shared re-authenticated reveal state machine for a single Disclosure, used by
 * both the list-style `DisclosureRow` and the spreadsheet's `LedgerCell` — two
 * different layouts around the same security-sensitive flow (never persist the
 * revealed value; clear it on hide/unmount).
 */
function useDisclosureReveal(disclosureId: string): {
  revealing: boolean;
  setRevealing: (revealing: boolean) => void;
  passphrase: string;
  setPassphrase: (passphrase: string) => void;
  value: string | undefined;
  error: string | undefined;
  busy: boolean;
  reveal: () => Promise<void>;
  hide: () => void;
  cancel: () => void;
} {
  const [revealing, setRevealing] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [value, setValue] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const reveal = useCallback(async () => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await window.soroeru.ledger.reveal(disclosureId, passphrase);
      if (!result.ok || result.value === undefined) {
        setError(reasonMessage(result.error));
        return;
      }
      setValue(result.value);
      setRevealing(false);
      setPassphrase("");
    } catch {
      setError(reasonMessage(undefined));
    } finally {
      setBusy(false);
    }
  }, [disclosureId, passphrase]);

  const hide = useCallback(() => {
    setValue(undefined);
    setError(undefined);
  }, []);

  const cancel = useCallback(() => {
    setRevealing(false);
    setPassphrase("");
    setError(undefined);
  }, []);

  return { revealing, setRevealing, passphrase, setPassphrase, value, error, busy, reveal, hide, cancel };
}

function DisclosureRow({ disclosure }: { disclosure: DisclosureView }): React.JSX.Element {
  const { revealing, setRevealing, passphrase, setPassphrase, value, error, busy, reveal, hide, cancel } =
    useDisclosureReveal(disclosure.disclosureId);

  return (
    <li className="flex flex-col gap-1 text-sm">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-2">
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="break-words">{disclosure.label}</span>
          <StaleBadge state={disclosure.staleState} />
          <SourceBadge sourceKind={disclosure.sourceKind} />
        </span>
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="break-all font-mono text-neutral-500">{value ?? (disclosure.preview || "—")}</span>
          {disclosure.revealable && value === undefined && !revealing && (
            <button type="button" onClick={() => setRevealing(true)} className="text-xs underline">
              表示
            </button>
          )}
          {value !== undefined && (
            <button type="button" onClick={hide} className="text-xs underline">
              隠す
            </button>
          )}
        </span>
      </div>

      {revealing && (
        <form
          className="flex flex-col gap-2 sm:flex-row sm:items-center"
          onSubmit={(event) => {
            event.preventDefault();
            void reveal();
          }}
        >
          <Label htmlFor={`reveal-${disclosure.disclosureId}`} className="sr-only">
            パスフレーズ
          </Label>
          <input
            id={`reveal-${disclosure.disclosureId}`}
            type="password"
            autoComplete="off"
            placeholder="パスフレーズを再入力"
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
            className="min-w-0 flex-1 rounded border border-neutral-300 px-2 py-1 text-xs"
          />
          <button
            type="submit"
            disabled={busy || passphrase.length === 0}
            className="rounded bg-neutral-900 px-2 py-1 text-xs text-white disabled:opacity-50"
          >
            確認して表示
          </button>
          <button type="button" onClick={cancel} className="text-xs underline">
            取消
          </button>
        </form>
      )}

      {error && <p className="text-xs text-red-600">{error}</p>}
    </li>
  );
}

function SourceBadge({ sourceKind }: { sourceKind: DisclosureView["sourceKind"] }): React.JSX.Element | null {
  if (sourceKind !== "manual-import") return null;
  return <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-600">保存ページ</span>;
}

function StaleBadge({ state }: { state: DisclosureView["staleState"] }): React.JSX.Element {
  const cls =
    state === "stale"
      ? "bg-red-100 text-red-700"
      : state === "current"
        ? "bg-green-100 text-green-700"
        : "bg-neutral-100 text-neutral-600";
  return <span className={`rounded px-1.5 py-0.5 text-xs ${cls}`}>{staleLabel(state)}</span>;
}
