// CSV import & queue review (issue #160, RFC-002 §5.1). The user picks their
// Google / Chrome Password Manager export; the file is read locally and sent as
// bytes over IPC. Only a counts-only summary returns — never a raw credential.
// After import the user reviews the imported sites; the actual auto-login +
// collection run is launched from the「収集」tab (CollectionPanel).

import { useCallback, useState } from "react";
import type { CsvImportResult } from "../../../electron/ipc/contract.js";
import { reasonMessage } from "../messages.js";

type ImportSummary = NonNullable<CsvImportResult["summary"]>;

interface CsvImportPanelProps {
  onImported: () => Promise<void> | void;
}

export function CsvImportPanel({ onImported }: CsvImportPanelProps): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [summary, setSummary] = useState<ImportSummary | undefined>();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  const onFile = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      setBusy(true);
      setError(undefined);
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const result = await window.soroeru.csv.import(bytes);
        if (!result.ok || !result.summary) {
          setError(reasonMessage(result.error));
          return;
        }
        setSummary(result.summary);
        setSelected(new Set(result.summary.siteAccountIds));
        await onImported();
      } catch {
        setError(reasonMessage(undefined));
      } finally {
        setBusy(false);
      }
    },
    [onImported],
  );

  const toggle = useCallback((siteAccountId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(siteAccountId)) next.delete(siteAccountId);
      else next.add(siteAccountId);
      return next;
    });
  }, []);

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-medium">CSV を取り込む</h2>
        <p className="text-sm text-neutral-500">
          Google / Chrome
          パスワードマネージャーのエクスポート（name,url,username,password,note）をローカルで取り込みます。
        </p>
      </div>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">CSV ファイル</span>
        <input
          type="file"
          accept=".csv,text/csv"
          disabled={busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            void onFile(file);
            // Allow re-selecting the same file (onChange won't fire otherwise).
            event.target.value = "";
          }}
          className="text-sm"
        />
      </label>

      {busy && <p className="text-sm text-neutral-500">取り込み中…</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}

      {summary && (
        <div className="flex flex-col gap-3">
          <dl className="grid grid-cols-2 gap-1 text-sm">
            <dt className="text-neutral-500">データ行数</dt>
            <dd>{summary.totalDataRows}</dd>
            <dt className="text-neutral-500">取り込んだ認証情報</dt>
            <dd>{summary.importedCredentials}</dd>
            <dt className="text-neutral-500">新規サイト</dt>
            <dd>{summary.sitesCreated}</dd>
            <dt className="text-neutral-500">既存に一致</dt>
            <dd>{summary.sitesMatched}</dd>
            <dt className="text-neutral-500">スキップ</dt>
            <dd>{summary.skipped}</dd>
          </dl>

          {summary.recommendSourceDeletion && (
            <p className="rounded bg-amber-50 px-3 py-2 text-xs text-amber-800">
              取り込みは完了しました。元の CSV ファイルはご自身で削除してください（自動削除はしません）。
            </p>
          )}

          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">
              Visibility 収集の対象（{selected.size}/{summary.siteAccountIds.length}）
            </p>
            <p className="text-xs text-neutral-400">
              取り込みは完了しています。実際の自動ログイン・収集は「収集」タブから実行できます。
            </p>
            <ul className="flex max-h-48 flex-col gap-1 overflow-auto text-sm">
              {summary.siteAccountIds.map((id) => (
                <li key={id}>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={selected.has(id)} onChange={() => toggle(id)} />
                    <span className="font-mono text-xs text-neutral-500">{id}</span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}
