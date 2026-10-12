import { schemaPageFingerprint, readSchemaPage, structurePageSnapshot } from "./schema-page.js";
import type { FormSchema } from "../src/shared/cloud-contract.js";
import {
  collectionObservationInPage,
  structuralFingerprintInPage,
  type ObservationToken,
} from "../src/automation/collection-observation.js";
import { scanInPage } from "../src/agent/scan.js";
import {
  EXTENSION_MESSAGE_VERSION,
  isOriginInLeaseScope,
  parseExtensionMessage,
  type PageCommand,
  type PageRejectedReason,
} from "../src/shared/extension-messages.js";

/** The exact in-page scanner used by the Playwright path. */
export const scanPage = scanInPage;

type ContentCommand =
  | { command: "captureCollectionObservation"; bindingEpoch: number }
  | { command: "checkCollectionObservation"; token: ObservationToken }
  | { command: "snapshot" }
  | { command: "schemaFingerprint" }
  | { command: "structureSnapshot"; site: string }
  | { command: "readSchema"; schema: FormSchema }
  | { command: "readValues"; fieldIds?: string[] }
  | { command: "readDisplayValues"; valueIds?: string[] }
  | { command: "fill"; fieldId: string; value: string }
  | { command: "click"; selector: string }
  | { command: "waitForReady" }
  | { command: "stop" };

const BANNER_ID = "soroeru-extension-automation-banner";

function showAutomationBanner(): void {
  let banner = document.getElementById(BANNER_ID);
  if (!banner) {
    banner = document.createElement("div");
    banner.id = BANNER_ID;
    banner.textContent = "Soroeruがこのタブを操作中";
    Object.assign(banner.style, {
      position: "fixed",
      top: "0",
      right: "0",
      zIndex: "2147483647",
      padding: "8px 12px",
      color: "#fff",
      background: "#7c2d12",
      font: "600 13px sans-serif",
      borderRadius: "0 0 0 6px",
    });
    document.documentElement.appendChild(banner);
  }
}

export function hideAutomationBanner(): void {
  document.getElementById("soroeru-extension-automation-banner")?.remove();
}

