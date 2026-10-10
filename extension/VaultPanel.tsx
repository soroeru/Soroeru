// Side Panel vault UI (Issue #557): setup / unlock / lock in the extension.
// Reuses the Electron `VaultGate` with a submit action backed by `VaultSession`.
// The one-time recovery key is held only in component state until acknowledged.

import { useCallback, useEffect, useState } from "react";
import { VaultGate, type VaultGateSubmit } from "../src/renderer/components/VaultGate.js";
import type { VaultSession, VaultSessionState } from "../src/store/vault-session.js";
import { vaultErrorMessage } from "./sidepanel-messages.js";

export interface VaultPanelProps {
  session: VaultSession;
  started: Promise<unknown>;
  persistGranted: Promise<boolean>;
}

export function VaultPanel({ session, started, persistGranted }: VaultPanelProps): React.JSX.Element {
  const [state, setState] = useState<VaultSessionState>(session.state);
  const [fatalError, setFatalError] = useState<string | undefined>();
  const [persistDenied, setPersistDenied] = useState(false);
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  const [exportRecommended, setExportRecommended] = useState(session.exportRecommended);
  const [exportError, setExportError] = useState<string | undefined>();

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
          const key = await session.create(secret);
          setRecoveryKey(key);
          setExportRecommended(session.exportRecommended);
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
    session.start().catch((err: unknown) => setFatalError(vaultErrorMessage(err)));
  }, [session]);

  const downloadExport = useCallback(async () => {
    setExportError(undefined);
    try {
      const exported = await session.exportEncrypted();
      const url = URL.createObjectURL(new Blob([exported], { type: "application/json" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      // persist: encrypted-export — same AES-256-GCM encrypted Vault v2 shape as the stored document
      anchor.download = `soroeru-vault-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (err) {
      setExportError(vaultErrorMessage(err));
    } finally {
      setExportRecommended(session.exportRecommended);
    }
  }, [session]);

  const showRecoveryKey = state === "unlocked" && recoveryKey !== null;

  return (
    <main className="flex min-h-screen flex-col gap-4 p-4 text-sm">
      <header className="flex items-center justify-between gap-2 border-b border-neutral-200 pb-2">
        <h1 className="text-base font-semibold text-orange-900">Soroeru</h1>
        {state === "unlocked" && (
          <button type="button" onClick={() => session.lock()} className="text-sm underline">
            施錠
          </button>
        )}
      </header>

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
            className="self-start rounded border border-neutral-300 px-3 py-1"
          >
            再試行
          </button>
        </div>
      )}

      {(state === "absent" || state === "locked") && (
        <VaultGate
          mode={state === "absent" ? "setup" : "unlock"}
          onSuccess={() => undefined}
          submit={submit}
        />
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

      {state === "unlocked" && !showRecoveryKey && (
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
          <button
            type="button"
            onClick={() => void downloadExport()}
            className="self-start rounded border border-neutral-300 px-3 py-1"
          >
            暗号化エクスポートを保存
          </button>
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
