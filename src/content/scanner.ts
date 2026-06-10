// Scope (v0.1): same-origin iframes and shadow DOM are NOT traversed.
// See docs/extension.md §3.

import type { ScannedField } from "../shared/types.js";

const SUPPORTED_INPUT_TYPES = new Set([
  "text",
  "email",
  "tel",
  "url",
  "search",
  "number",
  "date",
  "datetime-local",
  "month",
  "time",
  "week",
]);

export function scanFields(root: Document): ScannedField[] {
  const view = root.defaultView;
  if (!view) return [];

  const { HTMLInputElement, HTMLTextAreaElement, HTMLSelectElement } = view;

  const elements = Array.from(root.querySelectorAll("input, textarea, select"));
  const results: ScannedField[] = [];
  const ctx = buildScanContext();

  for (const el of elements) {
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) {
      continue;
    }
    if (el instanceof HTMLInputElement && !SUPPORTED_INPUT_TYPES.has(el.type)) {
      continue;
    }
    if (el.disabled) continue;
    if ("readOnly" in el && el.readOnly) continue;
    if (!isVisible(el)) continue;

    const fieldId = ctx.idFor(el);
    const value = el.value;
    const labelCandidates = collectLabelCandidates(el);

    if (el instanceof HTMLInputElement) {
      results.push({ fieldId, tag: "input", type: el.type, value, visible: true, labelCandidates });
    } else if (el instanceof HTMLTextAreaElement) {
      results.push({ fieldId, tag: "textarea", value, visible: true, labelCandidates });
    } else {
      results.push({ fieldId, tag: "select", value, visible: true, labelCandidates });
    }
  }
  return results;
}

interface ScanContext {
  idFor(el: Element): string;
}

function buildScanContext(): ScanContext {
  const ids = new WeakMap<Element, string>();
  let counter = 0;
  return {
    idFor(el: Element): string {
      const existing = ids.get(el);
      if (existing) return existing;
      const fresh = `ff-${++counter}`;
      ids.set(el, fresh);
      return fresh;
    },
  };
}

function collectLabelCandidates(el: HTMLElement): string[] {
  const out: string[] = [];

  if ("labels" in el) {
    const labels = (el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).labels;
    if (labels) {
      for (const label of Array.from(labels)) {
        const text = label.textContent?.trim();
        if (text) out.push(text);
      }
    }
  }

  const ariaLabel = el.getAttribute("aria-label")?.trim();
  if (ariaLabel) out.push(ariaLabel);

  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    for (const id of labelledBy.split(/\s+/)) {
      if (!id) continue;
      const ref = el.ownerDocument.getElementById(id);
      const text = ref?.textContent?.trim();
      if (text) out.push(text);
    }
  }

  if ("placeholder" in el) {
    const placeholder = (el as HTMLInputElement | HTMLTextAreaElement).placeholder?.trim();
    if (placeholder) out.push(placeholder);
  }

  return out;
}

function isVisible(el: HTMLElement): boolean {
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  if (!style) return true;
  if (style.display === "none") return false;
  if (style.visibility === "hidden") return false;
  return true;
}