function elementForField(fieldId: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-af-id="${CSS.escape(fieldId)}"]`);
  if (!element) throw new Error("field not found");
  return element;
}

/** Read form values with the same selected-choice and empty-value semantics as PlaywrightPageDriver. */
export function readPageValues(fieldIds?: string[]): Record<string, string> {
  const ids =
    fieldIds ??
    Array.from(document.querySelectorAll<HTMLElement>("[data-af-id]"))
      .map((element) => element.dataset.afId)
      .filter((id): id is string => Boolean(id));
  const values: Record<string, string> = {};
  for (const fieldId of ids) {
    if (!fieldId.startsWith("f")) continue;
    const element = document.querySelector<HTMLElement>(`[data-af-id="${CSS.escape(fieldId)}"]`);
    if (!element) throw new Error("field not found");
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
    ) {
      if (element instanceof HTMLInputElement && (element.type === "radio" || element.type === "checkbox")) {
        if (element.checked) values[fieldId] = element.value;
        continue;
      }
      if (element.value !== "") values[fieldId] = element.value;
    }
  }
  return values;
}

function readDisplayValues(valueIds?: string[]): Record<string, string> {
  const ids =
    valueIds ??
    Array.from(document.querySelectorAll<HTMLElement>("[data-af-id^='d-']"))
      .map((element) => element.dataset.afId)
      .filter((id): id is string => Boolean(id));
  const values: Record<string, string> = {};
  for (const valueId of ids) values[valueId] = elementForField(valueId).textContent?.trim() ?? "";
  return values;
}

async function waitForReady(): Promise<ReturnType<typeof scanPage>> {
  let snapshot = scanPage();
  const deadline = Date.now() + 5000;
  while (
    snapshot.fields.length === 0 &&
    (snapshot.displayValues?.length ?? 0) === 0 &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    snapshot = scanPage();
  }
  return snapshot;
}

async function execute(command: ContentCommand): Promise<unknown> {
  showAutomationBanner();
  switch (command.command) {
    case "captureCollectionObservation":
      return collectionObservationInPage(
        scanPage,
        { kind: "capture", bindingEpoch: command.bindingEpoch },
        structuralFingerprintInPage,
      );
    case "checkCollectionObservation":
      return collectionObservationInPage(scanPage, { kind: "check", token: command.token });
    case "stop":
      hideAutomationBanner();
      return { ok: true };
    case "schemaFingerprint": return schemaPageFingerprint();
    case "structureSnapshot": return structurePageSnapshot(command.site);
    case "readSchema": return readSchemaPage(command.schema);
    case "snapshot":
      return scanPage();
    case "readValues":
      return readPageValues(command.fieldIds);
    case "readDisplayValues":
      return readDisplayValues(command.valueIds);
    case "waitForReady":
      return waitForReady();
    case "fill": {
      const element = elementForField(command.fieldId);
      if (!(
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement
      )) {
        throw new Error("field is not fillable");
      }
      element.value = command.value;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true };
    }
    case "click": {
      const element = document.querySelector<HTMLElement>(command.selector);
      if (!element) throw new Error("click target not found");
      element.click();
      return { ok: true };
    }
  }
}

interface ActiveLease {
  leaseId: string;
  epoch: number;
  origin: string;
  siteDomain?: string;
}

/** The single lease this page accepts commands for; set only by a worker `lease.bind`. */
let activeLease: ActiveLease | undefined;

/** Map a validated lease-protocol page command onto the unchanged DOM operations. */
function toContentCommand(command: PageCommand): ContentCommand | undefined {
  switch (command.command) {
    case "goto":
    case "currentUrl":
      return undefined; // Tab-level commands are handled by the worker, never in the page.
    case "fillField":
      return { command: "fill", fieldId: command.fieldId, value: command.value };
    case "readValues":
      return {
        command: "readValues",
        ...(command.fieldIds === undefined ? {} : { fieldIds: command.fieldIds }),
      };
    case "readDisplayValues":
      return {
        command: "readDisplayValues",
        ...(command.valueIds === undefined ? {} : { valueIds: command.valueIds }),
      };
    default:
      return command;
  }
}

function rejected(requestId: string, reason: PageRejectedReason): unknown {
  return { version: EXTENSION_MESSAGE_VERSION, kind: "page.rejected", requestId, reason };
}

function requestIdOf(raw: unknown): string {
  const id = (raw as { requestId?: unknown } | null)?.requestId;
  return typeof id === "string" && id.length > 0 ? id : "unknown";
}

/**
 * Handle one runtime message. Resolves with the response to send. Only the extension itself
 * (worker bindings and direct Side Panel commands; no sender.tab) may bind, revoke, or command; everything else is rejected.
 */
export async function handleExtensionMessage(
  raw: unknown,
  sender: { id?: string; tab?: unknown },
  extensionId: string | undefined,
): Promise<unknown> {
  if (extensionId === undefined || sender.id !== extensionId || sender.tab !== undefined)
    return rejected(requestIdOf(raw), "untrusted-sender");
  let message;
  try {
    message = parseExtensionMessage(raw);
  } catch {
    return rejected(requestIdOf(raw), "invalid-command");
  }
  switch (message.kind) {
    case "lease.bind": {
      if (!isOriginInLeaseScope(location.origin, message)) return { ok: false, error: "origin-out-of-scope" };
      activeLease = {
        leaseId: message.leaseId,
        epoch: message.epoch,
        origin: message.origin,
        ...(message.siteDomain === undefined ? {} : { siteDomain: message.siteDomain }),
      };
      showAutomationBanner();
      return { ok: true };
    }
    case "lease.revoke": {
      if (activeLease?.leaseId === message.leaseId) {
        activeLease = undefined;
        hideAutomationBanner();
      }
      return { ok: true };
    }
    case "page.command": {
      if (!activeLease) return rejected(message.requestId, "no-lease");
      if (activeLease.leaseId !== message.leaseId) return rejected(message.requestId, "lease-mismatch");
      if (activeLease.epoch !== message.epoch) return rejected(message.requestId, "stale-epoch");
      if (!isOriginInLeaseScope(location.origin, activeLease))
        return rejected(message.requestId, "origin-out-of-scope");
      const content = toContentCommand(message.command);
      if (!content) return rejected(message.requestId, "invalid-command");
      try {
        const payload = await execute(content);
        return {
          version: EXTENSION_MESSAGE_VERSION,
          kind: "page.result",
          requestId: message.requestId,
          ok: true,
          payload,
        };
      } catch (error) {
        return {
          version: EXTENSION_MESSAGE_VERSION,
          kind: "page.result",
          requestId: message.requestId,
          ok: false,
          error: error instanceof Error ? error.message : "command failed",
        };
      }
    }
    default:
      return rejected(requestIdOf(raw), "invalid-command");
  }
}

if (
  typeof chrome !== "undefined" &&
  !(globalThis as { __soroeruContentScriptInstalled?: boolean }).__soroeruContentScriptInstalled
) {
  (globalThis as { __soroeruContentScriptInstalled?: boolean }).__soroeruContentScriptInstalled = true;
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    void handleExtensionMessage(message, sender, chrome.runtime.id).then(sendResponse);
    return true;
  });
}
