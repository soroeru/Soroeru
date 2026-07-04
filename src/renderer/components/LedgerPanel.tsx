// Disclosure ledger (issue #160, RFC-002 §4.2 / §5.1). Shows the composed
// per-site view: what each Site Account holds, with stale flags and Account
// Relationship chips. Values are masked by default; a single value is revealed
// only through an explicit re-authenticated flow (master passphrase re-checked
// in the trusted layer). A revealed value is held in component state only after
// that explicit reveal, stays until the user hides it or the row unmounts, and
// is never persisted.

import { useCallback, useEffect, useState } from "react";
import { Label } from "@radix-ui/react-label";
import type {
  DisclosureView,
  PendingAttributeCandidateView,
  SessionPersistenceView,
  SiteLedgerDetail,
  SiteLedgerSummary,
} from "../../../electron/ipc/contract.js";
import { reasonMessage, relationshipLabel, staleLabel } from "../messages.js";

interface LedgerPanelProps {
  /** Bumped by the parent after a CSV import so the ledger refetches. */
  reloadToken: number;
}

export function LedgerPanel({ reloadToken }: LedgerPanelProps): React.JSX.Element {
  const [sites, setSites] = useState<SiteLedgerSummary[]>([]);
  const [detail, setDetail] = useState<SiteLedgerDetail | undefined>();
  const [detailError, setDetailError] = useState<string | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);

  const loadSites = useCallback(async () => {
    // Mirror the sibling components' discipline: a rejected invoke must not leave
    // the panel wedged on the loading text with an unhandled rejection.
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

  const openSite = useCallback(async (siteAccountId: string) => {
    const result = await window.soroeru.ledger.site(siteAccountId);
    if (!result) {
      // The site was removed or the vault locked mid-session: surface it rather
      // than rendering an empty detail and leaving the click feeling dead.
      setDetail(undefined);
      setDetailError("詳細を取得できませんでした。");
      return;
    }
    setDetailError(undefined);
    setDetail(result);
  }, []);

  if (loading) return <p className="text-sm text-neutral-500">読み込み中…</p>;

  if (loadError) {
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
          まだサイトがありません。CSV を取り込むと、ここに開示台帳が表示されます。
        </p>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-lg font-medium">開示台帳（{sites.length} サイト）</h2>
      <ul className="flex flex-col divide-y divide-neutral-200">
        {sites.map((site) => (
          <li key={site.siteAccountId}>
            <button
              type="button"
              onClick={() => void openSite(site.siteAccountId)}
              className="flex w-full flex-col gap-1 py-2 text-left hover:bg-neutral-50"
            >
              <span className="flex items-center justify-between">
                <span className="font-medium">{site.displayName}</span>
                <span className="text-xs text-neutral-400">{site.domain}</span>
              </span>
              <span className="flex flex-wrap items-center gap-2 text-xs text-neutral-500">
                <span>開示 {site.disclosureCount}</span>
                {site.stale.stale > 0 && (
                  <span className="rounded bg-red-100 px-1.5 py-0.5 text-red-700">
                    古い {site.stale.stale}
                  </span>
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
                {!site.collected && <span className="text-neutral-400">未収集</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {detailError && <p className="text-sm text-red-600">{detailError}</p>}
      {detail && (
        <SiteDetail detail={detail} onClose={() => setDetail(undefined)} onReload={() => openSite(detail.siteAccountId)} />
      )}
    </section>
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
  return (
    <div className="flex flex-col gap-3 rounded border border-neutral-200 p-4">
      <div className="flex items-center justify-between">
        <h3 className="font-medium">{detail.displayName}</h3>
        <button type="button" onClick={onClose} className="text-sm underline">
          閉じる
        </button>
      </div>

      {detail.disclosures.length === 0 ? (
        <p className="text-sm text-neutral-500">このサイトの開示はまだ収集されていません。</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {detail.disclosures.map((disclosure) => (
            <DisclosureRow key={disclosure.disclosureId} disclosure={disclosure} />
          ))}
        </ul>
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

      <SessionPersistenceControl
        siteAccountId={detail.siteAccountId}
        sessionPersistence={detail.sessionPersistence}
        onReload={onReload}
      />
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
      // Stay busy (checkbox disabled) until the reload delivers fresh props —
      // clearing busy first would let a fast second click read the stale
      // `sessionPersistence.enabled` closure and double-toggle.
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
    // The reload is best-effort: the confirm already persisted, so a failure
    // here (e.g. the vault locked mid-request) must not be reported as if the
    // confirm itself had failed.
    if (confirmedOk) await onConfirmed();
  }, [candidate.matchTerms, candidate.proposedAttributeKey, label, onConfirmed]);

  return (
    <li className="flex flex-col gap-1 text-sm">
      <form
        className="flex items-center gap-2"
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

function DisclosureRow({ disclosure }: { disclosure: DisclosureView }): React.JSX.Element {
  const [revealing, setRevealing] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [value, setValue] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const reveal = useCallback(async () => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await window.soroeru.ledger.reveal(disclosure.disclosureId, passphrase);
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
  }, [disclosure.disclosureId, passphrase]);

  const hide = useCallback(() => {
    setValue(undefined);
    setError(undefined);
  }, []);

  return (
    <li className="flex flex-col gap-1 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2">
          <span>{disclosure.label}</span>
          <StaleBadge state={disclosure.staleState} />
          <SourceBadge sourceKind={disclosure.sourceKind} />
        </span>
        <span className="flex items-center gap-2">
          <span className="font-mono text-neutral-500">{value ?? (disclosure.preview || "—")}</span>
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
          className="flex items-center gap-2"
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
            className="rounded border border-neutral-300 px-2 py-1 text-xs"
          />
          <button
            type="submit"
            disabled={busy || passphrase.length === 0}
            className="rounded bg-neutral-900 px-2 py-1 text-xs text-white disabled:opacity-50"
          >
            確認して表示
          </button>
          <button
            type="button"
            onClick={() => {
              setRevealing(false);
              setPassphrase("");
              setError(undefined);
            }}
            className="text-xs underline"
          >
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
  return (
    <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-600">
      保存ページ
    </span>
  );
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
