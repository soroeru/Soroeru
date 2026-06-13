// Shared post-processing for mapper outputs. Both the deterministic and AI
// variants pass through this before the agent acts on the plan / terms analysis.

import {
  CHECKBOX_ROLES,
  HIGH_RISK_FLAGS,
  KNOWN_PROFILE_KEYS,
  TRANSFORMS,
  type CheckboxClassification,
  type FormField,
  type HighRiskFlag,
  type MappingEntry,
  type MappingPlan,
  type PaymentClassification,
  type ProfileKey,
  type TermsAnalysis,
  type Transform,
} from "../types.js";
import type { CustomFieldDef } from "./classifier.js";

const transformSet = new Set<string>(TRANSFORMS);
const highRiskSet = new Set<string>(HIGH_RISK_FLAGS);
const checkboxRoleSet = new Set<string>(CHECKBOX_ROLES);
const knownProfileKeySet = new Set<string>(KNOWN_PROFILE_KEYS);

export function isTransform(value: unknown): value is Transform {
  return typeof value === "string" && transformSet.has(value);
}

export function isHighRiskFlag(value: unknown): value is HighRiskFlag {
  return typeof value === "string" && highRiskSet.has(value);
}

function isProfileKey(value: unknown, customKeys: ReadonlySet<string>): value is ProfileKey {
  return typeof value === "string" && (knownProfileKeySet.has(value) || customKeys.has(value));
}

function isPaymentClassification(value: unknown): value is PaymentClassification {
  return value === "trial-subscription" || value === "immediate-payment" || value === "unknown";
}

export function normalizeMappingPlan(plan: MappingPlan, fields: FormField[], customs: CustomFieldDef[]): MappingPlan {
  const fieldIds = new Set(fields.map((f) => f.fieldId));
  const customKeys = new Set(customs.map((c) => c.key));

  const entries: MappingEntry[] = [];
  for (const entry of plan.entries) {
    if (!fieldIds.has(entry.fieldId)) continue;
    if (!isProfileKey(entry.profileKey, customKeys)) continue;
    const normalized: MappingEntry = { fieldId: entry.fieldId, profileKey: entry.profileKey };
    if (entry.transform !== undefined) {
      if (!isTransform(entry.transform)) continue;
      normalized.transform = entry.transform;
    }
    entries.push(normalized);
  }

  const checkboxes: CheckboxClassification[] = [];
  const seenCheckboxFieldIds = new Set<string>();
  for (const box of plan.checkboxes) {
    if (!fieldIds.has(box.fieldId)) continue;
    if (!checkboxRoleSet.has(box.role)) continue;
    if (seenCheckboxFieldIds.has(box.fieldId)) continue;
    seenCheckboxFieldIds.add(box.fieldId);
    checkboxes.push({ fieldId: box.fieldId, role: box.role, label: box.label });
  }

  const unmappedRequired = plan.unmappedRequired.filter((fieldId) => fieldIds.has(fieldId));
  return { entries, checkboxes, unmappedRequired };
}

export function normalizeTermsAnalysis(analysis: TermsAnalysis): TermsAnalysis {
  const flags: HighRiskFlag[] = [];
  const evidence: Partial<Record<HighRiskFlag, string>> = {};

  for (const flag of analysis.highRiskFlags) {
    if (!isHighRiskFlag(flag) || flags.includes(flag)) continue;
    flags.push(flag);
    const quote = analysis.evidence[flag];
    if (quote) evidence[flag] = quote;
  }

  if (analysis.prohibitsAutoCreation && !flags.includes("no-auto-creation")) {
    flags.push("no-auto-creation");
    const quote = analysis.evidence["no-auto-creation"];
    if (quote) evidence["no-auto-creation"] = quote;
  }

  const normalized: TermsAnalysis = {
    highRiskFlags: flags,
    evidence,
    prohibitsAutoCreation: Boolean(analysis.prohibitsAutoCreation),
  };

  if (analysis.payment !== undefined && isPaymentClassification(analysis.payment)) {
    normalized.payment = analysis.payment;
    if (analysis.payment === "trial-subscription" && !normalized.highRiskFlags.includes("trial-subscription")) {
      normalized.highRiskFlags = [...normalized.highRiskFlags, "trial-subscription"];
      const quote = analysis.evidence["trial-subscription"];
      if (quote) normalized.evidence["trial-subscription"] = quote;
    }
  }

  return normalized;
}
