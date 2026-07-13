import { useCallback, useRef, useState } from "react";
import type { SavedPageImportSummaryView } from "../../../electron/ipc/contract.js";
import { reasonMessage } from "../messages.js";

const badFileMessage = "保存した HTML ファイル（.html / .htm）を選択してください。";

interface SavedPageImportPanelProps {
  siteAccountId: string;
  disabled?: boolean;
  onImported: () => Promise<void> | void;
  /** Close the panel (the caller owns the open/closed state). */
  onClose?: () => void;
}

function isSavedPageFile(file: File): boolean {
  return /\.(html?|htm)$/i.test(file.name);
}

export function SavedPageImportPanel({
  siteAccountId,
  disabled = false,
  onImported,
  onClose,
}: SavedPageImportPanelProps): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [summary, setSummary] = useState<SavedPageImportSummaryView | undefined>();

  const onFile = useCallback(
    async (file: File | undefined) => {
      if (!file || disabled) return;
      if (!isSavedPageFile(file)) {
        setError(badFileMessage);
        return;
      }
      setBusy(true);
      setError(undefined);
      try {
        const data = new Uint8Array(await file.arrayBuffer());
        const result = await window.soroeru.savedPage.import({ siteAccountId, fileName: file.name, data });
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
    [disabled, onImported, siteAccountId],
  );

  return (
    <div className="flex max-w-2xl flex-col gap-3 rounded border border-neutral-200 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">保存したページから読み取る</p>
          <p className="text-xs text-neutral-500">
            ご自身のブラウザでログイン後に保存した HTML を、ローカルで解析して開示台帳に記録します。
          </p>
        </div>
        {onClose && (
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="shrink-0 rounded border border-neutral-300 px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50"
          >
            閉じる
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={busy || disabled}
          onClick={() => inputRef.current?.click()}
          className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:cursor-not-allowed disabled:bg-neutral-300"
        >
          保存ページを選択
        </button>
        <p className="text-xs text-neutral-500">
          HTML のみ。外部サイトにはアクセスしません。
          {disabled ? "収集中は取り込みを一時停止しています。" : ""}
        </p>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept=".html,.htm,text/html"
        disabled={busy || disabled}
        onChange={(event) => {
          void onFile(event.target.files?.[0]);
          event.target.value = "";
        }}
        className="hidden"
      />

      <div
        onDragEnter={(event) => {
          event.preventDefault();
          if (!busy && !disabled) setDragging(true);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          if (!busy && !disabled) setDragging(true);
        }}
        onDragLeave={(event) => {
          event.preventDefault();
          setDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (!busy && !disabled) void onFile(event.dataTransfer.files[0]);
        }}
        aria-disabled={busy || disabled}
        className={`flex min-h-24 flex-col items-center justify-center gap-1 rounded border border-dashed p-3 text-center ${
          busy || disabled
            ? "border-neutral-200 bg-neutral-50 text-neutral-400"
            : dragging
              ? "border-neutral-900 bg-neutral-100 text-neutral-900"
              : "border-neutral-300 text-neutral-600"
        }`}
      >
        <p className="text-sm font-medium">ドラッグ＆ドロップ</p>
        <p className="text-xs">保存した HTML ファイルをここにドロップします。</p>
      </div>

      {busy && <p className="text-sm text-neutral-500">読み取り中…</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}
      {summary && (
        <div className="flex flex-col gap-1 text-xs text-neutral-600">
          <p>開示 {summary.disclosures} 件を保存ページから記録しました。</p>
          {summary.sourceUrl && <p>保存元: {summary.sourceUrl}</p>}
          {summary.recommendSourceDeletion && (
            <p className="rounded bg-amber-50 px-3 py-2 text-amber-800">
              取り込みは完了しました。元の保存 HTML はご自身で削除してください（自動削除はしません）。
            </p>
          )}
        </div>
      )}
    </div>
  );
}
