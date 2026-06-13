// Mapper abstraction: the deterministic variant and the AI variant implement the
// same interface so the runner can measure both against identical scenarios (Q8).

import type { MappingPlan, PageLink, PageSnapshot, TermsAnalysis } from "../types.js";
import { classifyFields, type CustomFieldDef } from "./classifier.js";
import { findRegistrationLink } from "./discovery.js";
import { analyzeTermsDeterministic } from "./guards.js";

export interface Mapper {
  readonly name: "deterministic" | "ai";
  /** Pick the registration link among the page links (structure only). */
  discoverRegistrationLink(links: PageLink[], pageText: string): Promise<PageLink | undefined>;
  /** Map form fields to profile keys / transforms (structure only; no values). */
  mapFields(snapshot: PageSnapshot, customs: CustomFieldDef[]): Promise<MappingPlan>;
  /** Detect high-risk clauses, payment type, and auto-creation bans. */
  analyzeTerms(termsText: string, pageText: string, hasCardFields: boolean): Promise<TermsAnalysis>;
}

export class DeterministicMapper implements Mapper {
  readonly name = "deterministic";

  discoverRegistrationLink(links: PageLink[]): Promise<PageLink | undefined> {
    return Promise.resolve(findRegistrationLink(links));
  }

  mapFields(snapshot: PageSnapshot, customs: CustomFieldDef[]): Promise<MappingPlan> {
    return Promise.resolve(classifyFields(snapshot.fields, customs));
  }

  analyzeTerms(termsText: string, pageText: string, hasCardFields: boolean): Promise<TermsAnalysis> {
    return Promise.resolve(analyzeTermsDeterministic(termsText, pageText, hasCardFields));
  }
}
