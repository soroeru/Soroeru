import { useEffect, useState } from "react";
import type { VisibilityHost } from "./visibility-host.js";

export function CloudSettingsPanel({
  host,
  busy,
}: {
  host: VisibilityHost;
  busy: boolean;
}): React.JSX.Element {
  const [cloud, setCloud] = useState(() => host.cloudAssistEnabled);
  const [sharing, setSharing] = useState(() => host.telemetryEnabled);
  const [configured, setConfigured] = useState(() => host.settingsConfigured);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();

  useEffect(() => {
    if (!configured) {
      void host
        .configureSettings()
        .then(() => setConfigured(true))
        .catch(() => setError("設定を保存できませんでした。再試行してください。"));
    }
  }, [host, configured]);

  const update = (kind: "cloud" | "sharing", enabled: boolean): void => {
    setError(undefined);
    setNotice(undefined);
    setSaving(true);
    // Off takes effect synchronously in the host before the encrypted write begins.
    if (kind === "cloud") setCloud(enabled);
    else setSharing(enabled);
    const save = kind === "cloud" ? host.setCloudAssistEnabled(enabled) : host.setTelemetryEnabled(enabled);
    void save
      .then(() => {
        setConfigured(true);
        if (kind === "cloud") setCloud(enabled);
        else setSharing(enabled);
        setNotice(enabled ? "設定を保存しました。" : "停止しました。未送信データを破棄しました。");
      })
      .catch(() => {
        if (kind === "cloud" && enabled) setCloud(false);
        if (kind === "sharing" && enabled) setSharing(false);
        setError(
          "設定を暗号化保存できませんでした。オンへの変更は有効になっていません。再試行してください。",
        );
      })
      .finally(() => setSaving(false));
  };

  const regenerate = (): void => {
    setError(undefined);
    setNotice(undefined);
    setSaving(true);
    void host
      .regenerateValidatorKey()
      .then(() =>
        setNotice(
          "識別用キーを再生成し、未送信の対応付けデータを破棄しました。過去に送信済みのデータには影響しません。",
        ),
      )
      .catch(() =>
        setError("キーを保存できませんでした。古い対応付けデータは再送しません。保存を再試行してください。"),
      )
      .finally(() => setSaving(false));
  };

  return (
    <section
      aria-labelledby="cloud-settings-heading"
      className="flex flex-col gap-3 rounded border border-neutral-200 p-3"
    >
      <h2 id="cloud-settings-heading" className="font-semibold">
        クラウドと共有の設定
      </h2>
      {!host.cloudAvailable && (
        <p className="text-sm text-amber-800">
          このビルドではクラウド接続先が設定されていません。設定は保存できますが、クラウド機能は利用できません。
        </p>
      )}
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={cloud}
          disabled={saving}
          onChange={(event) => update("cloud", event.target.checked)}
        />
        <span>
          <strong>クラウドのフォーム知識と Gemini を使う</strong>
          <br />
          共有スキーマの取得と、フォーム構造だけを使った項目の対応付けを許可します。個人情報を Gemini
          に送る読み取りには別途その場での同意が必要です。
        </span>
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={sharing}
          disabled={saving}
          onChange={(event) => update("sharing", event.target.checked)}
        />
        <span>
          <strong>改善用の動作データを送る</strong>
          <br />
          値やページ本文を含まない、型付きの対応付けデータを共有します。送信にはクラウド支援も必要です。
        </span>
      </label>
      <div className="text-xs text-neutral-700">
        <p className="font-medium">情報の保存先</p>
        <ul className="list-disc pl-5">
          <li>個人情報とアカウント情報は端末内の暗号化 vault に保存します。</li>
          <li>共有フォーム知識はクラウドから取得し、利用可能なものを暗号化キャッシュします。</li>
          <li>改善用データは任意の設定で共有する、値を含まない型付きデータです。</li>
          <li>Gemini による個人情報の読み取りは、対象と範囲を示した別の同意がある場合だけ行います。</li>
        </ul>
      </div>
      <button
        type="button"
        disabled={saving}
        onClick={regenerate}
        className="self-start rounded border border-neutral-300 px-3 py-1 text-sm disabled:opacity-50"
      >
        識別用キーを再生成
      </button>
      {busy && (
        <p className="text-xs text-neutral-600">
          収集中でも設定を変更できます。オフにすると以後の送信を停止します。
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
    </section>
  );
}
