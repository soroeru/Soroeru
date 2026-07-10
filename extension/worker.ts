import {
  CHROME_BRIDGE_PROTOCOL_VERSION,
  parseChromeBridgeMessage,
  type ChromeBridgeCommand,
  type ChromeBridgeResult,
} from "../src/shared/chrome-bridge.js";

export const EXTENSION_COMMANDS = [
  "goto",
  "currentUrl",
  "snapshot",
  "readValues",
  "readDisplayValues",
  "fillField",
  "click",
  "waitForReady",
] as const;
type ExtensionCommandName = (typeof EXTENSION_COMMANDS)[number];

interface CommandPayload {
  tabId: number;
  url?: string;
  fieldId?: string;
  value?: string;
  selector?: string;
  fieldIds?: string[];
  valueIds?: string[];
}

export function isAllowedExtensionOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.pathname === "/" && url.search === "" && url.hash === "";
  } catch {
    return false;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateExtensionCommand(command: string, payload: unknown): CommandPayload {
  if (!EXTENSION_COMMANDS.includes(command as ExtensionCommandName)) throw new Error("unknown command");
  if (!record(payload)) throw new Error("command payload must be an object");
  const allowed = new Set(["tabId"]);
  if (command === "goto") allowed.add("url");
  if (command === "fillField") allowed.add("fieldId").add("value");
  if (command === "click") allowed.add("selector");
  if (command === "readValues") allowed.add("fieldIds");
  if (command === "readDisplayValues") allowed.add("valueIds");
  const unknown = Object.keys(payload).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`unknown payload field: ${unknown}`);
  if (typeof payload.tabId !== "number" || !Number.isInteger(payload.tabId) || payload.tabId < 1)
    throw new Error("tabId must be a positive integer");
  if (
    command === "goto" &&
    (typeof payload.url !== "string" || !isAllowedExtensionOrigin(new URL(payload.url).origin))
  )
    throw new Error("goto URL must be HTTPS");
  for (const key of ["fieldId", "value", "selector"] as const) {
    if (Object.hasOwn(payload, key) && typeof payload[key] !== "string")
      throw new Error(`${key} must be a string`);
  }
  for (const key of ["fieldIds", "valueIds"] as const) {
    if (
      Object.hasOwn(payload, key) &&
      (!Array.isArray(payload[key]) || payload[key].some((value) => typeof value !== "string"))
    )
      throw new Error(`${key} must be a string array`);
  }
  if (command === "fillField" && (payload.fieldId === undefined || payload.value === undefined))
    throw new Error("fillField requires fieldId and value");
  if (command === "click" && payload.selector === undefined) throw new Error("click requires selector");
  return payload as unknown as CommandPayload;
}

interface Binding {
  tabId: number;
  origin: string;
}
let nativePort: chrome.runtime.Port | undefined;
let binding: Binding | undefined;
const closedTabs = new Set<number>();

function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const origin = new URL(url).origin;
    return isAllowedExtensionOrigin(origin) ? origin : undefined;
  } catch {
    return undefined;
  }
}

async function permissionFor(origin: string): Promise<boolean> {
  return chrome.permissions.contains({ origins: [`${origin}/*`] });
}

async function ensureContentScript(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content-script.js"] });
}

function waitForNavigation(tabId: number, expectedOrigin: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error("navigation timed out")), 15000);
    const finish = (error?: Error): void => {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      if (error) reject(error);
      else resolve();
    };
    const onUpdated = (updatedTabId: number, changeInfo: { status?: string }, tab: chrome.tabs.Tab): void => {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") return;
      if (originOf(tab.url) !== expectedOrigin) finish(new Error("navigation left the bound origin"));
      else finish();
    };
    const onRemoved = (removedTabId: number): void => {
      if (removedTabId === tabId) {
        closedTabs.add(tabId);
        finish(new Error("bound tab was closed"));
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
  });
}

