import { classifyFieldsWithEvidence } from "../agent/classifier.js";
import type { DomainService } from "../domain/domain-service.js";
import type { DisclosureSourceKind, SiteAccount } from "../domain/entities.js";
import type { DisplayValueCandidate, FormField, MappingEntry, PageSnapshot } from "../types.js";
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

export function collectDisclosures(options: DisclosureCollectionOptions): { disclosures: number } {
  const classification = classifyFieldsWithEvidence(options.fields, []);
  let disclosures = 0;
  for (const entry of classification.plan.entries) {
    const field = options.fields.find((candidate) => candidate.fieldId === entry.fieldId);
    const value = options.values[entry.fieldId];
    if (!field || value === undefined || value === "") continue;
    recordDisclosure(options, field, entry, value);
    disclosures++;
  }

  for (const fieldId of classification.plan.unmappedRequired) {
    const field = options.fields.find((candidate) => candidate.fieldId === fieldId);
    if (!field) continue;
    if (options.sourceKind === "manual-import") {
      const value = options.values[field.fieldId];
      if (value === undefined || value === "") continue;
    }
    options.domain.addDisclosure({
      siteAccountId: options.siteAccount.id,
      attributeKey: `custom.unknown.${field.fieldId}`,
      observedAt: (options.now ?? Date.now)(),
      sourcePageUrl: options.snapshot.url,
      sourceKind: options.sourceKind ?? "form-field",
      confidence: 0,
    });
    disclosures++;
  }
  return { disclosures };
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

function recordDisclosure(
  options: DisclosureCollectionOptions,
  field: FormField,
  entry: MappingEntry,
  value: string,
): void {
  const now = options.now ?? Date.now;
  const label = field.labels[0] ?? field.placeholder ?? field.nearbyText ?? field.name ?? field.id;
  const evidence = options.domain.addEvidence(
    redactedEvidence({
      siteAccountId: options.siteAccount.id,
      pageUrl: options.snapshot.url,
      fieldLabel: label,
      fieldType: field.type,
      attributeKey: entry.profileKey,
      value,
      observedAt: now(),
    }),
  );
  const normalizedValueHash = evidence.normalizedHash;
  if (!normalizedValueHash) return;
  options.domain.addDisclosure({
    siteAccountId: options.siteAccount.id,
    attributeKey: entry.profileKey,
    normalizedValueHash,
    observedAt: now(),
    sourcePageUrl: options.snapshot.url,
    sourceKind: options.sourceKind ?? sourceKindForField(field),
    confidence: options.sourceKind === "manual-import" ? 0.8 : 1,
    evidenceIds: [evidence.id],
  });
}

function sourceKindForField(field: FormField): "form-field" | "billing-page" | "newsletter-setting" {
  const text = `${field.name} ${field.id} ${field.labels.join(" ")} ${field.nearbyText}`;
  if (/card|billing|請求|支払/.test(text)) return "billing-page";
  if (/newsletter|mailmagazine|メールマガジン|ニュースレター/.test(text)) return "newsletter-setting";
  return "form-field";
}
