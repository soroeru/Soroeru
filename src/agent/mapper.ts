// Mapper abstraction: the deterministic variant and the AI variant implement the
// same interface so the runner can measure both against identical scenarios (Q8).

import type { LocalCandidateDefinition, MappingEntry, MappingPlan, PageLink, PageSnapshot, SiteDefinition, TermsAnalysis } from "../types.js";
import { classifyFields, type CustomFieldDef } from "./classifier.js";
import { applyFieldRules, resolveDefinitions } from "./definitions.js";
import { findRegistrationLink } from "./discovery.js";
import { analyzeTermsDeterministic } from "./guards.js";
import { OFFICIAL_DEFINITIONS } from "./official-definitions.js";

export interface MapperContext {
  officialDefinitions?: readonly SiteDefinition[];
  localCandidates?: readonly LocalCandidateDefinition[];
}

export interface Mapper {
  readonly name: "deterministic" | "ai";
  /** Pick the registration link among the page links (structure only). */
  discoverRegistrationLink(links: PageLink[], pageText: string): Promise<PageLink | undefined>;
  /** Map form fields to profile keys / transforms (structure only; no values). */
  mapFields(snapshot: PageSnapshot, customs: CustomFieldDef[], context?: MapperContext): Promise<MappingPlan>;
  /** Detect high-risk clauses, payment type, and auto-creation bans. */
  analyzeTerms(termsText: string, pageText: string, hasCardFields: boolean): Promise<TermsAnalysis>;
}

function definitionEntries(snapshot: PageSnapshot, context?: MapperContext): MappingEntry[] {
  const matches = resolveDefinitions(
    snapshot,
    context?.officialDefinitions ?? OFFICIAL_DEFINITIONS,
    context?.localCandidates ?? [],
  );
  const entries: MappingEntry[] = [];
  const covered = new Set<string>();
  for (const match of matches) {
    const matched = applyFieldRules(
      snapshot.fields.filter((field) => !covered.has(field.fieldId)),
      match.definition.fieldRules ?? [],
    );
    for (const entry of matched) {
      entries.push(entry);
      covered.add(entry.fieldId);
    }
  }
  return entries;
}

function mergePlans(definitionMapped: MappingEntry[], fallback: MappingPlan, snapshot: PageSnapshot): MappingPlan {
  const covered = new Set(definitionMapped.map((entry) => entry.fieldId));
  const entries = [...definitionMapped, ...fallback.entries.filter((entry) => !covered.has(entry.fieldId))];
  const mapped = new Set(entries.map((entry) => entry.fieldId));
  return {
    entries,
    checkboxes: fallback.checkboxes,
    unmappedRequired: fallback.unmappedRequired.filter((fieldId) => !mapped.has(fieldId)),
  };
}

export function mapWithDefinitionRules(
  snapshot: PageSnapshot,
  context: MapperContext | undefined,
  fallback: (remaining: PageSnapshot) => Promise<MappingPlan> | MappingPlan,
): Promise<MappingPlan> {
  const entries = definitionEntries(snapshot, context);
  const covered = new Set(entries.map((entry) => entry.fieldId));
  const remainingSnapshot: PageSnapshot = {
    ...snapshot,
    fields: snapshot.fields.filter((field) => !covered.has(field.fieldId)),
  };
  if (remainingSnapshot.fields.length === 0) {
    return Promise.resolve(mergePlans(entries, { entries: [], checkboxes: [], unmappedRequired: [] }, snapshot));
  }
  return Promise.resolve(fallback(remainingSnapshot)).then((plan) => mergePlans(entries, plan, snapshot));
}

export class DeterministicMapper implements Mapper {
  readonly name = "deterministic";

  discoverRegistrationLink(links: PageLink[]): Promise<PageLink | undefined> {
    return Promise.resolve(findRegistrationLink(links));
  }

  mapFields(snapshot: PageSnapshot, customs: CustomFieldDef[], context?: MapperContext): Promise<MappingPlan> {
    return mapWithDefinitionRules(snapshot, context, (remaining) => classifyFields(remaining.fields, customs));
  }

  analyzeTerms(termsText: string, pageText: string, hasCardFields: boolean): Promise<TermsAnalysis> {
    return Promise.resolve(analyzeTermsDeterministic(termsText, pageText, hasCardFields));
  }
}
