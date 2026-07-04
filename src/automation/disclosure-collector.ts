import { classifyFieldsWithEvidence, type CustomFieldDef } from "../agent/classifier.js";
import type { DomainService } from "../domain/domain-service.js";
import { MOST_SENSITIVE_ATTRIBUTE_KEY, type DisclosureSourceKind, type SiteAccount } from "../domain/entities.js";
import type { DisplayValueCandidate, FormField, MappingEntry, PageSnapshot, ProfileKey, WallDetection } from "../types.js";
import { redactedEvidence } from "./evidence.js";
import type { PageDriver } from "./page-driver.js";
import type { ExplorationEvent, ExplorationHandoff } from "./page-explorer.js";

export interface DisclosureCollectionOptions {
  domain: DomainService;
  siteAccount: SiteAccount;
  snapshot: PageSnapshot;
  fields: FormField[];
  values: Record<string, string>;
  now?: () => number;
  sourceKind?: DisclosureSourceKind;
}

export function collectDisclosures(options: DisclosureCollectionOptions): { disclosures: number; dynamicCandidates: number } {
  const classification = classifyFieldsWithEvidence(options.fields, confirmedDynamicCustoms(options.domain));
  let disclosures = 0;
  for (const entry of classification.plan.entries) {
    const field = options.fields.find((candidate) => candidate.fieldId === entry.fieldId);
    const value = options.values[entry.fieldId];
    if (!field || value === undefined || value === "") continue;
    if (recordDisclosure(options, field, entry, value)) disclosures++;
  }

  let dynamicCandidates = 0;
  for (const fieldId of classification.plan.unmappedRequired) {
    const field = options.fields.find((candidate) => candidate.fieldId === fieldId);
    if (!field) continue;
    if (options.sourceKind === "manual-import") {
      const value = options.values[field.fieldId];
      if (value === undefined || value === "") continue;
    }
    const label = labelForField(field);
    const proposedAttributeKey = `custom.${slugForField(label)}` as ProfileKey;
    options.domain.recordDynamicAttributeCandidate({
      siteAccountId: options.siteAccount.id,
      label,
      fieldId: field.fieldId,
      sourcePageUrl: options.snapshot.url,
      proposedAttributeKey,
      matchTerms: [label],
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
    dynamicCandidates++;
  }
  return { disclosures, dynamicCandidates };
}

export interface ExplorationCollectionOptions {
  domain: DomainService;
  siteAccount: SiteAccount;
  /** The driver the exploration runs on; each page's values are read from it. */
  pageDriver: PageDriver;
  now?: () => number;
}

export interface ExplorationCollectionResult {
  pagesCollected: number;
  disclosures: number;
  dynamicCandidates: number;
  /**
   * Set when exploration paused on a wall (CAPTCHA / MFA / verification):
   * counts cover the pages collected before the wall. The caller hands off to
   * the human, then calls this again with `PageExplorer.resume()` to continue
   * in the same session. Absent when exploration ran to completion.
   */
  wall?: { url: string; wall: WallDetection; handoff: ExplorationHandoff };
}

/**
 * Drive disclosure collection over a PageExplorer event stream: for every
 * `page-snapshot` event the field/display values are read from the driver and
 * fed to `collectDisclosures` (classification, card sanitization, dynamic
 * attribute candidates — all existing logic, unchanged).
 *
 * Reading values here is correct because the explorer's generator is suspended
 * at the `page-snapshot` yield: the driver is still showing exactly the page
 * the snapshot describes. The values stay local — the snapshot handed to any
 * decision layer remains structure-only.
 */
export async function collectDuringExploration(
  events: AsyncIterable<ExplorationEvent>,
  options: ExplorationCollectionOptions,
): Promise<ExplorationCollectionResult> {
  const result: ExplorationCollectionResult = { pagesCollected: 0, disclosures: 0, dynamicCandidates: 0 };
  for await (const event of events) {
    if (event.kind === "wall-detected") {
      // The explorer pauses itself after this event. Its resume slot lives on
      // the explorer instance and is untouched by closing this iterator, so
      // the caller can hand off and continue with PageExplorer.resume().
      result.wall = { url: event.url, wall: event.wall, handoff: event.handoff };
      return result;
    }
    if (event.kind !== "page-snapshot") continue;

    const values = await options.pageDriver.readValues();
    // Merging is collision-free: the scanner stamps form fields "f-*" and
    // display values "d-*" (src/agent/scan.ts), disjoint key namespaces.
    const displayValues = (await options.pageDriver.readDisplayValues?.()) ?? {};
    const displayFields = (event.snapshot.displayValues ?? []).map(displayValueToSyntheticField);
    const collected = collectDisclosures({
      domain: options.domain,
      siteAccount: options.siteAccount,
      snapshot: event.snapshot,
      fields: [...event.snapshot.fields, ...displayFields],
      values: { ...values, ...displayValues },
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
    result.pagesCollected++;
    result.disclosures += collected.disclosures;
    result.dynamicCandidates += collected.dynamicCandidates;
  }
  return result;
}

export function displayValueToSyntheticField(candidate: DisplayValueCandidate): FormField {
  return {
    fieldId: candidate.valueId,
    tag: "input",
    type: "text",
    name: "",
    id: "",
    autocomplete: "",
    required: false,
    placeholder: "",
    labels: candidate.labelText ? [candidate.labelText] : [],
    nearbyText: candidate.nearbyText,
  };
}

function confirmedDynamicCustoms(domain: DomainService): CustomFieldDef[] {
  return domain
    .listDynamicAttributeCandidates()
    .filter((candidate) => candidate.status === "validated")
    .map((candidate) => ({
      key: candidate.proposedAttributeKey,
      matchTerms: candidate.matchTerms,
    }));
}

function recordDisclosure(
  options: DisclosureCollectionOptions,
  field: FormField,
  entry: MappingEntry,
  value: string,
): boolean {
  const siteHeldValue = disclosureStoredValue(entry.profileKey, value);
  if (siteHeldValue === undefined) return false;
  const now = options.now ?? Date.now;
  const label = labelForField(field);
  const evidence = options.domain.addEvidence(
    redactedEvidence({
      siteAccountId: options.siteAccount.id,
      pageUrl: options.snapshot.url,
      fieldLabel: label,
      fieldType: field.type,
      attributeKey: entry.profileKey,
      value: siteHeldValue,
      observedAt: now(),
    }),
  );
  const normalizedValueHash = evidence.normalizedHash;
  if (!normalizedValueHash) return false;
  options.domain.addDisclosure({
    siteAccountId: options.siteAccount.id,
    attributeKey: entry.profileKey,
    siteHeldValue,
    normalizedValueHash,
    observedAt: now(),
    sourcePageUrl: options.snapshot.url,
    sourceKind: options.sourceKind ?? sourceKindForField(field),
    confidence: options.sourceKind === "manual-import" ? 0.8 : 1,
    evidenceIds: [evidence.id],
  });
  return true;
}

function disclosureStoredValue(attributeKey: string, value: string): string | undefined {
  if (attributeKey === MOST_SENSITIVE_ATTRIBUTE_KEY) return undefined;
  if (attributeKey === "card.number") {
    const digits = value.replace(/\D/g, "");
    return digits.slice(-4);
  }
  return value;
}

function labelForField(field: FormField): string {
  return field.labels[0] ?? field.placeholder ?? field.nearbyText ?? field.name ?? field.id ?? field.fieldId;
}

/**
 * Derive a stable slug from the field's human-readable label, not from
 * `field.name`/`field.id` — those are frequently framework-generated and can
 * change between page loads or sessions for the same real-world field, which
 * would otherwise create a new, distinct dynamic-attribute candidate every
 * time instead of accumulating observations on one candidate (review #228).
 * The label is what a human (and the confirm UI) actually identifies the
 * field by, so it is the stable identity here.
 *
 * The hash always covers the *entire* trimmed label, never only its ASCII
 * portion: two labels that differ only in non-ASCII characters (e.g. a
 * bilingual gloss "住所 (Address)" vs. "勤務先 (Address)") must not collapse
 * onto the same key just because they share an English word (review #228
 * follow-up). The ASCII portion is prepended only for human readability.
 */
function slugForField(label: string): string {
  const trimmed = label.trim();
  const asciiPrefix = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const hash = stableHash(trimmed);
  return /[a-z]/.test(asciiPrefix) ? `${asciiPrefix}_${hash}` : `field_${hash}`;
}

/** Deterministic djb2 hash, base36-encoded, for labels with no ASCII letters. */
function stableHash(value: string): string {
  let hash = 5381;
  for (const char of value) {
    hash = (hash * 33 + char.codePointAt(0)!) >>> 0;
  }
  return hash.toString(36);
}

function sourceKindForField(field: FormField): "form-field" | "billing-page" | "newsletter-setting" {
  const text = `${field.name} ${field.id} ${field.labels.join(" ")} ${field.nearbyText}`;
  if (/card|billing|請求|支払/.test(text)) return "billing-page";
  if (/newsletter|mailmagazine|メールマガジン|ニュースレター/.test(text)) return "newsletter-setting";
  return "form-field";
}
