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
  "unbind",
  "listPermissions",
  "removePermission",
  "activeTab",
  "stop",
] as const;
type ExtensionCommandName = (typeof EXTENSION_COMMANDS)[number];

interface CommandPayload {
  tabId?: number;
  url?: string;
  fieldId?: string;
  value?: string;
  selector?: string;
  fieldIds?: string[];
  valueIds?: string[];
  siteDomain?: string;
  origin?: string;
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
  const controlCommand = ["listPermissions", "activeTab", "stop"].includes(command);
  if (controlCommand && payload === undefined) return {};
  if (!record(payload)) throw new Error("command payload must be an object");
  const allowed = new Set(controlCommand ? [] : ["tabId"]);
  if (command === "removePermission") allowed.add("origin");
  if (command === "goto" || command === "unbind") allowed.add("siteDomain");
  if (command === "goto") allowed.add("url");
  if (command === "fillField") allowed.add("fieldId").add("value");
  if (command === "click") allowed.add("selector");
  if (command === "readValues") allowed.add("fieldIds");
  if (command === "readDisplayValues") allowed.add("valueIds");
  const unknown = Object.keys(payload).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`unknown payload field: ${unknown}`);
  if (
    !controlCommand &&
    command !== "removePermission" &&
    (typeof payload.tabId !== "number" || !Number.isInteger(payload.tabId) || payload.tabId < 1)
  )
    throw new Error("tabId must be a positive integer");
  if (
    command === "removePermission" &&
    (typeof payload.origin !== "string" || !isAllowedExtensionOrigin(payload.origin))
  )
    throw new Error("origin must be HTTPS");
  if (
    command === "goto" &&
    (typeof payload.url !== "string" || !isAllowedExtensionOrigin(new URL(payload.url).origin))
  )
    throw new Error("goto URL must be HTTPS");
  for (const key of ["fieldId", "value", "selector"] as const) {
    if (Object.hasOwn(payload, key) && typeof payload[key] !== "string")
      throw new Error(`${key} must be a string`);
  }
  if (Object.hasOwn(payload, "siteDomain") && typeof payload.siteDomain !== "string") {
    throw new Error("siteDomain must be a string");
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
  siteDomain?: string;
}
let nativePort: chrome.runtime.Port | undefined;
let binding: Binding | undefined;
const closedTabs = new Set<number>();
export class ExtensionExecutionEpoch {
  private generation = 0;

  current(): number {
    return this.generation;
  }

  stop(): number {
    this.generation += 1;
    return this.generation;
  }

  isCurrent(commandGeneration: number): boolean {
    return commandGeneration === this.generation;
  }
}
const executionEpoch = new ExtensionExecutionEpoch();

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

/** Match PageExplorer's site boundary: a domain and its subdomains, never a sibling domain. */
export function isSameSiteExtensionOrigin(origin: string, siteDomain: string): boolean {
  try {
    const host = new URL(origin).hostname.toLowerCase().replace(/^www\./, "");
    return host === siteDomain || host.endsWith(`.${siteDomain}`);
  } catch {
    return false;
  }
}

/** A goto may land on its exact target origin, or on any same-site origin when the tab is site-scoped. */
export function isExpectedNavigationOrigin(
  url: string | undefined,
  expectedOrigin: string,
  siteDomain?: string,
): boolean {
  const origin = originOf(url);
  if (!origin) return false;
  return (
    origin === expectedOrigin || (siteDomain !== undefined && isSameSiteExtensionOrigin(origin, siteDomain))
  );
}

/** unbind needs no live tab: match the bound tabId and, when the binding is site-scoped, the same siteDomain. */
export function unbindMatchesBinding(
  binding: { tabId: number; siteDomain?: string } | undefined,
  request: { tabId: number; siteDomain?: string },
): boolean {
  if (!binding || binding.tabId !== request.tabId) return false;
  return binding.siteDomain === undefined || binding.siteDomain === request.siteDomain;
}

async function ensureContentScript(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content-script.js"] });
}

