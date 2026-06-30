// Visibility collection (issues #159 / #160, RFC-002 §5.1 / §5.2). This is the
// place the user actually launches auto-login + collection for imported sites:
// pick a site, run it in a headed browser, and — when the run pauses at a
// CAPTCHA / MFA / verification wall — resolve the wall yourself in that same
// visible browser, then resume. Soroeru never solves or bypasses a wall.
//
// The renderer only triggers and observes through the typed IPC bridge; the run
// itself, the browser, and every raw value stay in the trusted main process.

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  SiteLedgerSummary,
  VisibilityEvent,
  VisibilityRunResultView,
} from "../../../electron/ipc/contract.js";
import { reasonMessage, visibilityStatusLabel } from "../messages.js";
import { SavedPageImportPanel } from "./SavedPageImportPanel.js";

const guideWallImage = new URL("../assets/saved-page-guide-wall.png", import.meta.url).href;
const guideAccountImage = new URL("../assets/saved-page-guide-account.png", import.meta.url).href;

interface CollectionPanelProps {
  /** Bumped by the parent after a CSV import so the site list refetches. */
  reloadToken: number;
  /** Bump the shared reload token so the ledger / insights refresh after a run. */
  onCollected: () => void;
}

interface HandoffState {
  siteAccountId: string;
  instruction: string;
  fallbackSuggested: boolean;
}

