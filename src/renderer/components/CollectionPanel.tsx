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

interface CollectionPanelProps {
  /** Bumped by the parent after a CSV import so the site list refetches. */
  reloadToken: number;
  /** Bump the shared reload token so the ledger / insights refresh after a run. */
  onCollected: () => void;
}

interface HandoffState {
  siteAccountId: string;
  instruction: string;
}

export function CollectionPanel({ reloadToken, onCollected }: CollectionPanelProps): React.JSX.Element {
  const [sites, setSites] = useState<SiteLedgerSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | undefined>();
  const [runningSiteId, setRunningSiteId] = useState<string | undefined>();
  const [savedPageSiteId, setSavedPageSiteId] = useState<string | undefined>();
  const [handoff, setHandoff] = useState<HandoffState | undefined>();
  const [lastResult, setLastResult] = useState<VisibilityRunResultView | undefined>();
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
          break;
        case "handoff":
          setHandoff({ siteAccountId: event.siteAccountId, instruction: event.instruction });
          break;
        case "resumed":
          setHandoff(undefined);
          break;
        case "run-finished":
          setRunningSiteId(undefined);
          setHandoff(undefined);
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
    try {
      const result = await window.soroeru.visibility.run(siteAccountId);
      setLastResult(result);
    } catch {
      setLoadError(reasonMessage(undefined));
    }
  }, []);

  const resume = useCallback(() => void window.soroeru.visibility.resume(), []);
  const abort = useCallback(() => void window.soroeru.visibility.abort(), []);

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
          <p className="text-sm font-medium text-amber-900">ウォールの解決が必要です</p>
          <p className="text-xs text-amber-800">{handoff.instruction}</p>
          <p className="text-xs text-amber-800">
            表示中のブラウザでウォール（CAPTCHA / 認証コード /
            確認など）をご自身で解決し、「解決して再開」を押してください。 Soroeru はこれらを突破しません。
          </p>
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
                        onClick={() =>
                          setSavedPageSiteId((current) =>
                            current === site.siteAccountId ? undefined : site.siteAccountId,
                          )
                        }
                        className="rounded border border-neutral-300 px-3 py-1.5 text-sm"
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
                  <SavedPageImportPanel
                    siteAccountId={site.siteAccountId}
                    onImported={() => {
                      void loadSites();
                      onCollected();
                    }}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
