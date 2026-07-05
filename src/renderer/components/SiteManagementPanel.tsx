import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  SiteLedgerDetail,
  SiteLedgerSummary,
  VisibilityEvent,
  VisibilityHandoffCredentialView,
} from "../../../electron/ipc/contract.js";
import {
  collectVisibleSelectedSiteIds,
  enableSessionPersistenceForSites,
  runVisibilityBatch,
  type BatchResultEntry,
} from "../site-management-batch.js";
import {
  buildCollectionResultModalContent,
  type CollectionResultModalContent,
} from "../collection-result-summary.js";
import { reasonMessage, relationshipLabel } from "../messages.js";
import { CsvImportPanel } from "./CsvImportPanel.js";
import { Modal } from "./Modal.js";
import { SavedPageImportPanel } from "./SavedPageImportPanel.js";
import { SiteDetail } from "./LedgerPanel.js";

const guideWallImage = new URL("../assets/saved-page-guide-wall.png", import.meta.url).href;
const guideAccountImage = new URL("../assets/saved-page-guide-account.png", import.meta.url).href;
const CREDENTIAL_CLIPBOARD_CLEAR_MS = 30_000;

interface SiteManagementPanelProps {
  reloadToken: number;
  onImported: () => void;
  onCollected: () => void;
}

interface HandoffState {
  siteAccountId: string;
  instruction: string;
  fallbackSuggested: boolean;
  credential: VisibilityHandoffCredentialView | undefined;
}

type BatchPhase = "idle" | "running" | "paused" | "canceling" | "done";

interface BatchProgress {
  phase: BatchPhase;
  queue: string[];
  currentSiteId: string | undefined;
  completed: number;
  results: BatchResultEntry[];
}

const emptyProgress: BatchProgress = {
  phase: "idle",
  queue: [],
  currentSiteId: undefined,
  completed: 0,
  results: [],
};