export function CollectionPanel({ reloadToken, onCollected }: CollectionPanelProps): React.JSX.Element {
  const [sites, setSites] = useState<SiteLedgerSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | undefined>();
  const [runningSiteId, setRunningSiteId] = useState<string | undefined>();
  const [savedPageSiteId, setSavedPageSiteId] = useState<string | undefined>();
  const [guideSiteId, setGuideSiteId] = useState<string | undefined>();
  const [handoff, setHandoff] = useState<HandoffState | undefined>();
  const [lastResult, setLastResult] = useState<VisibilityRunResultView | undefined>();
  const resumedHandoffSites = useRef<Set<string>>(new Set());
  const onCollectedRef = useRef(onCollected);
  useEffect(() => {
    onCollectedRef.current = onCollected;
  }, [onCollected]);

  const loadSites = useCallback(async () => {
    try {
      setSites(await window.soroeru.ledger.sites());
      setLoadError(undefined);
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

  // Subscribe to run progress / wall hand-off events for the lifetime of the panel.
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
          setHandoff({
            siteAccountId: event.siteAccountId,
            instruction: event.instruction,
            fallbackSuggested: resumedHandoffSites.current.has(event.siteAccountId),
          });
          if (resumedHandoffSites.current.has(event.siteAccountId)) setGuideSiteId(event.siteAccountId);
          break;
        case "resumed":
          resumedHandoffSites.current.add(event.siteAccountId);
          setHandoff(undefined);
          break;
        case "run-finished":
          setRunningSiteId(undefined);
          setHandoff(undefined);
          resumedHandoffSites.current.delete(event.result.siteAccountId);
          setLastResult(event.result);
          void loadSites();
          onCollectedRef.current();
          break;
      }
    });
    return unsubscribe;
  }, [loadSites]);

  const run = useCallback(async (siteAccountId: string) => {
    setLastResult(undefined);
    setGuideSiteId(undefined);
    try {
      const result = await window.soroeru.visibility.run(siteAccountId);
      setLastResult(result);
    } catch {
      setLoadError(reasonMessage(undefined));
    }
  }, []);

  const resume = useCallback(() => void window.soroeru.visibility.resume(), []);
  const abort = useCallback(() => void window.soroeru.visibility.abort(), []);
  const showGuide = useCallback(async (siteAccountId: string) => {
    await window.soroeru.visibility.abort();
    setRunningSiteId(undefined);
    setHandoff(undefined);
    setGuideSiteId(siteAccountId);
    setSavedPageSiteId(siteAccountId);
  }, []);
  const markManual = useCallback(
    async (siteAccountId: string) => {
      void window.soroeru.visibility.abort();
      const result = await window.soroeru.savedPage.markManualCheck(siteAccountId);
      if (!result.ok) {
        setLoadError(reasonMessage(result.error));
        return;
      }
      setGuideSiteId(undefined);
      setSavedPageSiteId(undefined);
      await loadSites();
      onCollected();
    },
    [loadSites, onCollected],
  );
  const openSite = useCallback(async (siteAccountId: string) => {
    const result = await window.soroeru.savedPage.openSite(siteAccountId);
    if (!result.ok) setLoadError(reasonMessage(result.error));
  }, []);

  if (loading) return <p className="text-sm text-neutral-500">読み込み中…</p>;

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-medium">Visibility 収集</h2>
        <p className="text-sm text-neutral-500">
          取り込んだサイトに自動ログインし、登録済みの個人情報を収集して開示台帳を構築します。 CAPTCHA / MFA /
          検証ウォールは自動で突破せず、表示中のブラウザでご自身に解決をお願いします。
        </p>
      </div>

      {loadError && <p className="text-sm text-red-600">{loadError}</p>}

      {handoff && (
        <div className="flex flex-col gap-2 rounded border border-amber-300 bg-amber-50 p-4">
          <p className="text-sm font-medium text-amber-900">
            {handoff.fallbackSuggested ? "別の方法で取り込めます" : "ウォールの解決が必要です"}
          </p>
          <p className="text-xs text-amber-800">{handoff.instruction}</p>
          {handoff.fallbackSuggested ? (
            <p className="text-xs text-amber-800">
              このサイトはセキュリティがとても厳重です。Soroeru からの自動ログインを最後まで完了できないことがあります。
              いつものブラウザでログインして登録情報ページを保存すれば、その内容をローカルで読み取れます。
            </p>
          ) : (
            <p className="text-xs text-amber-800">
              表示中のブラウザでウォール（CAPTCHA / 認証コード /
              確認など）をご自身で解決し、「解決して再開」を押してください。 Soroeru はこれらを突破しません。
            </p>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={resume}
              className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white"
            >
              解決して再開
            </button>
            <button type="button" onClick={abort} className="text-sm underline">
              中止
            </button>
            <button type="button" onClick={() => void showGuide(handoff.siteAccountId)} className="text-sm underline">
              別の方法でこのサイトの情報を取り込む
            </button>
          </div>
        </div>
      )}

      {lastResult && !handoff && (
        <p className="text-sm text-neutral-700">{visibilityStatusLabel(lastResult.status)}</p>
      )}

      {sites.length === 0 ? (
        <p className="text-sm text-neutral-500">
          まだサイトがありません。「取り込み」タブで CSV を取り込むと、ここに収集対象が表示されます。
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-neutral-200">
          {sites.map((site) => {
            const isRunning = runningSiteId === site.siteAccountId;
            const showSavedPageImport = true;
            return (
              <li key={site.siteAccountId} className="flex flex-col gap-2 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex flex-col">
                    <span className="font-medium">{site.displayName}</span>
                    <span className="text-xs text-neutral-400">{site.domain}</span>
                  </span>
                  <span className="flex flex-wrap items-center justify-end gap-2">
                    {site.collected ? (
                      <span className="text-xs text-green-700">収集済み（開示 {site.disclosureCount}）</span>
                    ) : (
                      <span className="text-xs text-neutral-400">未収集</span>
                    )}
                    {showSavedPageImport && (
                      <button
                        type="button"
                        disabled={runningSiteId !== undefined}
                        onClick={() =>
                          setSavedPageSiteId((current) =>
                            current === site.siteAccountId ? undefined : site.siteAccountId,
                          )
                        }
                        className="rounded border border-neutral-300 px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        保存ページを取り込む
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void run(site.siteAccountId)}
                      disabled={runningSiteId !== undefined}
                      className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50"
                    >
                      {isRunning ? "収集中…" : site.collected ? "再収集" : "収集"}
                    </button>
                  </span>
                </div>
                {savedPageSiteId === site.siteAccountId && (
                  <div className="flex flex-col gap-2">
                    {guideSiteId === site.siteAccountId && (
                      <SavedPageImportGuide
                        site={site}
                        disabled={runningSiteId !== undefined}
                        onOpenSite={() => void openSite(site.siteAccountId)}
                        onSkip={() => void markManual(site.siteAccountId)}
                      />
                    )}
                    <SavedPageImportPanel
                      siteAccountId={site.siteAccountId}
                      disabled={runningSiteId !== undefined}
                      onImported={() => {
                        setGuideSiteId(undefined);
                        void loadSites();
                        onCollected();
                      }}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
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
          <figcaption className="px-2 py-1 text-xs text-neutral-500">ローカルダミーサイト: セキュリティ確認</figcaption>
        </figure>
        <figure className="overflow-hidden rounded border border-neutral-200 bg-neutral-50">
          <img src={guideAccountImage} alt="ローカルダミーサイトの登録情報ページ" className="w-full" />
          <figcaption className="px-2 py-1 text-xs text-neutral-500">ローカルダミーサイト: 登録情報ページ</figcaption>
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
