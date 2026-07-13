import { useCallback, useEffect, useState } from "react";
import type { ChromeBridgeStatusView } from "../../../electron/ipc/contract.js";
import { connectionLabel, normalizeApprovedOrigins } from "../chrome-bridge-ui.js";

const EMPTY: ChromeBridgeStatusView = { enabled: false, registered: false, connected: false };

export function ChromeBridgePanel(): React.JSX.Element {
  const [status, setStatus] = useState(EMPTY);
  const [origins, setOrigins] = useState<string[]>([]);
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const next = await window.soroeru.chromeBridge.status();
    setStatus(next);
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
      const result: {
        ok: boolean;
        error?: string;
        manualCleanupOrigins?: string[];
        permissionsCleanupUnknown?: boolean;
      } = await action().catch(() => ({ ok: false, error: "unknown" }));
      setMessage(
        result.ok
          ? typeof success === "string"
            ? success
            : success(result)
          : `失敗しました（${result.error ?? "unknown"}）`,
      );
      await refresh();
      setBusy(false);
    },
    [refresh],
  );

  if (!status.enabled) return <></>;
  return (
    <section className="flex flex-col gap-3 rounded border border-amber-300 bg-amber-50 p-4">
      <div>
        <p className="text-xs font-medium text-amber-800">開発者限定プロトタイプ</p>
        <h2 className="text-lg font-medium">Chrome と接続</h2>
        <p className="text-sm">
          状態: <strong>{connectionLabel(status)}</strong>
        </p>
      </div>
      {!status.registered && (
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
      {status.registered && !status.connected && (
        <p className="text-sm">
          Chrome の拡張機能画面（chrome://extensions）で Soroeru
          拡張を読み込み、拡張アイコンを確認してください。すでに拡張機能が読み込まれている場合は、拡張機能のリロード（またはサービスワーカーの再起動）を行ってください。
        </p>
      )}
      {status.connected && (
        <>
          <p className="text-sm">
            サイトを許可するには対象タブを開き、Chrome の Soroeru
            拡張アイコンをクリックしてください。権限要求は拡張ポップアップ内のボタンからのみ行われます。
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
      {status.registered && (
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
    </section>
  );
}
