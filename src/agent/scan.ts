// In-page form scanner. Reuses the approach of the #9 scanner (src/content/scanner.ts:
// visible input/textarea/select + label candidates) and extends it for the agent PoC:
// name/id/autocomplete capture, nearby-text for label-less layouts, radio grouping,
// checkbox/password support, buttons, links, and wall markers.
// The snapshot is structure-only: element *values* are never collected, so it is safe
// to hand to the AI mapper (RFC-001 v3 §6 minimal disclosure).

import type { Page } from "playwright";
import type { PageSnapshot } from "../types.js";

type RawSnapshot = Omit<PageSnapshot, "url" | "title">;

export async function snapshotPage(page: Page): Promise<PageSnapshot> {
  const raw = await page.evaluate(scanInPage);
  return { ...raw, url: page.url(), title: await page.title() };
}

/** Poll until the page exposes at least one form field or the timeout elapses (dynamic rendering). */
export async function waitForFields(page: Page, timeoutMs = 5000): Promise<PageSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let snapshot = await snapshotPage(page);
  while (snapshot.fields.length === 0 && Date.now() < deadline) {
    await page.waitForTimeout(150);
    snapshot = await snapshotPage(page);
  }
  return snapshot;
}

function scanInPage(): {
  fields: PageSnapshot["fields"];
  buttons: PageSnapshot["buttons"];
  links: PageSnapshot["links"];
  visibleText: string;
  iframeSrcs: string[];
  wallMarkers: string[];
} {
  const SUPPORTED_TYPES = new Set([
    "text", "email", "tel", "url", "search", "number", "password",
    "date", "datetime-local", "month", "time", "week", "radio", "checkbox",
  ]);

  let counter = 0;
  const stamp = (el: Element, prefix: string): string => {
    const existing = el.getAttribute("data-af-id");
    if (existing) return existing;
    const id = `${prefix}-${++counter}`;
    el.setAttribute("data-af-id", id);
    return id;
  };

  const isVisible = (el: HTMLElement): boolean => {
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    return el.getClientRects().length > 0;
  };

  const labelTextsFor = (el: HTMLElement): string[] => {
    const out: string[] = [];
    const labels = (el as HTMLInputElement).labels;
    if (labels) {
      for (const label of Array.from(labels)) {
        const text = label.textContent?.trim();
        if (text) out.push(text);
      }
    }
    const aria = el.getAttribute("aria-label")?.trim();
    if (aria) out.push(aria);
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      for (const id of labelledBy.split(/\s+/)) {
        const text = id ? document.getElementById(id)?.textContent?.trim() : undefined;
        if (text) out.push(text);
      }
    }
    return out;
  };

  // Nearby text for label-less layouts: same-row <th>, <dt> of a <dl>, or the
  // text of the previous sibling element.
  const nearbyTextFor = (el: HTMLElement): string => {
    const tr = el.closest("tr");
    const th = tr?.querySelector("th");
    if (th?.textContent?.trim()) return th.textContent.trim();
    const dd = el.closest("dd");
    const dt = dd?.previousElementSibling;
    if (dt?.tagName === "DT" && dt.textContent?.trim()) return dt.textContent.trim();
    const container = el.closest("div, p, li") ?? el;
    const prev = container.previousElementSibling;
    if (prev && prev.querySelector("input, select, textarea") === null) {
      const text = prev.textContent?.trim() ?? "";
      if (text && text.length <= 60) return text;
    }
    return "";
  };

  const fields: PageSnapshot["fields"] = [];
  const radioGroups = new Map<string, PageSnapshot["fields"][number]>();

  for (const el of Array.from(document.querySelectorAll("input, textarea, select"))) {
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) {
      continue;
    }
    if (el instanceof HTMLInputElement && !SUPPORTED_TYPES.has(el.type)) continue;
    if (el.disabled || ("readOnly" in el && el.readOnly)) continue;
    if (!isVisible(el)) continue;

    if (el instanceof HTMLInputElement && el.type === "radio") {
      const groupKey = el.name || el.id;
      const optionId = stamp(el, "f");
      const optionLabel = el.closest("label")?.textContent?.trim() ?? labelTextsFor(el).join(" ");
      let group = radioGroups.get(groupKey);
      if (!group) {
        group = {
          fieldId: optionId,
          tag: "input",
          type: "radio",
          name: el.name,
          id: el.id,
          autocomplete: el.autocomplete ?? "",
          required: el.required,
          placeholder: "",
          labels: [],
          nearbyText: nearbyTextFor(el.closest("div, td, dd") as HTMLElement ?? el),
          options: [],
        };
        // The group label is whatever labels the row, not the individual radio.
        const row = el.closest("div.row, tr, dd, fieldset");
        const rowLabel = row?.querySelector("label:not(:has(input))")?.textContent?.trim()
          ?? row?.querySelector("legend, th")?.textContent?.trim();
        if (rowLabel) group.labels.push(rowLabel);
        radioGroups.set(groupKey, group);
        fields.push(group);
      }
      group.options?.push({ value: el.value, label: optionLabel, afId: optionId });
      continue;
    }

    const fieldId = stamp(el, "f");
    const base = {
      fieldId,
      name: el.name,
      id: el.id,
      autocomplete: "autocomplete" in el ? (el.autocomplete ?? "") : "",
      required: el.required,
      placeholder: "placeholder" in el ? (el.placeholder ?? "") : "",
      labels: labelTextsFor(el),
      nearbyText: nearbyTextFor(el),
    };
    if (el instanceof HTMLSelectElement) {
      fields.push({
        ...base,
        tag: "select",
        type: "select",
        options: Array.from(el.options)
          .filter((o) => o.value !== "")
          .map((o) => ({ value: o.value, label: o.textContent?.trim() ?? "" })),
      });
    } else if (el instanceof HTMLTextAreaElement) {
      fields.push({ ...base, tag: "textarea", type: "textarea" });
    } else {
      fields.push({ ...base, tag: "input", type: el.type });
    }
  }

  const buttons: PageSnapshot["buttons"] = [];
  for (const el of Array.from(document.querySelectorAll("button, input[type=submit]"))) {
    if (!(el instanceof HTMLElement) || !isVisible(el)) continue;
    const afId = stamp(el, "b");
    const text = (el instanceof HTMLInputElement ? el.value : el.textContent)?.trim() ?? "";
    buttons.push({ selector: `[data-af-id="${afId}"]`, text });
  }

  const links: PageSnapshot["links"] = [];
  for (const a of Array.from(document.querySelectorAll("a[href]"))) {
    if (!(a instanceof HTMLAnchorElement) || !isVisible(a)) continue;
    links.push({ href: a.href, text: a.textContent?.trim() ?? "" });
  }

  const wallMarkers: string[] = [];
  for (const marker of ["g-recaptcha", "h-captcha", "cf-turnstile"]) {
    if (document.querySelector(`.${marker}`)) wallMarkers.push(marker);
  }

  return {
    fields,
    buttons,
    links,
    visibleText: (document.body?.innerText ?? "").slice(0, 8000),
    iframeSrcs: Array.from(document.querySelectorAll("iframe")).map((f) => f.src),
    wallMarkers,
  };
}
