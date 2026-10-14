// Side Panel Visibility UI (Issue #558): a minimal ledger (sites, run button, counts) and the
// wall hand-off card (instruction + Resume / Abort). It shows only the sanitized events and
// counts from VisibilityService; collected values and hand-off credentials are never rendered.

import { CanonicalPanel } from "./CanonicalPanel.js";
import { CollectionScopePanel } from "./CollectionScopePanel.js";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SiteAccount } from "../../src/domain/entities.js";
import type { VisibilityRunResultView } from "../../electron/ipc/contract.js";
import type { VisibilityHost } from "./visibility-host.js";
import { ConsentGate } from "./ConsentGate.js";
import type { ConsentGateProps } from "./ConsentGate.js";
import { CloudSettingsPanel } from "./CloudSettingsPanel.js";

export function HandoffCard(props: {
  instruction: string;
  onResume: () => void;
  onAbort: () => void;
}): React.JSX.Element {
  return (
    <section role="alert" className="flex flex-col gap-2 rounded border border-amber-400 bg-amber-50 p-3">
      <p className="font-semibold">確認が必要です</p>
      <p>{props.instruction}</p>
      <p className="text-xs">
        このタブで操作を終えたら「再開」を押してください。Soroeru は代わりに突破しません。
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={props.onResume}
          className="rounded bg-neutral-900 px-3 py-1 text-white"
        >
          再開
        </button>
        <button type="button" onClick={props.onAbort} className="rounded border border-neutral-300 px-3 py-1">
          中止
        </button>
      </div>
    </section>
  );
}

export function LedgerView(props: {
  sites: SiteAccount[];
  results: Record<string, VisibilityRunResultView>;
  busy: boolean;
  onRun: (site: SiteAccount) => void;
}): React.JSX.Element {
  if (props.sites.length === 0) return <p>台帳にサイトがありません。</p>;
  return (
    <ul className="flex flex-col gap-2">
      {props.sites.map((site) => {
        const result = props.results[site.id];
        return (
          <li
            key={site.id}
            className="flex items-center justify-between gap-2 border-b border-neutral-200 pb-2"
          >
            <div className="min-w-0">
              <p className="truncate font-medium">{site.displayName}</p>
              <p className="truncate text-xs text-neutral-600">{site.domain}</p>
              {result && (
                <p className="text-xs">
                  {result.status}: 開示 {result.disclosures} / 関係 {result.relationships} / 制約{" "}
                  {result.constraints}
                </p>
              )}
            </div>
            <button
              type="button"
              disabled={props.busy}
              onClick={() => props.onRun(site)}
              className="shrink-0 rounded border border-neutral-300 px-3 py-1 disabled:opacity-50"
            >
              収集
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function VisibilityPanel({ host }: { host: VisibilityHost }): React.JSX.Element {
  const [sites, setSites] = useState<SiteAccount[]>(() => host.listSites());
  const [results, setResults] = useState<Record<string, VisibilityRunResultView>>({});
  const [instruction, setInstruction] = useState<string | undefined>();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | undefined>();
  // Tier 3 consent gate state. When set, the panel renders the gate instead of the ledger.
  const [consentGate, setConsentGate] = useState<
    Omit<ConsentGateProps, "onApprove" | "onDecline" | "onTimeout"> | undefined
  >();
  const consentResolve = useRef<((decision: "approved" | "declined" | "timeout") => void) | undefined>(
    undefined,
  );

  useEffect(
    () =>
      host.onEvent((event) => {
        if (event.type === "run-started") setRunning(true);
        else if (event.type === "handoff") setInstruction(event.instruction);
        else if (event.type === "resumed") setInstruction(undefined);
        else {
          setRunning(false);
          setInstruction(undefined);
          setConsentGate(undefined);
          setResults((prev) => ({ ...prev, [event.result.siteAccountId]: event.result }));
        }
      }),
    [host],
  );

  // Wire up the consent gate callback into the VisibilityHost.
  useEffect(() => {
    host.setConsentGateProvider((params) => {
      return new Promise<"approved" | "declined" | "timeout">((resolve) => {
        consentResolve.current = (decision: "approved" | "declined" | "timeout") => {
          setConsentGate(undefined);
          resolve(decision);
        };
        setConsentGate({ origin: params.origin, attributeKeys: params.attributeKeys });
      });
    });
    return () => host.setConsentGateProvider(undefined);
  }, [host]);

  const run = useCallback(
    (site: SiteAccount) => {
      setError(undefined);
      setSites(host.listSites());
      // The permission prompt needs this click's user gesture, so it is requested first.
      void host
        .requestSitePermission(site)
        .then((granted) => {
          if (!granted) {
            setError("このサイトへのアクセス許可が必要です。");
            return undefined;
          }
          return host.run(site).then((result) => {
            setResults((prev) => ({ ...prev, [site.id]: result }));
          });
        })
        .catch(() => setError("収集を開始できませんでした。対象サイトのタブを開いて再試行してください。"))
        .finally(() => {
          setRunning(false);
          setInstruction(undefined);
          setConsentGate(undefined);
        });
    },
    [host],
  );

  return (
    <div className="flex flex-col gap-3">
      {error && (
        <p role="alert" className="text-red-600">
          {error}
        </p>
      )}
      {consentGate && (
        <ConsentGate
          origin={consentGate.origin}
          attributeKeys={consentGate.attributeKeys}
          onApprove={() => consentResolve.current?.("approved")}
          onDecline={() => consentResolve.current?.("declined")}
          onTimeout={() => consentResolve.current?.("timeout")}
        />
      )}
      {instruction !== undefined && (
        <HandoffCard instruction={instruction} onResume={() => host.resume()} onAbort={() => host.abort()} />
      )}
      <CanonicalPanel host={host} busy={running} />
      <CollectionScopePanel host={host} busy={running} />
      <p className="text-xs">「収集」で対象サイトの情報を読み取ります。通常の移動とローカルのログイン入力を含みます。認証・アクセス制限は手動で確認し、変更・支払い・退会は実行しません。</p>
      {running && <button type="button" onClick={() => host.abort()}>収集を停止</button>}
      <CloudSettingsPanel host={host} busy={running || Boolean(consentGate)} />
      {!consentGate && <LedgerView sites={sites} results={results} busy={running} onRun={run} />}
    </div>
  );
}
