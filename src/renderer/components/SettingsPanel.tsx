// Settings tab (Issue #314): a plain-text diagnostics log the user can attach
// to a bug report. The main process reads the local unencrypted log file and
// returns its text over IPC; this panel triggers a browser-side file download
// (a Blob + a transient <a download>) — no native save dialog, no filesystem
// access is granted to the renderer.
//
// Issue #341 also hosts CSV import here (moved from the removed Site Management
// tab). Import still only sends bytes over IPC and returns a counts-only
// summary; collection itself runs from the Disclosure ledger.

import { useCallback, useState } from "react";
import { reasonMessage } from "../messages.js";
import { CsvImportPanel } from "./CsvImportPanel.js";

type DownloadState = "idle" | "downloading" | "done";

interface SettingsPanelProps {
  onImported: () => void;
}

export function SettingsPanel({ onImported }: SettingsPanelProps): React.JSX.Element {
  const [state, setState] = useState<DownloadState>("idle");
  const [error, setError] = useState<string | undefined>();

  const downloadLogs = useCallback(async () => {
    setState("downloading");
    setError(undefined);
    try {
      const result = await window.soroeru.logs.export();
      if (!result.ok || result.content === undefined) {
        setError(reasonMessage(result.error));
        setState("idle");
        return;
      }
      const blob = new Blob([result.content], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = result.fileName ?? "soroeru-log.log";
      link.click();
      URL.revokeObjectURL(url);
      setState("done");
    } catch {
      setError(reasonMessage(undefined));
      setState("idle");
    }
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">パスワード CSV の取り込み</h2>
        <p className="text-sm text-neutral-600">
          Google / Chrome のパスワード マネージャーから書き出した CSV を取り込みます。
          取り込み後は開示台帳タブでサイトを選んで収集してください。
        </p>
        <CsvImportPanel onImported={onImported} />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">ログ</h2>
        <p className="text-sm text-neutral-600">
          アプリの動作記録（ログイン・収集の成否、エラー内容など）をファイルに書き出します。
          個人情報の値は含まれません。不具合を報告する際に添付してください。
        </p>
        <button
          type="button"
          onClick={() => void downloadLogs()}
          disabled={state === "downloading"}
          className="self-start rounded bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50"
        >
          {state === "downloading" ? "書き出し中…" : "ログをダウンロード"}
        </button>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </section>
    </div>
  );
}
