import { scanInPage } from "../src/agent/scan.js";

/** The exact in-page scanner used by the Playwright path. */
export const scanPage = scanInPage;

type ContentCommand =
  | { command: "snapshot" }
  | { command: "readValues"; fieldIds?: string[] }
  | { command: "readDisplayValues"; valueIds?: string[] }
  | { command: "fill"; fieldId: string; value: string }
  | { command: "click"; selector: string }
  | { command: "waitForReady" };

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
      if (
        !(
          element instanceof HTMLInputElement ||
          element instanceof HTMLTextAreaElement ||
          element instanceof HTMLSelectElement
        )
      ) {
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

if (
  typeof chrome !== "undefined" &&
  !(globalThis as { __soroeruContentScriptInstalled?: boolean }).__soroeruContentScriptInstalled
) {
  (globalThis as { __soroeruContentScriptInstalled?: boolean }).__soroeruContentScriptInstalled = true;
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    void execute(message as ContentCommand)
      .then((payload) => sendResponse({ ok: true, payload }))
      .catch((error: unknown) =>
        sendResponse({ ok: false, error: error instanceof Error ? error.message : "command failed" }),
      );
    return true;
  });
}
