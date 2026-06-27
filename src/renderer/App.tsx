// Minimal renderer for slice A's first IPC round trip (issue #158): detect
// whether a vault exists, set it up or unlock it, then show the sanitized
// DomainService summary returned over typed IPC. This is intentionally a
// skeleton — the full ledger / CSV / Reflection screens land in #160 / #161.

import { useCallback, useEffect, useState } from "react";
import { Label } from "@radix-ui/react-label";
import { MIN_PASSPHRASE_LENGTH } from "../../electron/ipc/contract.js";
import type { DomainSummary, VaultStatus } from "../../electron/ipc/contract.js";

type Phase = "loading" | "setup" | "unlock" | "unlocked";

function phaseFor(status: VaultStatus): Phase {
  if (!status.exists) return "setup";
  return status.locked ? "unlock" : "unlocked";
}

export function App(): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>("loading");
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<DomainSummary | undefined>();

  const refresh = useCallback(async () => {
    const status = await window.soroeru.vault.status();
    setPhase(phaseFor(status));
    if (!status.locked && status.exists) {
      setSummary(await window.soroeru.domain.summary());
    }
  }, []);

  useEffect(() => {
    // Load-on-mount: synchronize the UI with the main-process vault state. The
    // state update happens after the awaited IPC call, not synchronously.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const submit = useCallback(
    async (mode: "setup" | "unlock") => {
      setBusy(true);
      setError(undefined);
      try {
        const result =
          mode === "setup"
            ? await window.soroeru.vault.setup(passphrase)
            : await window.soroeru.vault.unlock(passphrase);
        if (!result.ok) {
          setError(mode === "setup" ? "ボールトを作成できませんでした。" : "解錠に失敗しました。");
          return;
        }
        setPassphrase("");
        setSummary(await window.soroeru.domain.summary());
        setPhase("unlocked");
      } catch {
        // A rejected IPC invoke (e.g. a disk error in the main handler) must not
        // become a silent failure or an unhandled rejection.
        setError("操作に失敗しました。時間をおいて再試行してください。");
      } finally {
        setBusy(false);
      }
    },
    [passphrase],
  );

  const lock = useCallback(async () => {
    await window.soroeru.vault.lock();
    setSummary(undefined);
    await refresh();
  }, [refresh]);

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-8">
      <header>
        <h1 className="text-2xl font-semibold">Soroeru</h1>
        <p className="text-sm text-neutral-500">ローカルファースト・エージェンシーエンジン</p>
      </header>

      {phase === "loading" && <p>読み込み中…</p>}

      {(phase === "setup" || phase === "unlock") && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit(phase);
          }}
        >
          <Label htmlFor="passphrase" className="text-sm font-medium">
            {phase === "setup" ? "マスターパスフレーズを設定" : "マスターパスフレーズ"}
          </Label>
          <input
            id="passphrase"
            type="password"
            autoComplete="off"
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
            className="rounded border border-neutral-300 px-3 py-2"
          />
          <button
            type="submit"
            disabled={
              busy ||
              (phase === "setup" ? passphrase.length < MIN_PASSPHRASE_LENGTH : passphrase.length === 0)
            }
            className="rounded bg-neutral-900 px-4 py-2 text-white disabled:opacity-50"
          >
            {phase === "setup" ? "作成して解錠" : "解錠"}
          </button>
          {phase === "setup" && (
            <p className="text-xs text-neutral-400">{MIN_PASSPHRASE_LENGTH}文字以上で設定してください。</p>
          )}
          {error && <p className="text-sm text-red-600">{error}</p>}
        </form>
      )}

      {phase === "unlocked" && summary && (
        <section className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-medium">ドメイン概要</h2>
            <button type="button" onClick={() => void lock()} className="text-sm underline">
              施錠
            </button>
          </div>
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <dt className="text-neutral-500">サイトアカウント数</dt>
            <dd>{summary.siteAccountCount}</dd>
            <dt className="text-neutral-500">個人属性数</dt>
            <dd>{summary.attributeCount}</dd>
          </dl>
          {summary.attributes.length > 0 && (
            <ul className="flex flex-col gap-1 text-sm">
              {summary.attributes.map((attr) => (
                <li key={attr.attributeKey} className="flex justify-between">
                  <span>{attr.label}</span>
                  <span className="font-mono text-neutral-500">{attr.preview || "—"}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-neutral-400">値はマスク済みのプレビューです（生の値は表示しません）。</p>
        </section>
      )}
    </main>
  );
}
