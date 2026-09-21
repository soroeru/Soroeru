import type { FormField, PageSnapshot } from "../types.js";

export interface ObservationToken {
  bindingEpoch: number;
  documentId: string;
  revision: number;
  observationId: string;
}
export interface CollectionItem { id: string; field: FormField; value: string }
export interface CollectionTarget { id: string; href: string; text: string; passive: boolean }
export interface CollectionObservation {
  token: ObservationToken;
  snapshot: PageSnapshot;
  items: CollectionItem[];
  targets: CollectionTarget[];
}
export type ObservationRequest = { kind: "capture"; bindingEpoch: number } | { kind: "check"; token: ObservationToken };
export function isObservationToken(value: unknown): value is ObservationToken {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).sort().join() === "bindingEpoch,documentId,observationId,revision" &&
    Number.isSafeInteger(v.bindingEpoch) && Number.isSafeInteger(v.revision) &&
    typeof v.documentId === "string" && v.documentId.length <= 100 &&
    typeof v.observationId === "string" && v.observationId.length <= 100;
}

/** Serialized into the browser; all helpers intentionally live inside this function.
 * Only one observation is retained, in memory. Scanning and value reads are synchronous.
 */
export function collectionObservationInPage(
  scan: () => Omit<PageSnapshot, "url" | "title">,
  request: ObservationRequest,
): CollectionObservation | boolean {
  type Slot = { documentId: string; revision: number; observer: MutationObserver;
    observation?: CollectionObservation; baseline?: string; at?: number };
  const root = globalThis as typeof globalThis & { __soroeruObservation?: Slot };
  let state = root.__soroeruObservation;
  if (!state) {
    const slot: Slot = { documentId: crypto.randomUUID(), revision: 0,
      observer: new MutationObserver(() => { slot.revision++; }) };
    slot.observer.observe(document.documentElement, { subtree: true, attributes: true, childList: true, characterData: true });
    const invalidate = (): void => { slot.revision++; delete slot.observation; delete slot.baseline; };
    addEventListener("pagehide", invalidate);
    addEventListener("pageshow", invalidate);
    root.__soroeruObservation = state = slot;
  }
  const drain = (): void => { if (state.observer.takeRecords().length) state.revision++; };
  const visible = (el: Element): boolean => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const values = (fields: FormField[]): CollectionItem[] => fields.flatMap((field) => {
    const el = document.querySelector(`[data-af-id="${CSS.escape(field.fieldId)}"]`);
    if (!el || !visible(el) || (el instanceof HTMLInputElement && el.type === "hidden")) return [];
    if (el instanceof HTMLInputElement && ["checkbox", "radio"].includes(el.type) && !el.checked) return [];
    const value = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement
      ? el.value : el.textContent ?? "";
    return value && value.length <= 2048 ? [{ id: field.fieldId, field, value }] : [];
  });
  const targets = (): CollectionTarget[] => Array.from(document.querySelectorAll("a[href]")).filter(visible).slice(0, 100).map((el, i) => ({
    id: `n-${i}`, href: (el as HTMLAnchorElement).href, text: (el.textContent ?? "").slice(0, 256),
    passive: !el.hasAttribute("onclick") && !el.hasAttribute("download") && !el.closest("form") &&
      !el.hasAttribute("role") && !el.hasAttribute("target"),
  }));
  drain();
  if (request.kind === "check") {
    const old = state.observation;
    if (!old || !state.at || Date.now() - state.at > 120_000 || JSON.stringify(old.token) !== JSON.stringify(request.token)) return false;
    return old.token.revision === state.revision && state.baseline === JSON.stringify({
      url: location.href, text: document.body?.innerText ?? "", items: values(old.items.map(i => i.field)), targets: targets(),
    });
  }
  const snapshot: PageSnapshot = { ...scan(), url: location.href, title: document.title };
  const fields: FormField[] = [...snapshot.fields, ...(snapshot.displayValues ?? []).map(d => ({
    fieldId: d.valueId, tag: "input" as const, type: "text", name: "", id: "", autocomplete: "",
    required: false, placeholder: "", labels: [d.labelText], nearbyText: d.nearbyText,
  }))].slice(0, 100);
  const items = values(fields);
  const links = targets();
  drain(); // Scanner marker writes precede the baseline.
  const observation: CollectionObservation = { snapshot, items, targets: links, token: {
    bindingEpoch: request.bindingEpoch, documentId: state.documentId, revision: state.revision, observationId: crypto.randomUUID(),
  }};
  state.observation = observation;
  state.at = Date.now();
  state.baseline = JSON.stringify({ url: location.href, text: document.body?.innerText ?? "", items, targets: links });
  return observation;
}
