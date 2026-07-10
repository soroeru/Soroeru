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

/**
 * Poll until the page exposes at least one form field or read-only display value,
 * or the timeout elapses (dynamic rendering). Display-only account pages have no
 * form fields, so waiting on fields alone would always burn the full timeout.
 */
export async function waitForFields(page: Page, timeoutMs = 5000): Promise<PageSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let snapshot = await snapshotPage(page);
  const isEmpty = (s: PageSnapshot): boolean => s.fields.length === 0 && (s.displayValues?.length ?? 0) === 0;
  while (isEmpty(snapshot) && Date.now() < deadline) {
    await page.waitForTimeout(150);
    snapshot = await snapshotPage(page);
  }
  return snapshot;
}

/**
 * Browser-only structure scanner shared by Playwright and the developer-only
 * Chrome extension content script. It must remain free of Node/Playwright
 * runtime dependencies because Chrome serializes this function into the page.
 */
export function scanInPage(): {
  fields: PageSnapshot["fields"];
  buttons: PageSnapshot["buttons"];
  links: PageSnapshot["links"];
  visibleText: string;
  iframeSrcs: string[];
  wallMarkers: string[];
  displayValues: NonNullable<PageSnapshot["displayValues"]>;
} {
  const SUPPORTED_TYPES = new Set([
    "text",
    "email",
    "tel",
    "url",
    "search",
    "number",
    "password",
    "date",
    "datetime-local",
    "month",
    "time",
    "week",
    "radio",
    "checkbox",
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
    if (
      !(
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement
      )
    ) {
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
          nearbyText: nearbyTextFor((el.closest("div, td, dd") as HTMLElement) ?? el),
          options: [],
        };
        // The group label is whatever labels the row, not the individual radio.
        const row = el.closest("div.row, tr, dd, fieldset");
        const rowLabel =
          row?.querySelector("label:not(:has(input))")?.textContent?.trim() ??
          row?.querySelector("legend, th")?.textContent?.trim();
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

  // --- Read-only display values (account pages that render registered info as text) ---
  // The runner collects these the same way as form fields, but the raw value is
  // read separately and locally; here we only export the label + a stamp id.
  const PLACEHOLDER_VALUES = new Set([
    "",
    "-",
    "—",
    "--",
    "未登録",
    "未設定",
    "未入力",
    "なし",
    "未連携",
    "非公開",
    "設定する",
    "変更",
    "編集",
    "登録する",
    "追加",
    "削除",
    "表示",
    "非表示",
  ]);
  const isPlausibleValue = (text: string): boolean => {
    const t = text.trim();
    if (t.length === 0 || t.length > 200) return false;
    if (PLACEHOLDER_VALUES.has(t)) return false;
    if (!/[0-9A-Za-z぀-ヿ一-鿿@]/.test(t)) return false; // not pure punctuation/symbols
    return true;
  };
  const hasFormControl = (el: Element): boolean => {
    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "select" || tag === "textarea" || tag === "button") return true;
    return el.querySelector("input, select, textarea, button") !== null;
  };

  const displayValues: NonNullable<PageSnapshot["displayValues"]> = [];
  const seenValueEls = new Set<Element>();
  const pushDisplay = (
    valueEl: HTMLElement,
    rawValue: string,
    labelText: string,
    nearbyText: string,
  ): void => {
    if (seenValueEls.has(valueEl)) return;
    if (!isPlausibleValue(rawValue)) return;
    if (!isVisible(valueEl)) return;
    const label = labelText.trim();
    const nearby = nearbyText.trim();
    if (label.length === 0 && nearby.length === 0) return;
    seenValueEls.add(valueEl);
    displayValues.push({
      valueId: stamp(valueEl, "d"),
      labelText: label.slice(0, 80),
      nearbyText: nearby.slice(0, 80),
    });
  };

  // (a) Read-only / disabled inputs hold a value the field loop intentionally skipped.
  for (const el of Array.from(document.querySelectorAll("input"))) {
    if (!(el instanceof HTMLInputElement)) continue;
    if (!(el.disabled || el.readOnly)) continue;
    if (el.type === "password" || el.type === "hidden") continue;
    pushDisplay(el, el.value ?? "", labelTextsFor(el).join(" "), nearbyTextFor(el));
  }

  // (b) Definition lists: <dt> label → <dd> value (when the dd is plain text).
  for (const dd of Array.from(document.querySelectorAll("dd"))) {
    if (!(dd instanceof HTMLElement) || hasFormControl(dd)) continue;
    const dt = dd.previousElementSibling;
    const label = dt?.tagName === "DT" ? (dt.textContent ?? "") : "";
    pushDisplay(dd, dd.textContent ?? "", label, "");
  }

  // (c) Table rows: <th> label → <td> value (when the td is plain text).
  for (const tr of Array.from(document.querySelectorAll("tr"))) {
    const th = tr.querySelector("th");
    const td = tr.querySelector("td");
    if (!(th instanceof HTMLElement) || !(td instanceof HTMLElement) || hasFormControl(td)) continue;
    pushDisplay(td, td.textContent ?? "", th.textContent ?? "", "");
  }

  // (d) General sibling layout: label element followed by value element.
  const DISPLAY_LABEL_KEYWORDS = [
    "名前",
    "氏名",
    "フルネーム",
    "姓",
    "名",
    "セイ",
    "メイ",
    "フリガナ",
    "ふりがな",
    "カナ",
    "メール",
    "email",
    "電話",
    "tel",
    "郵便番号",
    "〒",
    "住所",
    "都道府県",
    "市区町村",
    "会社",
    "部署",
    "部門",
    "所属",
    "生年月日",
    "生年",
    "性別",
    "ログイン",
    "ユーザー",
    "会員",
  ];
  const ACTION_EXCLUDE_RE = /(?:変更|追加|削除|登録|編集|設定|ログイン|送信|クリア)/;
  const isDisplayLabel = (text: string): boolean => {
    const label = text.trim().replace(/[:：]$/, "");
    return (
      label.length > 0 &&
      label.length <= 40 &&
      DISPLAY_LABEL_KEYWORDS.some((keyword) => label.includes(keyword)) &&
      !ACTION_EXCLUDE_RE.test(label)
    );
  };

  const labelTags = [
    "label",
    "span",
    "div",
    "p",
    "dt",
    "th",
    "strong",
    "b",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "li",
  ];
  for (const tag of labelTags) {
    for (const lbl of Array.from(document.querySelectorAll(tag))) {
      if (!(lbl instanceof HTMLElement) || !isVisible(lbl) || hasFormControl(lbl)) continue;
      if (/^H[1-6]$/.test(lbl.tagName)) continue;

      // A label candidate must be a leaf element unless it's a standard label/header tag.
      const isStandardLabelTag = ["label", "th", "dt", "legend"].includes(lbl.tagName.toLowerCase());
      if (!isStandardLabelTag && lbl.children.length > 0) continue;

      const labelText = lbl.textContent?.trim().replace(/[:：]$/, "") ?? "";
      if (!isDisplayLabel(labelText)) continue;

      const val = lbl.nextElementSibling;
      if (
        val instanceof HTMLElement &&
        isVisible(val) &&
        !hasFormControl(val) &&
        !isDisplayLabel(val.textContent ?? "")
      ) {
        pushDisplay(val, val.textContent ?? "", labelText, "");
      }
    }
  }

  // (e) Wrapped key/value rows: many component libraries put the label and
  // value in separate wrappers, so the label element is not itself adjacent
  // to the value element. Restrict this to a two-column row and known labels
  // to avoid treating arbitrary page copy as personal data.
  for (const row of Array.from(document.querySelectorAll("div, li"))) {
    if (!(row instanceof HTMLElement) || !isVisible(row) || hasFormControl(row)) continue;
    const children = Array.from(row.children).filter(
      (child): child is HTMLElement => child instanceof HTMLElement && isVisible(child),
    );
    if (children.length !== 2) continue;
    const [labelEl, valueEl] = children;
    if (
      !labelEl ||
      !valueEl ||
      /^H[1-6]$/.test(labelEl.tagName) ||
      isDisplayLabel(valueEl.textContent ?? "")
    ) continue;
    const containsNestedLabel = Array.from(valueEl.querySelectorAll("*"))
      .some((descendant) => isDisplayLabel(descendant.textContent ?? ""));
    if (containsNestedLabel) continue;
    if (!isDisplayLabel(labelEl.textContent ?? "")) continue;
    pushDisplay(valueEl, valueEl.textContent ?? "", labelEl.textContent ?? "", "");
  }

  // (f) Inline key/value markup such as `氏名：<span>山田</span>`. The label is
  // read from the text node before the first child; the stamped value element
  // is still read separately and locally by PageDriver.readDisplayValues.
  for (const container of Array.from(document.querySelectorAll("p, div, li, dt, th"))) {
    if (!(container instanceof HTMLElement) || !isVisible(container) || hasFormControl(container)) continue;
    const firstElement = container.firstElementChild;
    if (!(firstElement instanceof HTMLElement) || !isVisible(firstElement)) continue;
    const labelText = Array.from(container.childNodes)
      .slice(0, Array.from(container.childNodes).indexOf(firstElement))
      .filter((node): node is Text => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent ?? "")
      .join(" ")
      .trim()
      .replace(/[:：]$/, "");
    if (!isDisplayLabel(labelText) || hasFormControl(firstElement)) continue;
    pushDisplay(firstElement, firstElement.textContent ?? "", labelText, "");
  }

  // (g) Some accessibility-first layouts put the display label on the value
  // element itself. Accept only non-form elements with known PII labels.
  for (const valueEl of Array.from(document.querySelectorAll("[aria-label]"))) {
    if (!(valueEl instanceof HTMLElement) || !isVisible(valueEl) || hasFormControl(valueEl)) continue;
    const labelText = valueEl.getAttribute("aria-label")?.trim() ?? "";
    if (!isDisplayLabel(labelText)) continue;
    pushDisplay(valueEl, valueEl.textContent ?? "", labelText, "");
  }

  return {
    fields,
    buttons,
    links,
    visibleText: (document.body?.innerText ?? "").slice(0, 8000),
    iframeSrcs: Array.from(document.querySelectorAll("iframe")).map((f) => f.src),
    wallMarkers,
    displayValues,
  };
}
