import type { ChromeBridgeStatusView, ChromeBridgeTabView } from "../../electron/ipc/contract.js";

export function connectionLabel(status: ChromeBridgeStatusView): string {
  if (!status.enabled) return "無効（開発者フラグOFF）";
  if (!status.registered) return "未登録";
  return status.connected ? "接続済み" : "拡張の接続待ち";
}

export function normalizeApprovedOrigins(patterns: readonly string[]): string[] {
  const origins = new Set<string>();
  for (const pattern of patterns) {
    try {
      const url = new URL(pattern.replace(/\/\*$/, "/"));
      if (url.protocol === "https:") origins.add(url.origin);
    } catch {
      // Invalid or non-HTTPS permission patterns never reach the renderer list.
    }
  }
  return [...origins].sort();
}

export function tabConfirmationLabel(tab: ChromeBridgeTabView): string {
  return `${tab.origin}（タブ ${tab.tabId}）`;
}

export async function prepareChromeBridgeRun(
  api: {
    status(): Promise<ChromeBridgeStatusView>;
    activeTab(): Promise<ChromeBridgeTabView | undefined>;
    selectTab(tabId: number): Promise<{ ok: boolean }>;
  },
  confirm: (message: string) => boolean,
): Promise<boolean> {
  const status = await api.status();
  if (!status.enabled || !status.connected) return true; // Existing Playwright path.
  const tab = await api.activeTab();
  if (!tab) return false;
  if (!confirm(`このタブで実行しますか？\n${tabConfirmationLabel(tab)}`)) return false;
  return (await api.selectTab(tab.tabId)).ok;
}