function result(
  command: ChromeBridgeCommand,
  ok: boolean,
  payload?: unknown,
  error?: string,
): ChromeBridgeResult {
  return {
    version: CHROME_BRIDGE_PROTOCOL_VERSION,
    kind: "result",
    requestId: command.requestId,
    ok,
    ...(payload === undefined ? {} : { payload }),
    ...(error === undefined ? {} : { error }),
  };
}

async function executeCommand(command: ChromeBridgeCommand): Promise<ChromeBridgeResult> {
  let payload: CommandPayload;
  try {
    payload = validateExtensionCommand(command.command, command.payload);
  } catch (error) {
    return result(command, false, undefined, error instanceof Error ? error.message : "invalid command");
  }
  const tab = await chrome.tabs.get(payload.tabId);
  if (closedTabs.has(payload.tabId))
    return result(command, false, undefined, "bound tab was closed; select a new tab");
  const currentOrigin = originOf(tab.url);
  if (!currentOrigin) return result(command, false, undefined, "tab must be on an HTTPS origin");
  if (command.command === "goto") {
    const targetOrigin = new URL(payload.url as string).origin;
    if (!(await permissionFor(targetOrigin)))
      return result(command, false, undefined, "origin permission required");
    if (binding && (binding.tabId !== payload.tabId || binding.origin !== targetOrigin))
      return result(command, false, undefined, "tab binding mismatch");
    binding ??= { tabId: payload.tabId, origin: targetOrigin };
    const navigation = waitForNavigation(payload.tabId, targetOrigin);
    await chrome.tabs.update(payload.tabId, { url: payload.url as string });
    await navigation;
    await ensureContentScript(payload.tabId);
    return result(command, true, { url: payload.url });
  }
  if (!(await permissionFor(currentOrigin)))
    return result(command, false, undefined, "origin permission required");
  if (binding && (binding.tabId !== payload.tabId || binding.origin !== currentOrigin))
    return result(command, false, undefined, "tab binding mismatch");
  binding ??= { tabId: payload.tabId, origin: currentOrigin };
  if (command.command === "currentUrl") return result(command, true, { url: tab.url ?? "" });
  await ensureContentScript(payload.tabId);
  const contentCommand =
    command.command === "fillField"
      ? { command: "fill", fieldId: payload.fieldId, value: payload.value }
      : command.command === "click"
        ? { command: "click", selector: payload.selector }
        : { command: command.command, fieldIds: payload.fieldIds, valueIds: payload.valueIds };
  const response = await chrome.tabs.sendMessage<{ ok: boolean; payload?: unknown; error?: string }>(
    payload.tabId,
    contentCommand,
  );
  return response.ok
    ? result(command, true, response.payload)
    : result(command, false, undefined, response.error ?? "content command failed");
}

function connect(): void {
  nativePort = chrome.runtime.connectNative("jp.soroeru.bridge");
  void chrome.storage.local.set({ chromeBridgeConnected: true });
  void chrome.action.setBadgeText({ text: "ON" });
  void chrome.action.setBadgeBackgroundColor({ color: "#7c2d12" });
  nativePort.onMessage.addListener((raw) => {
    try {
      const message = parseChromeBridgeMessage(raw);
      if (message.kind === "command") {
        void executeCommand(message)
          .catch((error: unknown) =>
            result(message, false, undefined, error instanceof Error ? error.message : "command failed"),
          )
          .then((response) => nativePort?.postMessage(response));
      }
    } catch {
      nativePort?.postMessage({
        version: CHROME_BRIDGE_PROTOCOL_VERSION,
        kind: "error",
        code: "invalid-message",
        message: "invalid bridge message",
      });
    }
  });
  nativePort.onDisconnect.addListener(() => {
    nativePort = undefined;
    binding = undefined;
    void chrome.storage.local.set({ chromeBridgeConnected: false });
    void chrome.action.setBadgeText({ text: "" });
  });
}

if (typeof chrome !== "undefined") {
  chrome.tabs.onRemoved.addListener((tabId) => {
    if (binding?.tabId === tabId) {
      closedTabs.add(tabId);
      void chrome.action.setBadgeText({ tabId, text: "" });
    }
  });
  connect();
}
