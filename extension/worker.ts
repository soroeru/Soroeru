// Service worker: the lease router between the Side Panel (runtime host) and the content script
// (Issue #558). It owns no page values and persists only lease metadata. The legacy Native
// Messaging bridge lives in legacy-native-bridge.ts and starts only on an explicit popup request.

import {
  EXTENSION_MESSAGE_VERSION,
  PANEL_PORT_NAME,
  isOriginInLeaseScope,
  parseExtensionMessage,
  type ExtensionMessage,
  type LeaseInvalidReason,
  type LeaseOpen,
  type PageCommand,
  type PageCommandMessage,
  type PageRejectedReason,
} from "../src/shared/extension-messages.js";
import { connectLegacyBridge } from "./legacy-native-bridge.js";
import {
  LeaseRegistry,
  staleLeasesFromStorage,
  type Lease,
  type LeaseInvalidation,
} from "./lease-registry.js";

export {
  ExtensionExecutionEpoch,
  isAllowedExtensionOrigin,
  isExpectedNavigationOrigin,
  isSameSiteExtensionOrigin,
  unbindMatchesBinding,
  validateExtensionCommand,
  withPageIdentity,
} from "./legacy-native-bridge.js";
import { withPageIdentity } from "./legacy-native-bridge.js";

const LEASE_STORAGE_KEY = "soroeruLeases";
const NAVIGATION_TIMEOUT_MS = 15_000;

type PanelPort = chrome.runtime.Port;

function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const origin = new URL(url).origin;
    // egress: target-site — validate the selected tab's HTTPS origin; this comparison sends no request.
    return origin.startsWith("https://") ? origin : undefined;
  } catch {
    return undefined;
  }
}

const versioned = <T extends object>(message: T): T & { version: typeof EXTENSION_MESSAGE_VERSION } => ({
  version: EXTENSION_MESSAGE_VERSION,
  ...message,
});

