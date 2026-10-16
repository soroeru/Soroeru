// In-page value readers for the saved-page import (Issue #569). Browser-only and
// dependency-free: Playwright serializes them into the page, and the extension's
// saved-page frame calls them in its own realm after `scanInPage` stamps ids.

/** Browser-only: form-field values stamped by `scanInPage`. Runs in the rendered page's realm. */
export function readFieldValues(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const el of Array.from(document.querySelectorAll("[data-af-id]"))) {
    const id = el.getAttribute("data-af-id");
    if (!id || !id.startsWith("f")) continue;
    if (
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement ||
      el instanceof HTMLSelectElement
    ) {
      if (el instanceof HTMLInputElement && (el.type === "radio" || el.type === "checkbox")) {
        if (el.checked) out[id] = el.value;
        continue;
      }
      if (typeof el.value === "string" && el.value !== "") out[id] = el.value;
    }
  }
  return out;
}

/** Browser-only: read-only display values stamped by `scanInPage`. Runs in the rendered page's realm. */
export function readDisplayValues(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const el of Array.from(document.querySelectorAll("[data-af-id]"))) {
    const id = el.getAttribute("data-af-id");
    if (!id || !id.startsWith("d")) continue;
    const value = el instanceof HTMLInputElement ? el.value : (el.textContent ?? "");
    const trimmed = value.trim();
    if (trimmed !== "") out[id] = trimmed;
  }
  return out;
}