export function SiteManagementPanel({
  reloadToken,
  onImported,
  onCollected,
}: SiteManagementPanelProps): React.JSX.Element {
  const [sites, setSites] = useState<SiteLedgerSummary[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | undefined>();
  const [runningSiteId, setRunningSiteId] = useState<string | undefined>();
  const [savedPageSiteId, setSavedPageSiteId] = useState<string | undefined>();
  const [guideSiteId, setGuideSiteId] = useState<string | undefined>();
  const [handoff, setHandoff] = useState<HandoffState | undefined>();
  const [detail, setDetail] = useState<SiteLedgerDetail | undefined>();
  const [detailError, setDetailError] = useState<string | undefined>();
  const [batch, setBatch] = useState<BatchProgress>(emptyProgress);
  const [sessionPersistenceBulkRunning, setSessionPersistenceBulkRunning] = useState(false);
  const [sessionPersistenceBulkError, setSessionPersistenceBulkError] = useState<string | undefined>();
  const [resultModal, setResultModal] = useState<CollectionResultModalContent | undefined>();
  const [deleteTarget, setDeleteTarget] = useState<SiteLedgerSummary | undefined>();
  const [deleteAcknowledged, setDeleteAcknowledged] = useState(false);
  const [deletingSite, setDeletingSite] = useState(false);
  const resumedHandoffSites = useRef<Set<string>>(new Set());
  const cancelBatchRef = useRef(false);
  const onCollectedRef = useRef(onCollected);
  const sitesRef = useRef(sites);

  useEffect(() => {
    onCollectedRef.current = onCollected;
  }, [onCollected]);

  useEffect(() => {
    sitesRef.current = sites;
  }, [sites]);

  const loadSites = useCallback(async () => {
    try {
      const nextSites = await window.soroeru.ledger.sites();
      setSites(nextSites);
      setLoadError(undefined);
      setSelected((current) => {
        const validIds = new Set(nextSites.map((site) => site.siteAccountId));
        return new Set([...current].filter((siteAccountId) => validIds.has(siteAccountId)));
      });
    } catch {
      setLoadError(reasonMessage(undefined));
    } finally {
      setLoading(false);
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
          setRunningSiteId(event.siteAccountId);
          setHandoff(undefined);
          setGuideSiteId(undefined);
          resumedHandoffSites.current.delete(event.siteAccountId);
          break;
        case "handoff":
          setBatch((current) => ({ ...current, phase: "paused" }));
          setHandoff({
            siteAccountId: event.siteAccountId,
            instruction: event.instruction,
            fallbackSuggested: resumedHandoffSites.current.has(event.siteAccountId),
            credential: event.credential,
          });
          if (resumedHandoffSites.current.has(event.siteAccountId)) setGuideSiteId(event.siteAccountId);
          break;
        case "resumed":
          resumedHandoffSites.current.add(event.siteAccountId);
          setBatch((current) => ({
            ...current,
            phase: current.queue.length > 0 ? "running" : current.phase,
          }));
          setHandoff(undefined);
          break;
        case "run-finished":
          setRunningSiteId(undefined);
          setHandoff(undefined);
          resumedHandoffSites.current.delete(event.result.siteAccountId);
          void loadSites();
          onCollectedRef.current();
          break;
      }
    });
    return unsubscribe;
  }, [loadSites]);

  const visibleSites = sites;
  const selectedVisibleIds = useMemo(
    () => collectVisibleSelectedSiteIds(visibleSites, selected),
    [selected, visibleSites],
  );
  const batchBusy = batch.phase === "running" || batch.phase === "paused" || batch.phase === "canceling";
  const currentSite = sites.find((site) => site.siteAccountId === batch.currentSiteId);

  const refreshAfterSite = useCallback(
    async (siteAccountId: string, result: BatchResultEntry) => {
      await loadSites();
      onCollectedRef.current();
      setBatch((current) => ({
        ...current,
        completed: current.completed + 1,
        results: [...current.results, result],
        currentSiteId: siteAccountId,
      }));
    },
    [loadSites],
  );

  const startBatch = useCallback(
    async (overrideIds?: string[]) => {
      const queue = overrideIds ?? [...selectedVisibleIds];
      if (queue.length === 0 || batchBusy) return;
      cancelBatchRef.current = false;
      setLoadError(undefined);
      setResultModal(undefined);
      setBatch({ phase: "running", queue, currentSiteId: queue[0], completed: 0, results: [] });
      try {
        const summary = await runVisibilityBatch(queue, {
          run: async (siteAccountId) => {
            setBatch((current) => ({ ...current, phase: "running", currentSiteId: siteAccountId }));
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
      }
    },
    [batchBusy, refreshAfterSite, selectedVisibleIds],
  );

  const cancelBatch = useCallback(() => {
    cancelBatchRef.current = true;
    if (runningSiteId !== undefined || handoff) void window.soroeru.visibility.abort();
    setBatch((current) => ({ ...current, phase: "canceling" }));
  }, [handoff, runningSiteId]);

  const resume = useCallback(() => void window.soroeru.visibility.resume(), []);
  const skipCurrentSite = useCallback(() => void window.soroeru.visibility.abort(), []);
  const waitForVisibilityIdle = useCallback(async () => {
    for (let i = 0; i < 20; i++) {
      const status = await window.soroeru.visibility.status();
      if (!status.running) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }, []);
  const showGuide = useCallback(
    async (siteAccountId: string) => {
      cancelBatchRef.current = true;
      setBatch((current) => ({ ...current, phase: "canceling" }));
      await window.soroeru.visibility.abort();
      await waitForVisibilityIdle();
      setRunningSiteId(undefined);
      setHandoff(undefined);
      setGuideSiteId(siteAccountId);
      setSavedPageSiteId(siteAccountId);
    },
    [waitForVisibilityIdle],
  );
  const markManual = useCallback(
    async (siteAccountId: string) => {
      await window.soroeru.visibility.abort();
      await waitForVisibilityIdle();
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
  const openDetail = useCallback(async (siteAccountId: string) => {
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
      if (detail && ids.includes(detail.siteAccountId)) await openDetail(detail.siteAccountId);
    } finally {
      setSessionPersistenceBulkRunning(false);
    }
  }, [detail, openDetail, selectedVisibleIds, sessionPersistenceBulkRunning]);
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
    setSelected((current) => new Set([...current, ...visibleSites.map((site) => site.siteAccountId)]));
  }, [visibleSites]);
  const clearVisible = useCallback(() => {
    setSelected((current) => {
      const visibleIds = new Set(visibleSites.map((site) => site.siteAccountId));
      return new Set([...current].filter((siteAccountId) => !visibleIds.has(siteAccountId)));
    });
  }, [visibleSites]);

  if (loading) return <p className="text-sm text-neutral-500">読み込み中…</p>;

  return (
    <section className="flex flex-col gap-6">
      <CsvImportPanel onImported={onImported} />

      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-medium">サイト管理</h2>
          <p className="text-sm text-neutral-500">
            取り込んだサイトを選び、上から順に Visibility 収集します。CAPTCHA / MFA /
            検証ウォールは自動で突破せず、 表示中のブラウザでご自身に解決をお願いします。
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

        {sites.length === 0 ? (
          <p className="text-sm text-neutral-500">
            まだサイトがありません。上の「CSV を取り込む」から CSV
            を取り込むと、ここに収集対象が表示されます。
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={batchBusy || visibleSites.length === 0}
                onClick={selectAllVisible}
                className="text-sm underline"
              >
                全てにチェックする
              </button>
              <button
                type="button"
                disabled={batchBusy || selectedVisibleIds.length === 0}
                onClick={clearVisible}
                className="text-sm underline"
              >
                全てのチェックを外す
              </button>
            </div>
            <ul className="flex flex-col divide-y divide-neutral-200">
              {sites.map((site) => (
                <SiteRow
                  key={site.siteAccountId}
                  site={site}
                  checked={selected.has(site.siteAccountId)}
                  disabled={batchBusy}
                  savedPageOpen={savedPageSiteId === site.siteAccountId}
                  guideOpen={guideSiteId === site.siteAccountId}
                  detailOpen={detail?.siteAccountId === site.siteAccountId}
                  detail={detail?.siteAccountId === site.siteAccountId ? detail : undefined}
                  running={runningSiteId === site.siteAccountId}
                  onCheckedChange={(checked) => selectSite(site.siteAccountId, checked)}
                  onToggleSavedPage={() =>
                    setSavedPageSiteId((current) =>
                      current === site.siteAccountId ? undefined : site.siteAccountId,
                    )
                  }
                  onOpenSite={() => void openSite(site.siteAccountId)}
                  onMarkManual={() => void markManual(site.siteAccountId)}
                  onSavedPageImported={() => {
                    setGuideSiteId(undefined);
                    void loadSites();
                    onCollectedRef.current();
                  }}
                  onOpenDetail={() => void openDetail(site.siteAccountId)}
                  onCloseDetail={() => setDetail(undefined)}
                  onReloadDetail={() => openDetail(site.siteAccountId)}
                  onRequestDelete={() => requestDelete(site)}
                />
              ))}
            </ul>
          </>
        )}
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

function BatchCollectionBar({
  selectedCount,
  totalVisible,
  batch,
  currentSiteName,
  disabled,
  onStart,
  onCancel,
  onEnableSessionPersistence,
  sessionPersistenceBulkRunning,
  sessionPersistenceBulkError,
}: {
  selectedCount: number;
  totalVisible: number;
  batch: BatchProgress;
  currentSiteName: string | undefined;
  disabled: boolean;
  onStart: () => void;
  onCancel: () => void;
  onEnableSessionPersistence: () => void;
  sessionPersistenceBulkRunning: boolean;
  sessionPersistenceBulkError: string | undefined;
}): React.JSX.Element {
  const successful = batch.results.filter((entry) => entry.status === "collected").length;
  const failed = batch.results.filter((entry) => entry.status !== "collected").length;
  return (
    <div className="flex flex-col gap-2 rounded border border-neutral-200 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={selectedCount === 0 || disabled}
          onClick={onStart}
          className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:cursor-not-allowed disabled:bg-neutral-300"
        >
          選択したサイトを収集
        </button>
        <button
          type="button"
          disabled={selectedCount === 0 || disabled || sessionPersistenceBulkRunning}
          onClick={onEnableSessionPersistence}
          className="rounded border border-neutral-300 px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50"
        >
          {sessionPersistenceBulkRunning ? "設定中…" : "選択したサイトのログインセッションを保持する"}
        </button>
        {disabled && (
          <button type="button" onClick={onCancel} className="text-sm text-red-700 underline">
            一括収集を中止
          </button>
        )}
      </div>
      {sessionPersistenceBulkError && <p className="text-xs text-red-600">{sessionPersistenceBulkError}</p>}
      <p className="text-xs text-neutral-500">
        選択中 {selectedCount} / 表示中 {totalVisible}
        {batch.phase === "running" || batch.phase === "paused"
          ? `。実行中: ${currentSiteName ?? batch.currentSiteId ?? "サイト"}（${batch.completed} / ${batch.queue.length} 件完了）`
          : ""}
        {batch.phase === "canceling" ? "。中止中: 現在の収集が終わるまで待っています" : ""}
        {batch.phase === "done"
          ? `。完了: 成功 ${successful} / 要確認 ${failed}（${batch.completed} / ${batch.queue.length} 件）`
          : ""}
      </p>
    </div>
  );
}

function CollectionResultModal({
  content,
  onClose,
  onRetry,
  onImportSavedPage,
}: {
  content: CollectionResultModalContent;
  onClose: () => void;
  onRetry: (siteAccountId: string) => void;
  onImportSavedPage: (siteAccountId: string) => void;
}): React.JSX.Element {
  return (
    <Modal title={content.title} onClose={onClose}>
      <ul className="flex flex-col gap-3">
        {content.failures.map((failure) => (
          <li
            key={failure.siteAccountId}
            className="flex flex-col gap-1 rounded border border-neutral-200 p-2"
          >
            <span className="font-medium">{failure.siteName}</span>
            <span className="text-sm text-neutral-700">{failure.reason}</span>
            {(failure.canRetry || failure.canImportSavedPage) && (
              <span className="mt-1 flex flex-wrap gap-2">
                {failure.canRetry && (
                  <button
                    type="button"
                    onClick={() => onRetry(failure.siteAccountId)}
                    className="text-sm underline"
                  >
                    再収集
                  </button>
                )}
                {failure.canImportSavedPage && (
                  <button
                    type="button"
                    onClick={() => onImportSavedPage(failure.siteAccountId)}
                    className="text-sm underline"
                  >
                    保存ページを取り込む
                  </button>
                )}
              </span>
            )}
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={onClose}
        className="self-end rounded border border-neutral-300 px-3 py-1.5 text-sm"
      >
        閉じる
      </button>
    </Modal>
  );
}

function HandoffPanel({
  handoff,
  onResume,
  onSkip,
  onCancelBatch,
  onShowGuide,
}: {
  handoff: HandoffState;
  onResume: () => void;
  onSkip: () => void;
  onCancelBatch: () => void;
  onShowGuide: () => void;
}): React.JSX.Element {
  return (
    <Modal
      title={handoff.fallbackSuggested ? "別の方法で取り込めます" : "ウォールの解決が必要です"}
      onClose={() => undefined}
      dismissible={false}
    >
      <p className="text-sm text-amber-800">{handoff.instruction}</p>
      <p className="text-sm text-neutral-700">
        表示中のブラウザでウォール（CAPTCHA / 認証コード / 確認など）をご自身で解決してください。
        このサイトをスキップしても、一括収集は次のチェック済みサイトへ進みます。
      </p>
      <HandoffCredentialPanel credential={handoff.credential} />
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onResume}
          className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white"
        >
          解決して再開
        </button>
        <button type="button" onClick={onSkip} className="text-sm underline">
          このサイトをスキップ
        </button>
        <button type="button" onClick={onCancelBatch} className="text-sm text-red-700 underline">
          一括収集を中止
        </button>
        <button type="button" onClick={onShowGuide} className="text-sm underline">
          別の方法でこのサイトの情報を取り込む
        </button>
      </div>
    </Modal>
  );
}

function HandoffCredentialPanel({
  credential,
}: {
  credential: VisibilityHandoffCredentialView | undefined;
}): React.JSX.Element {
  if (!credential) {
    // `credential` is omitted both when no credential is stored for this site and when one
    // exists but isn't relevant to the current wall (e.g. a post-login CAPTCHA) — the runner
    // does not tell us which. Avoid asserting "not saved" here since that can be false.
    return (
      <p className="rounded border border-neutral-200 bg-neutral-50 p-3 text-sm text-neutral-600">
        このステップで表示できるログイン情報はありません。
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2 rounded border border-neutral-200 bg-neutral-50 p-3">
      <p className="text-sm font-medium text-neutral-900">ログイン補助</p>
      <CopyableCredential label="ログイン ID（メールアドレス）" value={credential.username} />
      <CopyableCredential label="パスワード" value={credential.password} concealed />
    </div>
  );
}

function CopyableCredential({
  label,
  value,
  concealed = false,
}: {
  label: string;
  value: string;
  concealed?: boolean;
}): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const copiedValueRef = useRef<string | undefined>(undefined);
  const clearTimerRef = useRef<number | undefined>(undefined);
  const copiedLabelTimerRef = useRef<number | undefined>(undefined);
  const displayValue = concealed && !revealed ? "••••••••••••" : value;

  const clearCopiedValue = useCallback(async (expectedValue: string) => {
    let shouldClear = false;
    try {
      if (typeof navigator.clipboard.readText !== "function") return;
      const current = await navigator.clipboard.readText();
      shouldClear = current === expectedValue;
    } catch {
      shouldClear = false;
    }
    if (!shouldClear) return;
    try {
      await navigator.clipboard.writeText("");
    } catch {
      // Clipboard permissions differ by platform; failing closed here must not block the hand-off.
    }
  }, []);

  useEffect(() => {
    return () => {
      if (clearTimerRef.current !== undefined) window.clearTimeout(clearTimerRef.current);
      if (copiedLabelTimerRef.current !== undefined) window.clearTimeout(copiedLabelTimerRef.current);
      const copiedValue = copiedValueRef.current;
      if (copiedValue !== undefined) void clearCopiedValue(copiedValue);
    };
  }, [clearCopiedValue]);

  const copy = useCallback(async () => {
    try {
      if (clearTimerRef.current !== undefined) window.clearTimeout(clearTimerRef.current);
      if (copiedLabelTimerRef.current !== undefined) window.clearTimeout(copiedLabelTimerRef.current);
      await navigator.clipboard.writeText(value);
      copiedValueRef.current = value;
      setCopied(true);
      copiedLabelTimerRef.current = window.setTimeout(() => {
        copiedLabelTimerRef.current = undefined;
        setCopied(false);
      }, 2000);
      clearTimerRef.current = window.setTimeout(() => {
        clearTimerRef.current = undefined;
        void clearCopiedValue(value).finally(() => {
          if (copiedValueRef.current === value) copiedValueRef.current = undefined;
        });
      }, CREDENTIAL_CLIPBOARD_CLEAR_MS);
    } catch {
      setCopied(false);
    }
  }, [clearCopiedValue, value]);
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-neutral-600">{label}</span>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <code className="min-w-0 flex-1 select-all break-all rounded bg-white px-2 py-1 font-mono text-sm">
          {displayValue}
        </code>
        {concealed && (
          <button
            type="button"
            onClick={() => setRevealed((current) => !current)}
            className="rounded border border-neutral-300 px-3 py-1.5 text-sm"
          >
            {revealed ? "隠す" : "表示"}
          </button>
        )}
        <button
          type="button"
          onClick={() => void copy()}
          className="rounded border border-neutral-300 px-3 py-1.5 text-sm"
        >
          {copied ? "コピーしました" : "コピー"}
        </button>
      </div>
    </div>
  );
}

function SiteRow({
  site,
  checked,
  disabled,
  savedPageOpen,
  guideOpen,
  detailOpen,
  detail,
  running,
  onCheckedChange,
  onToggleSavedPage,
  onOpenSite,
  onMarkManual,
  onSavedPageImported,
  onOpenDetail,
  onCloseDetail,
  onReloadDetail,
  onRequestDelete,
}: {
  site: SiteLedgerSummary;
  checked: boolean;
  disabled: boolean;
  savedPageOpen: boolean;
  guideOpen: boolean;
  detailOpen: boolean;
  detail: SiteLedgerDetail | undefined;
  running: boolean;
  onCheckedChange: (checked: boolean) => void;
  onToggleSavedPage: () => void;
  onOpenSite: () => void;
  onMarkManual: () => void;
  onSavedPageImported: () => void;
  onOpenDetail: () => void;
  onCloseDetail: () => void;
  onReloadDetail: () => void | Promise<void>;
  onRequestDelete: () => void;
}): React.JSX.Element {
  return (
    <li className="flex flex-col gap-2 py-3">
      <div className="flex items-start justify-between gap-3">
        <label className="flex min-w-0 flex-1 items-start gap-3">
          <input
            type="checkbox"
            checked={checked}
            disabled={disabled}
            onChange={(event) => onCheckedChange(event.target.checked)}
            className="mt-1"
          />
          <span className="flex min-w-0 flex-col gap-1">
            <span className="font-medium">{site.displayName}</span>
            <span className="break-all text-xs text-neutral-400">{site.url ?? site.domain}</span>
            <span className="flex flex-wrap items-center gap-2 text-xs text-neutral-500">
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
          </span>
        </label>
        <span className="flex shrink-0 flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={onOpenDetail}
            className="rounded border border-neutral-300 px-3 py-1.5 text-sm"
          >
            詳細
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={onToggleSavedPage}
            className="rounded border border-neutral-300 px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50"
          >
            保存ページを取り込む
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={onRequestDelete}
            title={`${site.displayName} の情報を削除`}
            aria-label={`${site.displayName} の情報を削除`}
            className="rounded border border-red-300 px-3 py-1.5 text-sm text-red-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            削除
          </button>
        </span>
      </div>

      {savedPageOpen && (
        <div className="flex flex-col gap-2 pl-7">
          {guideOpen && (
            <SavedPageImportGuide
              site={site}
              disabled={disabled}
              onOpenSite={onOpenSite}
              onSkip={onMarkManual}
            />
          )}
          <SavedPageImportPanel
            siteAccountId={site.siteAccountId}
            disabled={disabled}
            onImported={onSavedPageImported}
          />
        </div>
      )}

      {detailOpen && detail && (
        <div className="pl-7">
          <SiteDetail detail={detail} onClose={onCloseDetail} onReload={onReloadDetail} />
        </div>
      )}
    </li>
  );
}

function DeleteSiteModal({
  site,
  acknowledged,
  deleting,
  onAcknowledgedChange,
  onCancel,
  onConfirm,
}: {
  site: SiteLedgerSummary;
  acknowledged: boolean;
  deleting: boolean;
  onAcknowledgedChange: (checked: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
}): React.JSX.Element {
  return (
    <Modal title="サイト情報の削除" onClose={onCancel}>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-neutral-800">
          「{site.displayName}」の情報を Soroeru
          から削除します。ログイン情報・開示・関係・根拠・要確認を含めて削除され、 取り消せません。
        </p>
        <p className="text-sm text-red-700">
          これはサイトからの退会ではなく、Soroeru 内部に保存したこのサイト記録の削除です。
        </p>
        <label className="flex items-start gap-2 text-sm text-neutral-700">
          <input
            type="checkbox"
            checked={acknowledged}
            disabled={deleting}
            onChange={(event) => onAcknowledgedChange(event.target.checked)}
            className="mt-1"
          />
          <span>取り消せない削除であることを確認しました。</span>
        </label>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            disabled={deleting}
            onClick={onCancel}
            className="rounded border border-neutral-300 px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50"
          >
            キャンセル
          </button>
          <button
            type="button"
            disabled={!acknowledged || deleting}
            onClick={onConfirm}
            className="rounded bg-red-700 px-3 py-1.5 text-sm text-white disabled:cursor-not-allowed disabled:bg-neutral-300"
          >
            {deleting ? "削除中…" : "削除する"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function SavedPageImportGuide({
  site,
  disabled,
  onOpenSite,
  onSkip,
}: {
  site: SiteLedgerSummary;
  disabled: boolean;
  onOpenSite: () => void;
  onSkip: () => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3 rounded border border-neutral-200 bg-white p-3">
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">いつものブラウザで保存して取り込む</p>
        <p className="text-xs text-neutral-600">
          Chrome で登録情報のページを開き、HTML のみで保存します。実在サイトのスクリーンショットは使わず、
          この案内はローカルのダミー画面を想定しています。
        </p>
      </div>
      <ol className="grid gap-2 text-xs text-neutral-700 md:grid-cols-4">
        <li className="rounded border border-neutral-200 p-2">
          <span className="font-medium">1. サイトを開く</span>
          <p className="mt-1">既定ブラウザで {site.displayName} を開きます。</p>
        </li>
        <li className="rounded border border-neutral-200 p-2">
          <span className="font-medium">2. 登録情報を表示</span>
          <p className="mt-1">住所、会員情報、アカウント設定などのページを表示します。</p>
        </li>
        <li className="rounded border border-neutral-200 p-2">
          <span className="font-medium">3. HTML のみで保存</span>
          <p className="mt-1">右クリックから別名で保存を選び、形式は「ウェブページ、HTML のみ」にします。</p>
        </li>
        <li className="rounded border border-neutral-200 p-2">
          <span className="font-medium">4. ファイルを取り込む</span>
          <p className="mt-1">下の領域に保存した .html ファイルをドラッグします。</p>
        </li>
      </ol>
      <div className="grid gap-2 md:grid-cols-2">
        <figure className="overflow-hidden rounded border border-neutral-200 bg-neutral-50">
          <img src={guideWallImage} alt="ローカルダミーサイトのセキュリティ確認画面" className="w-full" />
          <figcaption className="px-2 py-1 text-xs text-neutral-500">
            ローカルダミーサイト: セキュリティ確認
          </figcaption>
        </figure>
        <figure className="overflow-hidden rounded border border-neutral-200 bg-neutral-50">
          <img src={guideAccountImage} alt="ローカルダミーサイトの登録情報ページ" className="w-full" />
          <figcaption className="px-2 py-1 text-xs text-neutral-500">
            ローカルダミーサイト: 登録情報ページ
          </figcaption>
        </figure>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={disabled}
          onClick={onOpenSite}
          className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:cursor-not-allowed disabled:bg-neutral-300"
        >
          このサイトを開く
        </button>
        <button type="button" onClick={onSkip} className="text-sm underline">
          今はスキップ（手動確認に印）
        </button>
      </div>
    </div>
  );
}
