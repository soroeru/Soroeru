import type { FormField, PageSnapshot } from "../types.js";

export interface ObservationToken {
  bindingEpoch: number;
  documentId: string;
  revision: number;
  observationId: string;
}
export interface CollectionItem { id: string; field: FormField; value: string }
export interface CollectionTarget { id: string; href: string; text: string; passive: boolean }
/** Local structural fingerprints (architecture §5.2); never sent to a model. */
export interface CollectionFingerprints { page: string; items: Record<string, string> }
export interface CollectionObservation {
  token: ObservationToken;
  snapshot: PageSnapshot;
  items: CollectionItem[];
  targets: CollectionTarget[];
  /** Absent when the adapter/page cannot produce them; such pages never enter a map. */
  fingerprints?: CollectionFingerprints;
}

const SHA256_HEX = /^[a-f0-9]{64}$/;
export function isCollectionFingerprints(value: unknown): value is CollectionFingerprints {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join() !== "items,page" || typeof v.page !== "string" || !SHA256_HEX.test(v.page)) return false;
  const items = v.items;
  return !!items && typeof items === "object" && !Array.isArray(items) && Object.keys(items).length <= 100 &&
    Object.entries(items).every(([id, print]) => /^[fd]-[1-9][0-9]{0,5}$/.test(id) && typeof print === "string" && SHA256_HEX.test(print));
}

/** Minimal element surface so the fingerprint is testable outside a browser. */
export interface FingerprintElement { localName: string; namespaceURI: string | null; children: ArrayLike<FingerprintElement>; type?: string }

/**
 * Serialized into the browser with collectionObservationInPage; self-contained.
 * SHA-256 over the UTF-8 JSON array of [childIndexPath, tag, controlType] tuples in
 * preorder. Text, values, labels, IDs, classes, URLs and other attributes are excluded.
 * Non-rendered elements (script/style/noscript/template/link/meta) are skipped and do
 * not consume a child index, so injected scripts do not shift positions.
 * Returns "" when the tree exceeds the element bound.
 */
export function structuralFingerprintInPage(root: FingerprintElement): string {
  const skip = new Set(["script", "style", "noscript", "template", "link", "meta"]);
  const tuples: [number[], string, string][] = [];
  const stack: [FingerprintElement, number[]][] = [[root, []]];
  while (stack.length) {
    if (tuples.length >= 20_000) return "";
    const [el, path] = stack.pop()!;
    const name = String(el.localName).toLowerCase();
    const unknown = typeof HTMLUnknownElement === "function" && (el as unknown) instanceof HTMLUnknownElement;
    // HTML namespace (…/1999/xhtml); matched by suffix since it is an identifier, not a network URL.
    const html = /\/1999\/xhtml$/.test(el.namespaceURI ?? "");
    const tag = html && !name.includes("-") && !unknown ? name : "other";
    tuples.push([path, tag, name === "input" ? String(el.type ?? "text") : ""]);
    const kids = Array.from(el.children).filter(c => !skip.has(String(c.localName).toLowerCase()));
    for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i]!, [...path, i + 1]]);
  }
  const bytes = new TextEncoder().encode(JSON.stringify(tuples));
  const K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
    0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
    0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70,
    0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  padded.set(bytes); padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bytes.length / 0x20000000));
  view.setUint32(padded.length - 4, (bytes.length * 8) >>> 0);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]!, b = w[i - 2]!;
      w[i] = (w[i - 16]! + (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) + w[i - 7]! + (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10))) >>> 0;
    }
    let [a, b, c, d, e, f, g, k] = h as [number, number, number, number, number, number, number, number];
    for (let i = 0; i < 64; i++) {
      const t1 = (k + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i]! + w[i]!) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      k = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    [a, b, c, d, e, f, g, k].forEach((v, i) => { h[i] = (h[i]! + v) >>> 0; });
  }
  return h.map(v => v.toString(16).padStart(8, "0")).join("");
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
  fingerprint?: (root: FingerprintElement) => string,
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
  // Structure-only and synchronous with the value read; the body excludes the extension banner.
  const page = fingerprint && document.body ? fingerprint(document.body) : "";
  if (fingerprint && page) {
    const itemPrints: Record<string, string> = {};
    for (const item of items) {
      const el = document.querySelector(`[data-af-id="${CSS.escape(item.id)}"]`);
      const print = el ? fingerprint(el) : "";
      if (print) itemPrints[item.id] = print;
    }
    observation.fingerprints = { page, items: itemPrints };
  }
  state.observation = observation;
  state.at = Date.now();
  state.baseline = JSON.stringify({ url: location.href, text: document.body?.innerText ?? "", items, targets: links });
  return observation;
}
