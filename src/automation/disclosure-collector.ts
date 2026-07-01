import { classifyFieldsWithEvidence, type CustomFieldDef } from "../agent/classifier.js";
import type { DomainService } from "../domain/domain-service.js";
import type { DisclosureSourceKind, SiteAccount } from "../domain/entities.js";
import type { DisplayValueCandidate, FormField, MappingEntry, PageSnapshot, ProfileKey } from "../types.js";
import { redactedEvidence } from "./evidence.js";

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
    const proposedAttributeKey = `custom.${slugForField(field, label)}` as ProfileKey;
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
  if (attributeKey === "card.cvv") return undefined;
  if (attributeKey === "card.number") {
    const digits = value.replace(/\D/g, "");
    return digits.slice(-4);
  }
  return value;
}

function labelForField(field: FormField): string {
  return field.labels[0] ?? field.placeholder ?? field.nearbyText ?? field.name ?? field.id ?? field.fieldId;
}

function slugForField(field: FormField, label: string): string {
  const source = [field.name, field.id, field.fieldId, label].find((value) => /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(value));
  if (source) return source.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();
  const code = Array.from(label).reduce((sum, char) => sum + char.codePointAt(0)!, 0);
  return `field_${code.toString(36)}`;
}

function sourceKindForField(field: FormField): "form-field" | "billing-page" | "newsletter-setting" {
  const text = `${field.name} ${field.id} ${field.labels.join(" ")} ${field.nearbyText}`;
  if (/card|billing|請求|支払/.test(text)) return "billing-page";
  if (/newsletter|mailmagazine|メールマガジン|ニュースレター/.test(text)) return "newsletter-setting";
  return "form-field";
}
