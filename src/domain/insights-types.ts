// Ledger insight types (issue #161, RFC-002 §5.3): the cross-cutting filters and
// initial Reflection derived from the Disclosure ledger. Declared as a leaf type
// module (no Node imports) so it can be shared by both the trusted derivation
// (`./ledger-insights.ts`) and the renderer-facing IPC contract without dragging
// the vault/crypto graph into the renderer typecheck. Carries no raw values.

/** A linkable pointer to a piece of audit Evidence (references / masks only). */
export interface EvidenceRef {
  evidenceId: string;
  pageUrl?: string;
  fieldLabel?: string;
  maskedSnippet?: string;
}

/** The minimal cross-cutting filters Slice A surfaces (RFC-002 §5.3). */
export type LedgerFilterKey = "newsletter" | "billing" | "stale-contact" | "stalled";

/** One site appearing under a filter, with why it matched and the next safe action. */
export interface LedgerFilterSite {
  siteAccountId: string;
  displayName: string;
  domain: string;
  /** Why this site matched the filter (e.g. which attributes are stale). */
  reason: string;
  /**
   * The next *safe* action the user could take. Descriptive in Slice A — the
   * executing slices (bulk update / withdrawal / resume) land later; this never
   * collapses judgment into a single approve.
   */
  nextAction: string;
  evidence: EvidenceRef[];
}

export interface LedgerFilter {
  key: LedgerFilterKey;
  label: string;
  sites: LedgerFilterSite[];
}

export type ReflectionKind = "stale" | "newsletter" | "billing" | "over-disclosed" | "stalled";

/**
 * One observation in the initial Reflection (RFC-002 §5.1 step 6). A summary +
 * count per kind, presented as separate findings so the UI cannot reduce them to
 * a single blind bulk-approve (Product Principle: never a delegation of will).
 */
export interface ReflectionFinding {
  kind: ReflectionKind;
  summary: string;
  count: number;
}

export interface LedgerInsights {
  filters: LedgerFilter[];
  reflection: ReflectionFinding[];
}
