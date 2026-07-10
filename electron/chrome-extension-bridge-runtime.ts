import { ChromeExtensionBridge, type ChromeExtensionBridgeOptions } from "./chrome-extension-bridge.js";

export interface ChromeExtensionBridgeRuntimeOptions extends Omit<
  ChromeExtensionBridgeOptions,
  "commandHandler"
> {
  enabled: boolean;
  commandHandler?: ChromeExtensionBridgeOptions["commandHandler"];
}

/**
 * Keep the transport unavailable until the command dispatcher is wired. The
 * Electron app must not advertise an authenticated but non-functional bridge.
 */
export function createChromeExtensionBridge(
  options: ChromeExtensionBridgeRuntimeOptions,
): ChromeExtensionBridge | undefined {
  if (!options.enabled || typeof options.commandHandler !== "function") return undefined;
  const bridgeOptions: ChromeExtensionBridgeOptions = {
    appSupportDir: options.appSupportDir,
    socketPath: options.socketPath,
    commandHandler: options.commandHandler,
    ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
  };
  return new ChromeExtensionBridge(bridgeOptions);
}
