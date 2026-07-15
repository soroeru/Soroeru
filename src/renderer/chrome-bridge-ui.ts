import type {
  ChromeBridgeConfigurationView,
  ChromeBridgeStatusView,
  ChromeBridgeTabView,
} from "../../electron/ipc/contract.js";

export function connectionLabel(status: ChromeBridgeStatusView): string {
  if (!status.enabled) return "OFF（起動時設定）";
  if (!status.registered) return "未登録";
  return status.connected ? "接続済み" : "拡張の接続待ち";
}

export function validateChromeExtensionId(enabled: boolean, extensionId: string): string | undefined {
  if (!enabled && extensionId === "") return undefined;
  return /^[a-p]{32}$/.test(extensionId) ? undefined : "32文字の拡張ID（a〜pの小文字）を入力してください。";
}

export function chromeBridgeRestartMessage(currentEnabled: boolean, nextEnabled: boolean): string {
  if (currentEnabled && !nextEnabled) {
    return "接続リスナーを停止しました。再起動すると Chrome 拡張ブリッジは OFF で起動します。";
  }
  if (!currentEnabled && nextEnabled) {
    return "現在のプロセスではまだ OFF です。再起動すると Chrome 拡張ブリッジが ON になります。";
  }
  return "拡張IDの変更は再起動後に反映されます。現在の接続は再起動まで以前のIDを使用します。";
}

export function chromeBridgeRuntimeControlsEnabled(
  status: ChromeBridgeStatusView,
  configuration: ChromeBridgeConfigurationView | undefined,
): boolean {
  return (
    status.enabled &&
    (configuration?.effective.enabledSource === "environment" || configuration?.stored.enabled !== false)
  );
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
