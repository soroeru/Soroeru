// Slice A renderer (issue #160): vault setup / unlock (incl. recovery key) →
// CSV import & queue review → Disclosure ledger (per-site composed view with
// stale flags and re-authenticated reveal). Everything crosses the typed IPC
// boundary; the renderer holds no fs/network/vault handle and sees only
// sanitized, masked views (RFC-002 §3 / §5.1).

import { useCallback, useEffect, useState } from "react";
import type { VaultStatus } from "../../electron/ipc/contract.js";
import { reasonMessage } from "./messages.js";
import { VaultGate } from "./components/VaultGate.js";
import { InsightsPanel } from "./components/InsightsPanel.js";
import { LedgerPanel } from "./components/LedgerPanel.js";
import { SettingsPanel } from "./components/SettingsPanel.js";
import { SiteManagementPanel } from "./components/SiteManagementPanel.js";

type Phase = "loading" | "setup" | "unlock" | "unlocked";
type Tab = "sites" | "ledger" | "insights" | "settings";

function phaseFor(status: VaultStatus): Phase {
  if (!status.exists) return "setup";
  return status.locked ? "unlock" : "unlocked";
}

export function App(): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>("loading");
  const [tab, setTab] = useState<Tab>("sites");
  const [hasRecoveryKey, setHasRecoveryKey] = useState(false);
  const [recoveryKey, setRecoveryKey] = useState<string | undefined>();
  const [reloadToken, setReloadToken] = useState(0);
  const [recoveryError, setRecoveryError] = useState<string | undefined>();
  const [statusError, setStatusError] = useState<string | undefined>();

  const refresh = useCallback(async () => {
    // Guard the status round trip: a rejected invoke must not leave the app stuck
    // on "loading" with an unhandled rejection (the pre-refactor gate did this).
    try {
      const status = await window.soroeru.vault.status();
      setStatusError(undefined);
      setPhase(phaseFor(status));
      setHasRecoveryKey(status.hasRecoveryKey);
    } catch {
      setStatusError(reasonMessage(undefined));
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const lock = useCallback(async () => {
    await window.soroeru.vault.lock();
    setRecoveryKey(undefined);
    // Drop any stale recovery error so it cannot reappear on the next unlock.
    setRecoveryError(undefined);
    await refresh();
  }, [refresh]);

  const generateRecovery = useCallback(async () => {
    setRecoveryError(undefined);
    try {
      const result = await window.soroeru.vault.generateRecoveryKey();
      if (!result.ok || !result.recoveryKey) {
        setRecoveryError(reasonMessage(result.error));
        return;
      }
      setRecoveryKey(result.recoveryKey);
      await refresh();
    } catch {
      setRecoveryError(reasonMessage(undefined));
    }
  }, [refresh]);

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Soroeru</h1>
          <p className="text-sm text-neutral-500">ローカルファースト・エージェンシーエンジン</p>
        </div>
        {phase === "unlocked" && (
          <button type="button" onClick={() => void lock()} className="text-sm underline">
            施錠
          </button>
        )}
      </header>

      {statusError && <p className="text-sm text-red-600">{statusError}</p>}

      {phase === "loading" && !statusError && <p>読み込み中…</p>}

      {(phase === "setup" || phase === "unlock") && <VaultGate mode={phase} onSuccess={refresh} />}

      {phase === "unlocked" && (
        <>
          <RecoveryKeyNotice
            hasRecoveryKey={hasRecoveryKey}
            recoveryKey={recoveryKey}
            onGenerate={() => void generateRecovery()}
            onDismiss={() => setRecoveryKey(undefined)}
          />
          {recoveryError && <p className="text-sm text-red-600">{recoveryError}</p>}

          <nav className="flex gap-2 border-b border-neutral-200">
            <TabButton active={tab === "sites"} onClick={() => setTab("sites")}>
              サイト管理
            </TabButton>
            <TabButton active={tab === "ledger"} onClick={() => setTab("ledger")}>
              開示台帳
            </TabButton>
            <TabButton active={tab === "insights"} onClick={() => setTab("insights")}>
              インサイト
            </TabButton>
            <TabButton active={tab === "settings"} onClick={() => setTab("settings")}>
              設定
            </TabButton>
          </nav>

          {tab === "sites" && (
            <SiteManagementPanel
              reloadToken={reloadToken}
              onCollected={() => setReloadToken((token) => token + 1)}
              onImported={() => setReloadToken((token) => token + 1)}
            />
          )}
          {tab === "ledger" && <LedgerPanel reloadToken={reloadToken} />}
          {tab === "insights" && <InsightsPanel reloadToken={reloadToken} />}
          {tab === "settings" && <SettingsPanel />}
        </>
      )}
    </main>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-2 text-sm ${active ? "border-b-2 border-neutral-900 font-medium" : "text-neutral-500"}`}
    >
      {children}
    </button>
  );
}

function RecoveryKeyNotice({
  hasRecoveryKey,
  recoveryKey,
  onGenerate,
  onDismiss,
}: {
  hasRecoveryKey: boolean;
  recoveryKey: string | undefined;
  onGenerate: () => void;
  onDismiss: () => void;
}): React.JSX.Element | null {
  const [copiedRecoveryKey, setCopiedRecoveryKey] = useState<string | undefined>();
  const copyState = copiedRecoveryKey === recoveryKey ? "copied" : "idle";

  useEffect(() => {
    if (copyState !== "copied") return;
    const timeout = window.setTimeout(() => {
      setCopiedRecoveryKey(undefined);
    }, 3000);
    return () => window.clearTimeout(timeout);
  }, [copyState]);

  const copyRecoveryKey = useCallback(async () => {
    if (!recoveryKey) return;
    try {
      await navigator.clipboard.writeText(recoveryKey);
      setCopiedRecoveryKey(recoveryKey);
    } catch {
      // Manual select-all remains available when clipboard access is unavailable.
    }
  }, [recoveryKey]);

  if (recoveryKey) {
    return (
      <div className="flex flex-col gap-2 rounded border border-amber-300 bg-amber-50 p-4">
        <p className="text-sm font-medium text-amber-900">リカバリーキー（一度だけ表示されます）</p>
        <div className="flex flex-col gap-2 rounded bg-white p-3 sm:flex-row sm:items-start">
          <code className="min-w-0 flex-1 select-all break-all font-mono text-sm">{recoveryKey}</code>
          <button
            type="button"
            onClick={() => void copyRecoveryKey()}
            className="shrink-0 rounded border border-amber-300 px-3 py-1.5 text-xs font-medium text-amber-900"
          >
            {copyState === "copied" ? "コピーしました" : "コピー"}
          </button>
        </div>
        <p className="text-xs text-amber-800">
          安全な場所に保管してください。パスフレーズを忘れた場合の唯一の復旧手段です。再表示はできません。
        </p>
        <button type="button" onClick={onDismiss} className="self-start text-xs underline">
          保管しました
        </button>
      </div>
    );
  }
  if (hasRecoveryKey) return null;
  return (
    <div className="flex items-center justify-between gap-2 rounded border border-neutral-200 p-3">
      <p className="text-sm text-neutral-600">
        リカバリーキーが未設定です。パスフレーズ紛失時の復旧用に作成できます。
      </p>
      <button
        type="button"
        onClick={onGenerate}
        className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white"
      >
        作成
      </button>
    </div>
  );
}
