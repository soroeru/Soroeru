import { KNOWN_PROFILE_KEYS, type KnownProfileKey } from "../types.js";
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
export interface CollectionInput { observationId: string; items: CollectionItem[]; targets: CollectionTarget[] }
/** Item-aligned envelope, retained in memory for corroboration. Never includes arbitrary page HTML/text. */
export function collectionInput(observation: CollectionObservation): CollectionInput {
  const input: CollectionInput = { observationId: observation.token.observationId, items: [], targets: [] };
  const fits = (): boolean => new TextEncoder().encode(JSON.stringify(input)).length <= 16_384;
  for (const item of observation.items.filter(permittedCollectionItem)) {
    input.items.push(item);
    if (!fits()) input.items.pop();
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
    const normalize = (v: string): string => {
      if (["card.cvv", "account.password"].includes(value.attributeKey)) return v;
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
