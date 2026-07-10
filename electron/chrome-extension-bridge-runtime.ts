import { ChromeExtensionBridge, type ChromeExtensionBridgeOptions } from "./chrome-extension-bridge.js";

export interface ChromeExtensionBridgeRuntimeOptions extends Omit<
  ChromeExtensionBridgeOptions,
  "commandHandler"
> {
  enabled: boolean;
  commandHandler?: ChromeExtensionBridgeOptions["commandHandler"];
}

/**
 * Create the Chrome extension bridge when the developer feature flag is on.
 * Outbound PageDriver dispatch (`sendCommand`) is built into the bridge
 * (Issue #338); an inbound `commandHandler` remains optional for tests/legacy.
 */
export function createChromeExtensionBridge(
  options: ChromeExtensionBridgeRuntimeOptions,
): ChromeExtensionBridge | undefined {
  if (!options.enabled) return undefined;
  const bridgeOptions: ChromeExtensionBridgeOptions = {
    appSupportDir: options.appSupportDir,
    socketPath: options.socketPath,
    ...(options.commandHandler === undefined ? {} : { commandHandler: options.commandHandler }),
    ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
  };
  return new ChromeExtensionBridge(bridgeOptions);
}
