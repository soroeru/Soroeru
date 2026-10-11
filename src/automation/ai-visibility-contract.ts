import { KNOWN_PROFILE_KEYS, type FormField, type KnownProfileKey } from "../types.js";
import type { CollectionItem, CollectionObservation, CollectionTarget } from "./collection-observation.js";
import { classifyFields } from "../agent/classifier.js";

export const PAGE_PURPOSES = ["profile", "address", "contact", "billing", "notification", "security", "other", "unknown"] as const;
export interface CollectionProposal {
  observationId: string;
  pagePurpose: typeof PAGE_PURPOSES[number];
  values: { itemId: string; attributeKey: KnownProfileKey; value: string; confidence: number }[];
  nextTargetIds: string[];
  done: boolean;
}
export interface CollectionFact { observationId: string; attributeKey: KnownProfileKey; itemId: string; corroborated: boolean }
export interface VerifiedCollectionCandidate { item: CollectionItem; attributeKey: KnownProfileKey }
export const COLLECTION_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["observationId", "pagePurpose", "values", "nextTargetIds", "done"],
  properties: {
    observationId: { type: "string" }, pagePurpose: { type: "string", enum: PAGE_PURPOSES }, done: { type: "boolean" },
    nextTargetIds: { type: "array", maxItems: 20, items: { type: "string" } },
    values: { type: "array", maxItems: 100, items: { type: "object", additionalProperties: false,
      required: ["itemId", "attributeKey", "value", "confidence"], properties: {
        itemId: { type: "string" }, attributeKey: { type: "string", enum: KNOWN_PROFILE_KEYS },
        value: { type: "string", maxLength: 2048 }, confidence: { type: "number", minimum: 0, maximum: 1 },
      } } },
  },
};
const forbidden = /マイナンバー|個人番号|暗証番号|\bpin\b|my.?number|identity.?secret/i;
export function permittedCollectionItem(item: CollectionItem): boolean {
  const f = item.field;
  return /^([fd])-\d+$/.test(item.id) && f.type !== "hidden" &&
    !forbidden.test([f.name, f.id, f.autocomplete, f.placeholder, ...f.labels, f.nearbyText, item.value].join(" ")) &&
    !/^\d{12}$/.test(item.value.replace(/[ -]/g, ""));
}
/** Stands in for a secret item's value and nearby text in the model envelope (Issue #572). */
export const MASKED_VALUE = "[masked]";
const SECRET_AUTOCOMPLETE = new Set(["current-password", "new-password", "one-time-code", "cc-csc"]);
const SECRET_KEYS: readonly string[] = ["account.password", "card.cvv"];
// Secret-like but not certain: fail closed and mask; the key still needs local classifier agreement.
const secretHint = /pass(?:word|wd|code|phrase)|(?<![a-z])(?:pwd?|otp|totp|2fa|mfa)(?![a-z])|secret|token|api.?key|one.?time|cvv|cvc|csc|security.?code|verification.?code|auth.?code|パスワード|暗証|セキュリティ.?コード|認証コード|確認コード|ワンタイム|秘密/i;
/** Password, CVV, OTP and secret-like items: their values never reach a model, in any build (Issue #572). */
export function secretCollectionItem(item: CollectionItem): boolean {
  const f = item.field;
  if (f.type === "password" || SECRET_AUTOCOMPLETE.has(f.autocomplete.trim().toLowerCase())) return true;
  const local = classifyFields([f], []).entries[0]?.profileKey;
  return (!!local && SECRET_KEYS.includes(local)) || secretHint.test([f.name, f.id, f.autocomplete, f.placeholder, ...f.labels, f.nearbyText].join(" "));
}
export interface CollectionInput {
  observationId: string; items: CollectionItem[]; targets: CollectionTarget[];
  /** IDs of items whose values stay local; the model only classifies them by label. */
  masked: string[];
}
/** What the provider receives: masked items carry no value and no nearby text. */
export interface CollectionEnvelope { observationId: string; items: (CollectionItem & { masked?: true })[]; targets: CollectionTarget[] }
export function collectionEnvelope(input: CollectionInput): CollectionEnvelope {
  const masked = new Set(input.masked);
  const secrets = input.items.filter(i => masked.has(i.id)).map(i => i.value.trim()).filter(v => v.length >= 3);
  // Page text can echo a secret elsewhere (e.g. <dt>CVV</dt><dd>…</dd> beside another item); scrub every
  // page-derived string. IDs are Soroeru-generated and kept, so proposals still bind to observed items.
  const scrub = (text: string): string => secrets.reduce((t, v) => t.split(v).join(MASKED_VALUE), text);
  const field = (f: FormField): FormField => ({ ...f, name: scrub(f.name), id: scrub(f.id), placeholder: scrub(f.placeholder),
    labels: f.labels.map(scrub), nearbyText: scrub(f.nearbyText),
    ...(f.options ? { options: f.options.map(o => ({ ...o, value: scrub(o.value), label: scrub(o.label) })) } : {}) });
  return { observationId: input.observationId,
    items: input.items.map(i => masked.has(i.id)
      ? { id: i.id, field: { ...field(i.field), nearbyText: "" }, value: MASKED_VALUE, masked: true as const }
      : { id: i.id, field: field(i.field), value: scrub(i.value) }),
    targets: input.targets.map(t => ({ ...t, href: scrub(t.href), text: scrub(t.text) })) };
}
/** Item-aligned input, retained in memory for corroboration. Never includes arbitrary page HTML/text. */
export function collectionInput(observation: CollectionObservation): CollectionInput {
  const input: CollectionInput = { observationId: observation.token.observationId, items: [], targets: [], masked: [] };
  const fits = (): boolean => new TextEncoder().encode(JSON.stringify(collectionEnvelope(input))).length <= 16_384;
  for (const item of observation.items.filter(permittedCollectionItem)) {
    const secret = secretCollectionItem(item);
    input.items.push(item); if (secret) input.masked.push(item.id);
    if (!fits()) { input.items.pop(); if (secret) input.masked.pop(); }
  }
  // Model gets observed IDs and labels, not authority to invent executable URLs.
  for (const target of observation.targets) {
    if (target.href.length > 2048 || target.text.length > 256 || forbidden.test(target.text)) continue;
    input.targets.push(target);
    if (!fits()) input.targets.pop();
  }
  return input;
}
function exact(v: unknown, keys: string[]): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).sort().join() === keys.sort().join();
}
export function parseCollectionProposal(v: unknown, input: CollectionInput): CollectionProposal | undefined {
  if (!exact(v, ["observationId", "pagePurpose", "values", "nextTargetIds", "done"]) || v.observationId !== input.observationId ||
    !PAGE_PURPOSES.includes(v.pagePurpose as CollectionProposal["pagePurpose"]) || typeof v.done !== "boolean" ||
    !Array.isArray(v.values) || v.values.length > 100 || !Array.isArray(v.nextTargetIds) || v.nextTargetIds.length > 20) return;
  const seen = new Set<string>();
  const keys = new Set<string>();
  for (const entry of v.values) {
    if (!exact(entry, ["itemId", "attributeKey", "value", "confidence"]) || typeof entry.itemId !== "string" ||
      !input.items.some(i => i.id === entry.itemId) || seen.has(entry.itemId) ||
      !KNOWN_PROFILE_KEYS.includes(entry.attributeKey as KnownProfileKey) || keys.has(entry.attributeKey as string) ||
      typeof entry.value !== "string" || entry.value.length > 2048 || !entry.value.length ||
      typeof entry.confidence !== "number" || !Number.isFinite(entry.confidence) || entry.confidence < 0 || entry.confidence > 1) return;
    seen.add(entry.itemId); keys.add(entry.attributeKey as string);
  }
  if (new Set(v.nextTargetIds).size !== v.nextTargetIds.length ||
    v.nextTargetIds.some(id => typeof id !== "string" || !input.targets.some(t => t.id === id))) return;
  return v as unknown as CollectionProposal;
}
export function corroborateProposal(proposal: CollectionProposal, input: CollectionInput): { candidates: VerifiedCollectionCandidate[]; facts: CollectionFact[] } {
  const candidates: VerifiedCollectionCandidate[] = [], facts: CollectionFact[] = [];
  for (const value of proposal.values) {
    const item = input.items.find(i => i.id === value.itemId)!;
    const local = classifyFields([item.field], []).entries[0]?.profileKey;
    if (input.masked.includes(item.id)) {
      // The model saw no value: its key must match local classification, and the value is the locally read one.
      const corroborated = local === value.attributeKey && permittedCollectionItem(item);
      facts.push({ observationId: input.observationId, itemId: item.id, attributeKey: value.attributeKey, corroborated });
      if (corroborated) candidates.push({ item, attributeKey: value.attributeKey });
      continue;
    }
    const normalize = (v: string): string => {
      const text = v.normalize("NFC").replace(/\r\n?/g, "\n").trim();
      return local === value.attributeKey && ["phone.full", "card.number"].includes(local) ? text.replace(/[ -]/g, "") : text;
    };
    const corroborated = local === value.attributeKey && permittedCollectionItem(item) && normalize(item.value) === normalize(value.value) &&
      !(value.attributeKey === "card.number" && /[*•xX]/.test(item.value));
    facts.push({ observationId: input.observationId, itemId: item.id, attributeKey: value.attributeKey, corroborated });
    if (corroborated) candidates.push({ item, attributeKey: value.attributeKey });
  }
  return { candidates, facts };
}