function waitForNavigation(tabId: number, expectedOrigin: string, siteDomain?: string): Promise<void> {
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
      if (!isExpectedNavigationOrigin(tab.url, expectedOrigin, siteDomain))
        finish(new Error("navigation left the bound origin"));
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

async function executeCommand(
  command: ChromeBridgeCommand,
  commandGeneration = executionEpoch.current(),
): Promise<ChromeBridgeResult> {
  let payload: CommandPayload;
  try {
    payload = validateExtensionCommand(command.command, command.payload);
  } catch (error) {
    return result(command, false, undefined, error instanceof Error ? error.message : "invalid command");
  }
  if (command.command === "listPermissions") {
    const permissions = await chrome.permissions.getAll();
    return result(command, true, { origins: permissions.origins ?? [] });
  }
  if (command.command === "removePermission") {
    const removed = await chrome.permissions.remove({ origins: [`${payload.origin}/*`] });
    return result(command, true, { removed });
  }
  if (command.command === "activeTab") {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const origin = originOf(tab?.url);
    if (!tab?.id || !origin) return result(command, false, undefined, "active tab must be HTTPS");
    return result(command, true, { tabId: tab.id, origin });
  }
  if (command.command === "stop") {
    const tabId = binding?.tabId;
    binding = undefined;
    if (tabId) {
      await chrome.tabs.sendMessage(tabId, { command: "stop" }).catch(() => undefined);
      await chrome.action.setBadgeText({ tabId, text: "" });
    }
    return result(command, true);
  }
  if (!executionEpoch.isCurrent(commandGeneration))
    return result(command, false, undefined, "execution stopped");
  if (command.command === "unbind") {
    // Must stay ahead of the live-tab checks: unbind is the release path when the bound tab is gone.
    if (
      !unbindMatchesBinding(binding, {
        tabId: payload.tabId as number,
        ...(payload.siteDomain === undefined ? {} : { siteDomain: payload.siteDomain }),
      })
    )
      return result(command, false, undefined, "tab binding mismatch");
    binding = undefined;
    return result(command, true);
  }
  const tabId = payload.tabId as number;
  const tab = await chrome.tabs.get(tabId);
  if (!executionEpoch.isCurrent(commandGeneration))
    return result(command, false, undefined, "execution stopped");
  if (closedTabs.has(tabId))
    return result(command, false, undefined, "bound tab was closed; select a new tab");
  const currentOrigin = originOf(tab.url);
  if (!currentOrigin) return result(command, false, undefined, "tab must be on an HTTPS origin");
  if (command.command === "goto") {
    const targetOrigin = new URL(payload.url as string).origin;
    if (!(await permissionFor(targetOrigin)))
      return result(command, false, undefined, "origin permission required");
    if (!executionEpoch.isCurrent(commandGeneration))
      return result(command, false, undefined, "execution stopped");
    if (
      binding &&
      (binding.tabId !== tabId ||
        binding.siteDomain !== payload.siteDomain ||
        (binding.siteDomain
          ? !isSameSiteExtensionOrigin(targetOrigin, binding.siteDomain)
          : binding.origin !== targetOrigin))
    )
      return result(command, false, undefined, "tab binding mismatch");
    if (payload.siteDomain && !isSameSiteExtensionOrigin(targetOrigin, payload.siteDomain))
      return result(command, false, undefined, "goto URL outside the site domain");
    binding ??= {
      tabId,
      origin: targetOrigin,
      ...(payload.siteDomain === undefined ? {} : { siteDomain: payload.siteDomain }),
    };
    const navigation = waitForNavigation(tabId, targetOrigin, payload.siteDomain);
    await chrome.tabs.update(tabId, { url: payload.url as string });
    await navigation;
    if (!executionEpoch.isCurrent(commandGeneration))
      return result(command, false, undefined, "execution stopped");
    await ensureContentScript(tabId);
    // Report the post-navigation tab URL so same-site redirects update the driver cache
    // (request URL alone would leave currentUrl stale until waitForReady/snapshot).
    const landed = await chrome.tabs.get(tabId);
    return result(command, true, { url: landed.url ?? "" });
  }
  if (!(await permissionFor(currentOrigin)))
    return result(command, false, undefined, "origin permission required");
  if (!executionEpoch.isCurrent(commandGeneration))
    return result(command, false, undefined, "execution stopped");
  if (
    binding &&
    (binding.tabId !== tabId ||
      (binding.siteDomain
        ? !isSameSiteExtensionOrigin(currentOrigin, binding.siteDomain)
        : binding.origin !== currentOrigin))
  )
    return result(command, false, undefined, "tab binding mismatch");
  binding ??= { tabId, origin: currentOrigin };
  if (command.command === "currentUrl") return result(command, true, { url: tab.url ?? "" });
  await ensureContentScript(tabId);
  if (!executionEpoch.isCurrent(commandGeneration))
    return result(command, false, undefined, "execution stopped");
  const contentCommand =
    command.command === "fillField"
      ? { command: "fill", fieldId: payload.fieldId, value: payload.value }
      : command.command === "click"
        ? { command: "click", selector: payload.selector }
        : { command: command.command, fieldIds: payload.fieldIds, valueIds: payload.valueIds };
  const response = await chrome.tabs.sendMessage<{ ok: boolean; payload?: unknown; error?: string }>(
    tabId,
    contentCommand,
  );
  if (!response.ok) return result(command, false, undefined, response.error ?? "content command failed");
  if (command.command === "snapshot" || command.command === "waitForReady") {
    // PageSnapshot requires the page URL and title, which the content script's
    // scan result does not carry; attach the bound tab's actual values here,
    // re-read after the scan so redirects during the command are reflected.
    const scanned = await chrome.tabs.get(tabId);
    return result(command, true, withPageIdentity(response.payload, scanned));
  }
  return result(command, true, response.payload);
}

/**
 * Attach the bound tab's URL/title to a content-script scan payload so it
 * satisfies the PageSnapshot shape the ExtensionPageDriver validates
 * (Issue #360: the scan result itself is structure-only and has neither).
 * The tab's values are authoritative and overwrite any payload keys.
 */
export function withPageIdentity(
  payload: unknown,
  tab: { url?: string; title?: string },
): Record<string, unknown> {
  const base = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  return { ...base, url: tab.url ?? "", title: tab.title ?? "" };
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
        if (message.command === "stop") executionEpoch.stop();
        const commandGeneration = executionEpoch.current();
        void executeCommand(message, commandGeneration)
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
