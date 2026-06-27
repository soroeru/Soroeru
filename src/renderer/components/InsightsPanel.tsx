// Cross-cutting filters + initial Reflection (issue #161, RFC-002 §5.3 / §5.1).
// Derives nothing in the renderer: it shows the sanitized insights the trusted
// layer computed from the ledger. The Reflection is rendered as separate
// observations and each filter item links to its evidence and a *next safe
// action* — never a single blind bulk-approve (Product Principle: never a
// delegation of will).

import { useCallback, useEffect, useState } from "react";
import type { EvidenceRef, LedgerInsights, ReflectionFinding } from "../../../electron/ipc/contract.js";
import { reasonMessage } from "../messages.js";

interface InsightsPanelProps {
  /** Bumped by the parent after a CSV import so the insights refetch. */
  reloadToken: number;
}

export function InsightsPanel({ reloadToken }: InsightsPanelProps): React.JSX.Element {
  const [insights, setInsights] = useState<LedgerInsights | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setInsights(await window.soroeru.ledger.insights());
      setError(undefined);
    } catch {
      setError(reasonMessage(undefined));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load, reloadToken]);

  if (loading) return <p className="text-sm text-neutral-500">読み込み中…</p>;
  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!insights) return <p className="text-sm text-neutral-500">表示できるインサイトがありません。</p>;

  const totalFilterSites = insights.filters.reduce((sum, filter) => sum + filter.sites.length, 0);

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-medium">気づき（Reflection）</h2>
        {insights.reflection.length === 0 ? (
          <p className="text-sm text-neutral-500">
            まだ所見はありません。CSV を取り込み、収集が進むとここに要約が表示されます。
          </p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {insights.reflection.map((finding) => (
              <ReflectionRow key={finding.kind} finding={finding} />
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">横断フィルタ</h2>
        {totalFilterSites === 0 && (
          <p className="text-sm text-neutral-500">該当するサイトはまだありません。</p>
        )}
        {insights.filters.map((filter) => (
          <div key={filter.key} className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">
              {filter.label}（{filter.sites.length}）
            </h3>
            {filter.sites.length > 0 && (
              <ul className="flex flex-col gap-2">
                {filter.sites.map((site) => (
                  <li
                    key={site.siteAccountId}
                    className="flex flex-col gap-1 rounded border border-neutral-200 p-3 text-sm"
                  >
                    <span className="flex items-center justify-between">
                      <span className="font-medium">{site.displayName}</span>
                      <span className="text-xs text-neutral-400">{site.domain}</span>
                    </span>
                    <span className="text-neutral-600">{site.reason}</span>
                    <span className="text-xs text-blue-700">次の安全なアクション: {site.nextAction}</span>
                    {site.evidence.length > 0 && <EvidenceList evidence={site.evidence} />}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </section>
    </div>
  );
}

function ReflectionRow({ finding }: { finding: ReflectionFinding }): React.JSX.Element {
  return (
    <li className="flex items-start gap-2">
      <span className="mt-0.5 rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-600">
        {finding.count}
      </span>
      <span>{finding.summary}</span>
    </li>
  );
}

function EvidenceList({ evidence }: { evidence: EvidenceRef[] }): React.JSX.Element {
  return (
    <ul className="flex flex-col gap-0.5 text-xs text-neutral-500">
      {evidence.map((ref) => (
        <li key={ref.evidenceId} className="flex flex-wrap items-center gap-1">
          <span className="text-neutral-400">根拠:</span>
          {ref.fieldLabel && <span>{ref.fieldLabel}</span>}
          {ref.maskedSnippet && <span className="font-mono">{ref.maskedSnippet}</span>}
          {ref.pageUrl && <span className="break-all text-neutral-400">{ref.pageUrl}</span>}
        </li>
      ))}
    </ul>
  );
}
