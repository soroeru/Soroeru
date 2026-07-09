// CSV import & queue review (issue #160, RFC-002 §5.1). The user picks their
// Google / Chrome Password Manager export; the file is read locally and sent as
// bytes over IPC. Only a counts-only summary returns — never a raw credential.
// After import the user reviews the imported sites; the actual auto-login +
// collection run is launched from the Site Management panel.

import { useCallback, useRef, useState } from "react";
import type { CsvImportResult } from "../../../electron/ipc/contract.js";
import { reasonMessage } from "../messages.js";

type ImportSummary = NonNullable<CsvImportResult["summary"]>;
const nonCsvMessage = "CSV ファイル（.csv / text/csv）を選択してください。";

interface CsvImportPanelProps {
  onImported: () => Promise<void> | void;
}

function isCsvFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return name.endsWith(".csv") || file.type === "text/csv";
}

export function CsvImportPanel({ onImported }: CsvImportPanelProps): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [summary, setSummary] = useState<ImportSummary | undefined>();

  const onFile = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      if (!isCsvFile(file)) {
        setError(nonCsvMessage);
        return;
      }
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
        await onImported();
      } catch {
        setError(reasonMessage(undefined));
      } finally {
        setBusy(false);
      }
    },
    [onImported],
  );

  const openFilePicker = useCallback(() => {
    if (busy) return;
    inputRef.current?.click();
  }, [busy]);

  const onDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setDragging(false);
      if (busy) return;
      void onFile(event.dataTransfer.files[0]);
    },
    [busy, onFile],
  );

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-medium">CSV を取り込む</h2>
        <p className="text-sm text-neutral-500">
          Google / Chrome
          パスワードマネージャーのエクスポート（name,url,username,password,note）をローカルで取り込みます。
        </p>
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-2 rounded border border-neutral-200 p-3">
          <p className="text-sm font-medium">ボタンで選択</p>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={busy}
              onClick={openFilePicker}
              className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:cursor-not-allowed disabled:bg-neutral-300"
            >
              ファイルを選択
            </button>
            <p className="text-xs text-neutral-500">Finder から CSV を選択します。</p>
          </div>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept=".csv,text/csv"
          disabled={busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            void onFile(file);
            // Allow re-selecting the same file (onChange won't fire otherwise).
            event.target.value = "";
          }}
          className="hidden"
        />

        <div
          onDragEnter={(event) => {
            event.preventDefault();
            if (!busy) setDragging(true);
          }}
          onDragOver={(event) => {
            event.preventDefault();
            if (!busy) setDragging(true);
          }}
          onDragLeave={(event) => {
            event.preventDefault();
            setDragging(false);
          }}
          onDrop={onDrop}
          aria-disabled={busy}
          className={`flex min-h-28 flex-col items-center justify-center gap-1 rounded border border-dashed p-4 text-center ${
            busy
              ? "border-neutral-200 bg-neutral-50 text-neutral-400"
              : dragging
                ? "border-neutral-900 bg-neutral-100 text-neutral-900"
                : "border-neutral-300 text-neutral-600"
          }`}
        >
          <p className="text-sm font-medium">ドラッグ＆ドロップ</p>
          <p className="text-xs">ここに CSV ファイルをドロップして取り込みます。</p>
        </div>
      </div>

      {busy && <p className="text-sm text-neutral-500">取り込み中…</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}

      {summary && (
        <div className="flex flex-col gap-3">
          <dl className="grid grid-cols-1 gap-1 text-sm sm:grid-cols-2">
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
            <p className="text-sm font-medium">取り込まれたサイト（{summary.siteAccountIds.length}）</p>
            <p className="text-xs text-neutral-400">
              取り込みは完了しています。下のサイト管理で対象にチェックを入れて収集できます。
            </p>
            <ul className="flex max-h-48 flex-col gap-1 overflow-auto text-sm">
              {summary.siteAccountIds.map((id) => (
                <li key={id} className="font-mono text-xs text-neutral-500">
                  {id}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}
