import { useCallback, useEffect, useState } from "react";
import type {
  ChromeBridgeConfigurationMutationResult,
  ChromeBridgeConfigurationView,
  ChromeBridgeStatusView,
} from "../../../electron/ipc/contract.js";
import {
  chromeBridgeRestartMessage,
  chromeBridgeRuntimeControlsEnabled,
  connectionLabel,
  normalizeApprovedOrigins,
  validateChromeExtensionId,
} from "../chrome-bridge-ui.js";

const EMPTY: ChromeBridgeStatusView = { enabled: false, registered: false, connected: false };

export function ChromeBridgePanel(): React.JSX.Element {
  const [status, setStatus] = useState(EMPTY);
  const [origins, setOrigins] = useState<string[]>([]);
  const [configuration, setConfiguration] = useState<ChromeBridgeConfigurationView>();
  const [enabled, setEnabled] = useState(false);
  const [extensionId, setExtensionId] = useState("");
  const [message, setMessage] = useState<string>();
  const [errorMessage, setErrorMessage] = useState<string>();
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [next, nextConfiguration] = await Promise.all([
      window.soroeru.chromeBridge.status(),
      window.soroeru.chromeBridge.configuration(),
    ]);
    setStatus(next);
    setConfiguration(nextConfiguration);
    setEnabled(nextConfiguration.stored.enabled);
    setExtensionId(nextConfiguration.stored.extensionId);
    if (next.connected) {
      const permissions = await window.soroeru.chromeBridge.permissions();
      setOrigins(normalizeApprovedOrigins(permissions.origins));
    } else setOrigins([]);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial IPC snapshot synchronizes external bridge state.
    void refresh();
    return window.soroeru.chromeBridge.onEvent(() => void refresh());
  }, [refresh]);

  const run = useCallback(
    async (
      action: () => Promise<{ ok: boolean; error?: string; manualCleanupOrigins?: string[] }>,
      success:
        | string
        | ((result: { manualCleanupOrigins?: string[]; permissionsCleanupUnknown?: boolean }) => string),
    ) => {
      setBusy(true);
      setErrorMessage(undefined);
      const result: {
        ok: boolean;
        error?: string;
        manualCleanupOrigins?: string[];
        permissionsCleanupUnknown?: boolean;
      } = await action().catch(() => ({ ok: false, error: "unknown" }));
      if (result.ok) setMessage(typeof success === "string" ? success : success(result));
      else setErrorMessage(`失敗しました（${result.error ?? "unknown"}）`);
      await refresh();
      setBusy(false);
    },
    [refresh],
  );

  const saveConfiguration = useCallback(async () => {
    const validation = validateChromeExtensionId(enabled, extensionId);
    if (validation) {
      setErrorMessage(validation);
      return;
    }
    setBusy(true);
    setMessage(undefined);
    setErrorMessage(undefined);
    const result: ChromeBridgeConfigurationMutationResult = await window.soroeru.chromeBridge
      .setConfiguration({ enabled, extensionId })
      .catch(() => ({ ok: false, error: "unknown" }));
    if (!result.ok || !result.configuration) {
      setErrorMessage(`設定を保存できませんでした（${result.error ?? "unknown"}）。`);
      setBusy(false);
      return;
    }
    setConfiguration(result.configuration);
    setMessage(
      result.configuration.restartRequired
        ? chromeBridgeRestartMessage(
            result.configuration.effective.enabled,
            result.configuration.stored.enabled,
          )
        : "Chrome 拡張ブリッジ設定を保存しました。",
    );
    await refresh();
    setBusy(false);
  }, [enabled, extensionId, refresh]);

  const enabledOverridden = configuration?.effective.enabledSource === "environment";
  const idOverridden = configuration?.effective.extensionIdSource === "environment";
  const runtimeControlsEnabled = chromeBridgeRuntimeControlsEnabled(status, configuration);

  return (
    <section className="flex flex-col gap-3 rounded border border-amber-300 bg-amber-50 p-4">
      <div>
        <p className="text-xs font-medium text-amber-800">移行中の開発者向けセットアップ</p>
        <h2 className="text-lg font-medium">Chrome と接続</h2>
        <p className="text-sm text-neutral-700">
          Chrome 拡張は選定済みの主経路ですが、現在は開発者モードでの設定が必要です。
        </p>
        <p className="text-sm">
          状態: <strong>{connectionLabel(status)}</strong>
        </p>
      </div>
      {configuration && (
        <div className="flex flex-col gap-3 rounded border border-amber-200 bg-white p-3">
          <label className="flex items-center gap-2 text-sm" htmlFor="chrome-bridge-enabled">
            <input
              id="chrome-bridge-enabled"
              type="checkbox"
              checked={enabled}
              disabled={busy || enabledOverridden}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            Chrome 拡張ブリッジを有効にする
          </label>
          {enabledOverridden && (
            <p className="text-xs text-amber-800">
              `SOROERU_ENABLE_CHROME_BRIDGE` が起動時設定を上書きしています。
            </p>
          )}
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium" htmlFor="chrome-extension-id">
              Chrome 拡張 ID
            </label>
            <input
              id="chrome-extension-id"
              type="text"
              value={extensionId}
              disabled={busy || idOverridden}
              spellCheck={false}
              autoComplete="off"
              aria-describedby="chrome-extension-id-help"
              onChange={(event) => setExtensionId(event.target.value.trim())}
              className="rounded border border-neutral-300 px-3 py-2 font-mono text-sm disabled:bg-neutral-100"
            />
            <p id="chrome-extension-id-help" className="text-xs text-neutral-600">
              chrome://extensions に表示される32文字のIDを入力します。ID 変更後は「host
              を登録して接続を始める」で再登録してください（アプリ再起動はリスナー有効化用）。
            </p>
            {idOverridden && (
              <p className="text-xs text-amber-800">
                `SOROERU_CHROME_EXTENSION_ID` が起動時設定を上書きしています。
              </p>
            )}
          </div>
          <button
            type="button"
            disabled={busy || (enabledOverridden && idOverridden)}
            onClick={() => void saveConfiguration()}
            className="self-start rounded bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50"
          >
            設定を保存
          </button>
          {configuration.restartRequired && (
            <p role="status" className="font-medium text-amber-900">
              {chromeBridgeRestartMessage(configuration.effective.enabled, configuration.stored.enabled)}
            </p>
          )}
          {configuration.validationError && (
            <p role="alert" className="text-sm text-red-700">
              起動時のChrome拡張設定が無効なため、ブリッジを安全にOFFにしました。環境変数または保存済みIDを確認してください。
            </p>
          )}
        </div>
      )}
      {runtimeControlsEnabled && !status.registered && (
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void run(
              () => window.soroeru.chromeBridge.connect(),
              "host と manifest を登録しました。Chrome で dist/extension を「パッケージ化されていない拡張機能」として読み込んでください。すでに拡張機能が読み込まれている場合は、chrome://extensions で拡張機能のリロード（またはサービスワーカーの再起動）を行ってください。拡張とのハンドシェイクを待っています。",
            )
          }
          className="self-start rounded bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50"
        >
          host を登録して接続を始める
        </button>
      )}
      {runtimeControlsEnabled && status.registered && !status.connected && (
        <p className="text-sm">
          Chrome の拡張機能画面（chrome://extensions）で Soroeru
          拡張を読み込み、拡張アイコンを確認してください。すでに拡張機能が読み込まれている場合は、拡張機能のリロード（またはサービスワーカーの再起動）を行ってください。
        </p>
      )}
      {runtimeControlsEnabled && status.connected && (
        <>
          <p className="text-sm">
            開示台帳のサイトを操作する準備ができています。台帳に登録されているサイトが自動操作スコープとして扱われます。
          </p>
          <div>
            <h3 className="text-sm font-medium">承認済みオリジン</h3>
            {origins.length === 0 ? (
              <p className="text-sm text-neutral-600">まだありません。</p>
            ) : (
              <ul className="mt-1 flex flex-col gap-1">
                {origins.map((origin) => (
                  <li key={origin} className="flex items-center justify-between gap-3 text-sm">
                    <code>{origin}</code>
                    <button
                      type="button"
                      disabled={busy}
                      className="underline"
                      onClick={() =>
                        void run(
                          () => window.soroeru.chromeBridge.revokeOrigin(origin),
                          `${origin} の許可を取り消しました。`,
                        )
                      }
                    >
                      取り消す
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
      {runtimeControlsEnabled && status.registered && (
        <button
          type="button"
          disabled={busy}
          className="self-start text-sm text-red-700 underline"
          onClick={() =>
            void run(
              () => window.soroeru.chromeBridge.disconnect(),
              (result) => {
                const remaining = result.manualCleanupOrigins ?? [];
                return result.permissionsCleanupUnknown
                  ? "manifest と host を削除しました。Chrome に接続できなかったため、サイト許可の状態は確認できません。Chrome の拡張管理画面で許可と拡張本体を手動で削除してください。"
                  : remaining.length > 0
                    ? `manifest と host を削除しました。次のサイト許可は Chrome の拡張管理画面で手動で取り消してください: ${remaining.join(", ")}。拡張本体も手動で削除してください。`
                    : "承認済みサイト許可を取り消し、manifest と host を削除しました。拡張本体は Chrome の拡張管理画面から手動で削除してください。";
              },
            )
          }
        >
          切断して登録物を掃除
        </button>
      )}
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      {errorMessage && (
        <p role="alert" className="text-sm text-red-700">
          {errorMessage}
        </p>
      )}
    </section>
  );
}
