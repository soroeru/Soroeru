// Side Panel vault UI (Issue #557): setup / unlock / lock in the extension.
// Reuses the Electron `VaultGate` with a submit action backed by `VaultSession`.
// The one-time recovery key is held only in component state until acknowledged.

import { useCallback, useEffect, useState } from "react";
import { VaultGate, type VaultGateSubmit } from "../src/renderer/components/VaultGate.js";
import type { VaultSession, VaultSessionState } from "../src/store/vault-session.js";
import { saveVaultBackup, type BackupPicker, type VaultBackupResult } from "./vault-backup.js";
import { importFailureMessage, vaultErrorMessage } from "./sidepanel-messages.js";

export interface VaultPanelProps {
  session: VaultSession;
  started: Promise<unknown>;
  persistGranted: Promise<boolean>;
  /** Content shown while unlocked (Issue #558: the Visibility ledger). */
  unlockedContent?: React.ReactNode;
  /** Replaces the direct lock so a running collection is stopped and saved first (Issue #558). */
  onLock?: () => void | Promise<void>;
}

export function VaultPanel({
  session,
  started,
  persistGranted,
  unlockedContent,
  onLock,
}: VaultPanelProps): React.JSX.Element {
  const [state, setState] = useState<VaultSessionState>(session.state);
  const [fatalError, setFatalError] = useState<string | undefined>();
  const [persistDenied, setPersistDenied] = useState(false);
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  const [exportRecommended, setExportRecommended] = useState(session.exportRecommended);
  const [downloadPending, setDownloadPending] = useState(false);
  const [pendingDownload, setPendingDownload] = useState<Extract<
    VaultBackupResult,
    { outcome: "download" }
  > | null>(null);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importSecret, setImportSecret] = useState("");
  const [replaceConfirmed, setReplaceConfirmed] = useState(false);
  const [importMessage, setImportMessage] = useState<string>();
  const [exportError, setExportError] = useState<string | undefined>();
  // True from submitting setup until the recovery key is in state, so the
  // unlocked view never renders before the one-time recovery key is shown.
  const [creating, setCreating] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [locking, setLocking] = useState(false);
  const [lockError, setLockError] = useState<string | undefined>();

  useEffect(
    () =>
      session.onStateChange((next) => {
        setState(next);
        setExportRecommended(session.exportRecommended);
        if (next !== "unlocked") setRecoveryKey(null);
      }),
    [session],
  );
  useEffect(() => {
    started.catch((err: unknown) => setFatalError(vaultErrorMessage(err)));
    void persistGranted.then((granted) => setPersistDenied(!granted));
  }, [started, persistGranted]);

  const submit = useCallback<VaultGateSubmit>(
    async ({ kind, secret }) => {
      try {
        if (kind === "setup") {
          setCreating(true);
          try {
            const key = await session.create(secret);
            setRecoveryKey(key);
            setExportRecommended(session.exportRecommended);
          } finally {
            setCreating(false);
          }
        } else if (kind === "recovery") {
          await session.unlockWithRecoveryKey(secret);
        } else {
          await session.unlock(secret);
        }
        return undefined;
      } catch (err) {
        return vaultErrorMessage(err);
      }
    },
    [session],
  );

  const retry = useCallback(() => {
    setRetrying(true);
    session
      .start()
      .then(
        () => setFatalError(undefined),
        (err: unknown) => setFatalError(vaultErrorMessage(err)),
      )
      .finally(() => setRetrying(false));
  }, [session]);

  const downloadExport = useCallback(async () => {
    setExportError(undefined);
    setPendingDownload(null);
    setDownloadPending(false);
    try {
      setExporting(true);
      const result = await saveVaultBackup(window as BackupPicker, () => session.exportEncrypted());
      if (result.outcome === "saved") session.markExported();
      else setPendingDownload(result);
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) setExportError(vaultErrorMessage(err));
    } finally {
      setExporting(false);
      setExportRecommended(session.exportRecommended);
    }
  }, [session]);

  const startFallbackDownload = useCallback(() => {
    if (!pendingDownload) return;
    const url = URL.createObjectURL(pendingDownload.blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = pendingDownload.name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setPendingDownload(null);
    setDownloadPending(true);
  }, [pendingDownload]);

  const showRecoveryKey = state === "unlocked" && recoveryKey !== null;
  const showUnlocked = state === "unlocked" && !showRecoveryKey && !creating;

  return (
    <main className="flex min-h-screen flex-col gap-4 p-4 text-sm">
      <header className="flex items-center justify-between gap-2 border-b border-neutral-200 pb-2">
        <h1 className="text-base font-semibold text-orange-900">Soroeru</h1>
        {state === "unlocked" && (
          <button
            type="button"
            disabled={locking}
            onClick={() => {
              setLocking(true);
              setLockError(undefined);
              void Promise.resolve()
                .then(() => (onLock ? onLock() : session.lock()))
                .catch(() => {
                  setLockError(
                    "保存できなかったため施錠していません。再試行するか、暗号化エクスポートで控えを保存してください。",
                  );
                })
                .finally(() => setLocking(false));
            }}
            className="text-sm underline"
          >
            施錠
          </button>
        )}
      </header>
      {lockError && state === "unlocked" && (
        <p role="alert" className="text-red-600">
          {lockError}
        </p>
      )}

      {persistDenied && (
        <p className="rounded bg-amber-100 p-2 text-xs text-amber-900">
          ブラウザがデータの永続保存を許可しませんでした。空き容量が少ないと vault
          が消去される場合があります。暗号化エクスポートで控えを保存してください。
        </p>
      )}

      {fatalError && (
        <p role="alert" className="text-red-600">
          {fatalError}
        </p>
      )}

      {!fatalError && state === "starting" && <p role="status">vault を確認しています…</p>}

      {state === "in-use-elsewhere" && (
        <div className="flex flex-col gap-2">
          <p>Soroeru は別のウィンドウで使用中です。そちらのサイドパネルを閉じてから再試行してください。</p>
          <button
            type="button"
            onClick={retry}
            disabled={retrying}
            className="self-start rounded border border-neutral-300 px-3 py-1 disabled:opacity-50"
          >
            再試行
          </button>
        </div>
      )}

      {!fatalError && !importing && (state === "absent" || state === "locked") && (
        <VaultGate
          mode={state === "absent" ? "setup" : "unlock"}
          onSuccess={() => undefined}
          submit={submit}
        />
      )}

      {(state === "absent" || state === "locked") && (
        <form
          className="flex flex-col gap-2 rounded border p-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!importFile || importing || (state === "locked" && !replaceConfirmed)) return;
            setImporting(true);
            setImportMessage(undefined);
            void importFile
              .text()
              .then((text) => session.importEncrypted(text, importSecret, replaceConfirmed))
              .then(
                () => {
                  setFatalError(undefined);
                  setImportMessage("取り込みました。元のパスフレーズで解錠して内容を確認してください。");
                  setImportFile(null);
                  setReplaceConfirmed(false);
                },
                (err: unknown) => setImportMessage(importFailureMessage(err)),
              )
              .finally(() => {
                setImportSecret("");
                setImporting(false);
              });
          }}
        >
          <h2 className="font-semibold">暗号化バックアップを取り込む</h2>
          <p>拡張または旧 Mac 版の Vault v2 エクスポートを選び、元のパスフレーズを入力してください。</p>
          <label>
            暗号化ファイル
            <input
              type="file"
              accept=".json,application/json"
              disabled={importing}
              onChange={(event) => {
                setImportFile(event.target.files?.[0] ?? null);
                setReplaceConfirmed(false);
                setImportMessage(undefined);
              }}
            />
          </label>
          <label>
            元のパスフレーズ
            <input
              type="password"
              autoComplete="off"
              value={importSecret}
              disabled={importing}
              onChange={(event) => setImportSecret(event.target.value)}
            />
          </label>
          {state === "locked" && (
            <label>
              <input
                type="checkbox"
                checked={replaceConfirmed}
                disabled={importing}
                onChange={(event) => setReplaceConfirmed(event.target.checked)}
              />
              現在の Soroeru 内データをすべて削除し、このファイルの内容に置き換えます
            </label>
          )}
          <button
            type="submit"
            disabled={importing || !importFile || !importSecret || (state === "locked" && !replaceConfirmed)}
          >
            {importing ? "検証して取り込んでいます…" : "暗号化ファイルを取り込む"}
          </button>
          {importMessage && <p role="status">{importMessage}</p>}
        </form>
      )}

      {showRecoveryKey && (
        <div className="flex flex-col gap-2">
          <p>
            リカバリーキーです。この画面でだけ表示されます。パスフレーズを忘れたときに必要なので、紙などに控えて安全な場所に保管してください。
          </p>
          <p className="select-all break-all rounded bg-neutral-100 p-2 font-mono">{recoveryKey}</p>
          <button
            type="button"
            onClick={() => setRecoveryKey(null)}
            className="self-start rounded bg-neutral-900 px-4 py-2 text-white"
          >
            控えました
          </button>
        </div>
      )}

      {showUnlocked && (
        <div className="flex flex-col gap-3">
          {(exportRecommended || persistDenied) && (
            <p className="rounded bg-amber-100 p-2 text-xs text-amber-900">
              vault はこのブラウザにだけ保存されています。拡張の削除や「サイトデータを削除」で失われるため、
              暗号化エクスポートで控えを保存してください。
            </p>
          )}
          <p>
            vault
            は解錠されています。サイドパネルを閉じる、ブラウザを再起動する、または「施錠」を押すと鍵を破棄します。
          </p>
          {unlockedContent}
          <button
            type="button"
            disabled={exporting}
            onClick={() => void downloadExport()}
            className="self-start rounded border border-neutral-300 px-3 py-1"
          >
            暗号化エクスポートを保存
          </button>
          {pendingDownload && (
            <div>
              <p>
                このブラウザは保存先の選択に対応していません。ダウンロードして、ファイルを安全な場所に保存してください。
              </p>
              <button type="button" onClick={startFallbackDownload}>
                ダウンロード
              </button>
            </div>
          )}
          {downloadPending && (
            <div>
              <p>ダウンロードしたファイルを安全な場所に保存し、保存できたことを確認してください。</p>
              <button
                type="button"
                onClick={() => {
                  session.markExported();
                  setDownloadPending(false);
                  setExportRecommended(false);
                }}
              >
                ファイルを保存できました
              </button>
            </div>
          )}
          {exportError && (
            <p role="alert" className="text-red-600">
              {exportError}
            </p>
          )}
        </div>
      )}
    </main>
  );
}
