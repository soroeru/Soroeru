// Unlocked Side Panel shell (Issue #569): the ledger, insights, and settings
// screens shared with the Electron renderer, plus the extension's own
// collection panel (Tier 3 consent and Cloud settings). The shared screens
// reach the vault through the panel's `window.soroeru` adapter.

import { useCallback, useEffect, useState } from "react";
import { InsightsPanel } from "../../src/renderer/components/InsightsPanel.js";
import { LedgerPanel } from "../../src/renderer/components/LedgerPanel.js";
import { SettingsPanel } from "../../src/renderer/components/SettingsPanel.js";
import type { VisibilityHost } from "./visibility-host.js";
import { VisibilityPanel } from "./VisibilityPanel.js";

type Tab = "ledger" | "collect" | "insights" | "settings";

const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: "collect", label: "このタブで収集" },
  { id: "ledger", label: "開示台帳" },
  { id: "insights", label: "インサイト" },
  { id: "settings", label: "設定" },
];

export function PanelShell({ host }: { host: VisibilityHost }): React.JSX.Element {
  // The extension's existing collection screen stays the landing view after unlock.
  const [tab, setTab] = useState<Tab>("collect");
  const [reloadToken, setReloadToken] = useState(0);
  const [ledgerBusy, setLedgerBusy] = useState(false);
  const [collectRunning, setCollectRunning] = useState(false);
  const bumpReload = useCallback(() => setReloadToken((token) => token + 1), []);

  // Track any run so leaving a tab cannot abandon a hand-off. `run-finished` is emitted
  // before the service clears its flag, and a failed run emits nothing, so re-read the
  // status after each event and while a run is believed active.
  useEffect(() => {
    const refresh = (): void => setCollectRunning(host.service.status().running);
    const unsubscribe = host.onEvent((event) => {
      setCollectRunning(event.type !== "run-finished");
      setTimeout(refresh, 0);
    });
    return unsubscribe;
  }, [host]);
  useEffect(() => {
    if (!collectRunning) return;
    const timer = setInterval(() => setCollectRunning(host.service.status().running), 1000);
    return () => clearInterval(timer);
  }, [collectRunning, host]);

  const busy = ledgerBusy || collectRunning;
  const select = (next: Tab): void => {
    if (next === tab || busy) return;
    if (tab === "collect") bumpReload();
    // Leaving is only possible while the ledger is idle; it unmounts with its run state.
    setLedgerBusy(false);
    setTab(next);
  };

  return (
    <div className="flex flex-col gap-3">
      <nav className="flex flex-wrap gap-1 border-b border-neutral-200" aria-label="画面">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            aria-current={tab === id ? "page" : undefined}
            disabled={busy && tab !== id}
            onClick={() => select(id)}
            className={
              tab === id
                ? "border-b-2 border-neutral-900 px-3 py-1.5 text-sm font-medium"
                : "px-3 py-1.5 text-sm text-neutral-600 disabled:opacity-50"
            }
          >
            {label}
          </button>
        ))}
      </nav>
      {busy && (
        <p className="text-xs text-neutral-500">
          収集の実行中は他の画面へ切り替えられません（ウォールの解決や再開のため）。
        </p>
      )}

      {/* Mounted only while shown: it follows every Visibility event, so a hidden ledger would
          adopt a hand-off from the collection tab. Switching away is blocked while it is busy. */}
      {tab === "ledger" && (
        <LedgerPanel
          reloadToken={reloadToken}
          onCollected={bumpReload}
          onCollectionBusyChange={setLedgerBusy}
        />
      )}
      {/* Mounted only while shown: it registers the Tier 3 consent gate, which must never open unseen. */}
      {tab === "collect" && <VisibilityPanel host={host} />}
      {tab === "insights" && <InsightsPanel reloadToken={reloadToken} />}
      {tab === "settings" && <SettingsPanel onImported={bumpReload} />}
    </div>
  );
}
