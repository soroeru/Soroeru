// Disclosure ledger (issue #160, RFC-002 §4.2 / §5.1; spreadsheet-style table
// layout added for Issue #301). Shows the composed per-site view: what each
// Site Account holds, with stale flags and Account Relationship chips. Values
// are masked by default; a single value is revealed only through an explicit
// re-authenticated flow (master passphrase re-checked in the trusted layer). A
// revealed value is held in component state only after that explicit reveal,
// stays until the user hides it or the row/cell unmounts, and is never
// persisted.

import { useCallback, useEffect, useState } from "react";
import { Label } from "@radix-ui/react-label";
import type {
  DisclosureView,
  PendingAttributeCandidateView,
  SessionPersistenceView,
  SiteLedgerDetail,
} from "../../../electron/ipc/contract.js";
import { buildLedgerColumns, disclosureFor } from "../ledger-table.js";
import { reasonMessage, relationshipLabel, staleLabel } from "../messages.js";

interface LedgerPanelProps {
  /** Bumped by the parent after a CSV import or collection so the ledger refetches. */
  reloadToken: number;
}

/**
 * Spreadsheet-style Disclosure ledger (Issue #301): rows are sites, columns are
 * the union of every attribute observed across all sites, and the container
 * scrolls horizontally so every collected value is visible without opening a
 * per-site detail panel first. `SiteManagementPanel`'s per-row "詳細" flow
 * (relationships, constraints, pending candidates, session persistence) stays
 * the place for those actions; this view is read-only.
 */
export function LedgerPanel({ reloadToken }: LedgerPanelProps): React.JSX.Element {
  const [sites, setSites] = useState<SiteLedgerDetail[]>([]);
  const [loadError, setLoadError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);

  const loadSites = useCallback(async () => {
    // Mirror the sibling components' discipline: a rejected invoke must not leave
    // the panel wedged on the loading text with an unhandled rejection.
    try {
      setSites(await window.soroeru.ledger.siteDetails());
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

  const columns = buildLedgerColumns(sites);

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-medium">開示台帳（{sites.length} サイト）</h2>
        <p className="text-sm text-neutral-500">
          サイトを行、項目を列にした表形式です。横にスクロールするとすべての項目を確認できます。
        </p>
      </div>

      {columns.length === 0 ? (
        <p className="text-sm text-neutral-500">
          収集済みの開示がまだありません。サイト管理からサイトを収集すると、ここに表示されます。
        </p>
      ) : (
        <div className="max-h-[60vh] overflow-auto rounded border border-neutral-200">
          <table className="border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-neutral-200 bg-neutral-50">
                <th scope="col" className="sticky left-0 top-0 z-20 bg-neutral-50 px-3 py-2 font-medium">
                  サイト
                </th>
                {columns.map((column) => (
                  <th
                    key={column.attributeKey}
                    scope="col"
                    className="sticky top-0 z-10 whitespace-nowrap bg-neutral-50 px-3 py-2 font-medium"
                  >
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sites.map((site) => (
                <tr key={site.siteAccountId} className="border-b border-neutral-100 last:border-b-0">
                  <th
                    scope="row"
                    className="sticky left-0 z-10 whitespace-nowrap bg-white px-3 py-2 text-left align-top font-medium"
                  >
                    <span className="flex flex-col">
                      <span>{site.displayName}</span>
                      <span className="text-xs font-normal text-neutral-400">{site.domain}</span>
                    </span>
                  </th>
                  {site.collected ? (
                    columns.map((column) => (
                      <LedgerCell key={column.attributeKey} disclosure={disclosureFor(site, column.attributeKey)} />
                    ))
                  ) : (
                    <td colSpan={columns.length} className="px-3 py-2 text-neutral-400">
                      未収集
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** One spreadsheet cell: a site's value for one attribute column, if collected. */
function LedgerCell({ disclosure }: { disclosure: DisclosureView | undefined }): React.JSX.Element {
  const reveal = useDisclosureReveal(disclosure?.disclosureId ?? "");

  if (!disclosure) {
    return <td className="whitespace-nowrap px-3 py-2 align-top text-neutral-400">—</td>;
  }

  return (
    <td className="whitespace-nowrap px-3 py-2 align-top">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
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
  return (
    <div className="flex flex-col gap-3 rounded border border-neutral-200 p-3 sm:p-4">
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