/** Wire the lease router to the chrome.* APIs. Exported so tests can run it against a fake chrome. */
export function startLeaseWorker(): { registry: LeaseRegistry<PanelPort> } {
  const registry = new LeaseRegistry<PanelPort>({ bootId: crypto.randomUUID() });
  const rebinding = new Map<string, Promise<void>>();

  function post(port: PanelPort, message: ExtensionMessage): void {
    try {
      port.postMessage(message);
    } catch {
      // The panel is gone; its disconnect handler invalidates the lease.
    }
  }

  function persist(): void {
    // persist: extension-connection-metadata — lease ids, tab ids, and origins only; never URLs or values
    void chrome.storage.session.set({ [LEASE_STORAGE_KEY]: registry.snapshot() }).catch(() => undefined);
  }

  function drop(invalidations: LeaseInvalidation<PanelPort>[], notifyOwner = true): void {
    for (const { lease, reason } of invalidations) {
      rebinding.delete(lease.leaseId);
      if (notifyOwner)
        post(lease.ownerPort, versioned({ kind: "lease.invalidated", leaseId: lease.leaseId, reason }));
      void chrome.tabs
        .sendMessage(lease.tabId, versioned({ kind: "lease.revoke", leaseId: lease.leaseId }))
        .catch(() => undefined);
      void chrome.action.setBadgeText({ tabId: lease.tabId, text: "" }).catch(() => undefined);
    }
    if (invalidations.length > 0) persist();
  }

  async function permitted(origin: string): Promise<boolean> {
    return chrome.permissions.contains({ origins: [`${origin}/*`] });
  }

  async function bindContentScript(lease: Lease<PanelPort>): Promise<boolean> {
    await chrome.scripting.executeScript({ target: { tabId: lease.tabId }, files: ["content-script.js"] });
    const response = await chrome.tabs.sendMessage<{ ok?: boolean } | undefined>(
      lease.tabId,
      versioned({
        kind: "lease.bind",
        leaseId: lease.leaseId,
        epoch: lease.epoch,
        origin: lease.origin,
        ...(lease.siteDomain === undefined ? {} : { siteDomain: lease.siteDomain }),
      }),
    );
    return response?.ok === true;
  }

  async function openLease(port: PanelPort, request: LeaseOpen): Promise<void> {
    const refuse = (reason: LeaseInvalidReason): void =>
      // No lease exists yet, so the refusal is keyed by the open nonce.
      post(port, versioned({ kind: "lease.invalidated", leaseId: request.nonce, reason }));
    const scope = {
      origin: request.origin,
      ...(request.siteDomain === undefined ? {} : { siteDomain: request.siteDomain }),
    };
    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.get(request.tabId);
    } catch {
      return refuse("tab-closed");
    }
    const tabOrigin = originOf(tab.url);
    if (!tabOrigin || !isOriginInLeaseScope(tabOrigin, scope)) return refuse("navigated-out-of-scope");
    if (!(await permitted(tabOrigin))) return refuse("permission-removed");

    const { lease, superseded } = registry.open({
      tabId: request.tabId,
      origin: request.origin,
      siteDomain: request.siteDomain,
      ownerPort: port,
    });
    drop(superseded);
    let bound = false;
    try {
      bound = await bindContentScript(lease);
    } catch {
      bound = false;
    }
    if (registry.get(lease.leaseId) !== lease) return; // invalidated while binding
    if (!bound) {
      const lost = registry.invalidate(lease.leaseId, "content-script-lost");
      if (lost) drop([lost], false);
      return refuse("content-script-lost");
    }
    void chrome.action.setBadgeText({ tabId: lease.tabId, text: "ON" }).catch(() => undefined);
    persist();
    post(
      port,
      versioned({
        kind: "lease.opened",
        nonce: request.nonce,
        leaseId: lease.leaseId,
        tabId: lease.tabId,
        origin: lease.origin,
        ...(lease.siteDomain === undefined ? {} : { siteDomain: lease.siteDomain }),
        epoch: lease.epoch,
        bootId: lease.bootId,
      }),
    );
  }

  /** Re-inject and rebind after a navigation, bumping the epoch so older commands are stale. */
  function rebind(leaseId: string): Promise<void> {
    const existing = rebinding.get(leaseId);
    if (existing) return existing;
    const task = (async () => {
      const current = registry.bumpEpoch(leaseId);
      if (!current) return;
      let bound = false;
      try {
        bound = await bindContentScript(current);
      } catch {
        bound = false;
      }
      if (registry.get(leaseId) !== current) return;
      if (!bound) {
        drop(registry.invalidateByTab(current.tabId, "content-script-lost"));
        return;
      }
      const tab = await chrome.tabs.get(current.tabId).catch(() => undefined);
      post(
        current.ownerPort,
        versioned({
          kind: "page.event",
          leaseId,
          epoch: current.epoch,
          event: "navigated",
          url: tab?.url ?? "",
        }),
      );
      persist();
    })().finally(() => rebinding.delete(leaseId));
    rebinding.set(leaseId, task);
    return task;
  }

  function waitForNavigation(lease: Lease<PanelPort>): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error("navigation timed out")), NAVIGATION_TIMEOUT_MS);
      const finish = (error?: Error): void => {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        chrome.tabs.onRemoved.removeListener(onRemoved);
        if (error) reject(error);
        else resolve();
      };
      const onUpdated = (tabId: number, changeInfo: { status?: string }, tab: chrome.tabs.Tab): void => {
        if (tabId !== lease.tabId || changeInfo.status !== "complete") return;
        const origin = originOf(tab.url);
        if (origin && isOriginInLeaseScope(origin, lease)) finish();
        else finish(new Error("navigation left the bound origin"));
      };
      const onRemoved = (tabId: number): void => {
        if (tabId === lease.tabId) finish(new Error("bound tab was closed"));
      };
      chrome.tabs.onUpdated.addListener(onUpdated);
      chrome.tabs.onRemoved.addListener(onRemoved);
    });
  }

  function reject(requestId: string, reason: PageRejectedReason): ExtensionMessage {
    return versioned({ kind: "page.rejected", requestId, reason });
  }
  function resultMessage(
    requestId: string,
    ok: boolean,
    payload?: unknown,
    error?: string,
  ): ExtensionMessage {
    return versioned({
      kind: "page.result",
      requestId,
      ok,
      ...(payload === undefined ? {} : { payload }),
      ...(error === undefined ? {} : { error }),
    });
  }

  async function runPageCommand(
    lease: Lease<PanelPort>,
    message: PageCommandMessage,
  ): Promise<ExtensionMessage> {
    const { requestId } = message;
    const stopped = (): boolean => registry.verify(lease.leaseId, message.epoch, lease.ownerPort) !== "ok";
    const tab = await chrome.tabs.get(lease.tabId);
    if (stopped()) return resultMessage(requestId, false, undefined, "execution stopped");
    const pageOrigin = originOf(tab.url);
    if (!pageOrigin || !isOriginInLeaseScope(pageOrigin, lease)) {
      drop(registry.invalidateByTab(lease.tabId, "navigated-out-of-scope"));
      return reject(requestId, "origin-out-of-scope");
    }
    const command: PageCommand = message.command;
    if (command.command === "goto") {
      const target = new URL(command.url).origin;
      if (!isOriginInLeaseScope(target, lease)) return reject(requestId, "origin-out-of-scope");
      if (!(await permitted(target)))
        return resultMessage(requestId, false, undefined, "origin permission required");
      if (stopped()) return resultMessage(requestId, false, undefined, "execution stopped");
      const navigation = waitForNavigation(lease);
      navigation.catch(() => undefined);
      await chrome.tabs.update(lease.tabId, { url: command.url });
      await navigation;
      if (stopped()) return resultMessage(requestId, false, undefined, "execution stopped");
      await rebind(lease.leaseId);
      const landed = await chrome.tabs.get(lease.tabId);
      return resultMessage(requestId, true, { url: landed.url ?? "" });
    }
    if (!(await permitted(pageOrigin)))
      return resultMessage(requestId, false, undefined, "origin permission required");
    if (command.command === "currentUrl") return resultMessage(requestId, true, { url: tab.url ?? "" });
    const raw = await chrome.tabs.sendMessage<unknown>(lease.tabId, message);
    if (stopped()) return resultMessage(requestId, false, undefined, "execution stopped");
    let reply: ExtensionMessage;
    try {
      reply = parseExtensionMessage(raw);
    } catch {
      return resultMessage(requestId, false, undefined, "invalid content script response");
    }
    if (reply.kind === "page.rejected" && reply.requestId === requestId) return reply;
    if (reply.kind !== "page.result" || reply.requestId !== requestId)
      return resultMessage(requestId, false, undefined, "invalid content script response");
    if (!reply.ok) return reply;
    if (command.command === "snapshot" || command.command === "waitForReady") {
      const scanned = await chrome.tabs.get(lease.tabId);
      return resultMessage(requestId, true, withPageIdentity(reply.payload, scanned));
    }
    return reply;
  }

  async function onPanelMessage(port: PanelPort, raw: unknown): Promise<void> {
    let message: ExtensionMessage;
    try {
      message = parseExtensionMessage(raw);
    } catch {
      const requestId = (raw as { requestId?: unknown } | null)?.requestId;
      if (typeof requestId === "string" && requestId.length > 0)
        post(port, reject(requestId, "invalid-command"));
      return;
    }
    switch (message.kind) {
      case "keepalive":
        return; // Receiving the message is what resets the worker idle timer.
      case "lease.open":
        return openLease(port, message);
      case "lease.release": {
        const lease = registry.get(message.leaseId);
        if (lease?.ownerPort === port) drop(registry.invalidateByOwner(port, "released"));
        return;
      }
      case "page.command": {
        const verdict = registry.verify(message.leaseId, message.epoch, port);
        const lease = registry.get(message.leaseId);
        if (verdict !== "ok" || !lease) {
          post(port, reject(message.requestId, verdict === "ok" ? "no-lease" : verdict));
          return;
        }
        let response: ExtensionMessage;
        try {
          response = await runPageCommand(lease, message);
        } catch (error) {
          response = resultMessage(
            message.requestId,
            false,
            undefined,
            error instanceof Error ? error.message : "command failed",
          );
        }
        post(port, response);
        return;
      }
      default:
        return; // Worker-originated kinds are never accepted from the panel.
    }
  }

  chrome.runtime.onConnect.addListener((port) => {
    const sender = port.sender;
    const trusted =
      port.name === PANEL_PORT_NAME &&
      sender?.id === chrome.runtime.id &&
      sender.tab === undefined &&
      sender.url === chrome.runtime.getURL("sidepanel.html");
    if (!trusted) {
      port.disconnect();
      return;
    }
    port.onMessage.addListener((raw) => {
      void onPanelMessage(port, raw);
    });
    port.onDisconnect.addListener(() => {
      drop(registry.invalidateByOwner(port, "panel-closed"), false);
    });
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    drop(registry.invalidateByTab(tabId, "tab-closed"));
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    const lease = registry.byTab(tabId);
    if (!lease || (changeInfo.status !== "complete" && changeInfo.url === undefined)) return;
    const origin = originOf(changeInfo.url ?? tab.url);
    if (!origin || !isOriginInLeaseScope(origin, lease)) {
      drop(registry.invalidateByTab(tabId, "navigated-out-of-scope"));
      return;
    }
    if (changeInfo.status === "complete") void rebind(lease.leaseId);
  });

  chrome.permissions.onRemoved.addListener((permissions) => {
    for (const pattern of permissions.origins ?? []) {
      // egress: target-site — recognize revoked host permission patterns to invalidate leases; no request is sent.
      if (pattern === "https://*/*" || pattern === "<all_urls>") {
        drop(registry.list().flatMap((lease) => registry.invalidateByTab(lease.tabId, "permission-removed")));
        continue;
      }
      drop(registry.invalidateByPermissionOrigin(pattern.replace(/\/\*$/, "")));
    }
  });

  // Leases from an earlier worker boot lost their panel port; revoke them in their tabs.
  void chrome.storage.session
    .get(LEASE_STORAGE_KEY)
    .then((stored) => {
      for (const stale of staleLeasesFromStorage(stored[LEASE_STORAGE_KEY], registry.bootId)) {
        void chrome.tabs
          .sendMessage(stale.tabId, versioned({ kind: "lease.revoke", leaseId: stale.leaseId }))
          .catch(() => undefined);
      }
      persist();
    })
    .catch(() => undefined);

  // The popup (not startup) is the only way to start the legacy Native Messaging bridge.
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const msg = message as { command?: string } | undefined;
    if (msg?.command !== "reconnect") return;
    if (sender.id !== chrome.runtime.id || sender.tab !== undefined) {
      sendResponse({ ok: false, error: "untrusted sender" });
      return;
    }
    sendResponse(connectLegacyBridge());
    return true;
  });

  return { registry };
}

if (typeof chrome !== "undefined" && typeof chrome.runtime?.onConnect !== "undefined") startLeaseWorker();
