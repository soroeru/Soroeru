// DecisionEngine: the hybrid rule/AI decision layer for the Visibility
// exploration flow (docs/design/visibility-exploration.md §1). Rules are tried
// first; when they cannot decide and the user has configured an AI provider,
// the request is escalated to the AiEngine (§8, separate Issue); when neither
// can decide, a per-kind safe default applies. Requests carry structure-only
// PageSnapshots — never field values (RFC-002).

import type { FormField, PageSnapshot } from "../types.js";

export type DecisionKind =
  | "find-login-page" // find a login page link
  | "detect-login-form" // detect the login form on the current page
  | "judge-login-result" // judge whether a login succeeded
  | "find-profile-links" // find profile/settings/address/payment links
  | "classify-field" // classify a form field into an attribute key
  | "should-continue" // decide whether exploration should continue
  | "name-new-attribute"; // name a newly discovered attribute

export interface DecisionContext {
  currentUrl?: string;
  /** Normalized URLs (PageExplorer keeps its visited set normalized). */
  visitedUrls?: string[];
  /** Attribute keys already collected in this run (keys only, no values). */
  collectedAttributes?: string[];
  siteAccount: { domain: string; displayName: string };
  /** The field under classification (classify-field only). */
  field?: FormField;
}

export interface DecisionRequest {
  kind: DecisionKind;
  /** Structure only, no values. */
  snapshot: PageSnapshot;
  context: DecisionContext;
}

export type ProfileLinkCategory =
  | "mypage"
  | "profile"
  | "account-settings"
  | "personal-info"
  | "address"
  | "payment"
  | "contact"
  | "security";

export interface LinkCandidate {
  /** Absolute URL (resolved against the page it was found on). */
  href: string;
  text: string;
  /** Rule score (find-login-page candidates). */
  score?: number;
  /** Category and priority (find-profile-links candidates; lower priority first). */
  category?: ProfileLinkCategory;
  priority?: number;
}

export interface LoginFormDetection {
  usernameFieldId: string;
  passwordFieldId: string;
  submitSelector?: string;
}

export interface FieldClassification {
  attributeKey: string | null;
  source: "rule" | "ai" | "unclassified";
  confidence: number;
}

/** Result type per DecisionKind; `decide<K>` ties the two together. */
export interface DecisionResultMap {
  "find-login-page": { links: LinkCandidate[] };
  "find-profile-links": { links: LinkCandidate[] };
  "detect-login-form": { form: LoginFormDetection | null };
  "judge-login-result": { success: boolean; reason: string };
  "classify-field": { classification: FieldClassification | null };
  "should-continue": { continue: boolean };
  "name-new-attribute": { attributeKey: string; label: string };
}

export interface DecisionResult<K extends DecisionKind = DecisionKind> {
  source: "rule" | "ai";
  confidence: number;
  result: DecisionResultMap[K];
}

export interface RuleResult<K extends DecisionKind = DecisionKind> {
  /** True when the rule's answer should be used without consulting the AI. */
  confident: boolean;
  /**
   * The rule's (possibly partial) answer. An unconfident partial result is
   * still used as the fallback for navigation kinds (see getDefaultResult);
   * state-asserting kinds (judge-login-result) must omit it when ambiguous.
   */
  result?: DecisionResultMap[K];
}

/** The rule-based side of the engine (implemented by RuleEngine). */
export interface RuleEvaluator {
  evaluate<K extends DecisionKind>(request: DecisionRequest & { kind: K }): RuleResult<K>;
}

/**
 * The optional AI fallback (design §8, implemented in a separate Issue).
 * Returns null when it cannot decide (provider error, timeout, budget
 * exceeded, response validation failure); the engine then falls back to the
 * safe default.
 */
export interface AiEngine {
  consult<K extends DecisionKind>(request: DecisionRequest & { kind: K }): Promise<DecisionResult<K> | null>;
}

/**
 * Safe defaults when neither rules nor AI can decide. Every default is the
 * "do less" option: no links to follow, no form, login treated as failed,
 * field left unclassified, exploration ended.
 */
const SAFE_DEFAULTS: { [K in DecisionKind]: () => DecisionResultMap[K] } = {
  "find-login-page": () => ({ links: [] }),
  "find-profile-links": () => ({ links: [] }),
  "detect-login-form": () => ({ form: null }),
  "judge-login-result": () => ({ success: false, reason: "no-decision" }),
  "classify-field": () => ({ classification: null }),
  "should-continue": () => ({ continue: false }),
  "name-new-attribute": () => ({ attributeKey: "unknown", label: "Unknown" }),
};

export class DecisionEngine {
  constructor(
    private readonly ruleEngine: RuleEvaluator,
    /** Present only when the user has configured an AI provider (REQ-013). */
    private readonly aiEngine?: AiEngine,
  ) {}

  async decide<K extends DecisionKind>(request: DecisionRequest & { kind: K }): Promise<DecisionResult<K>> {
    const ruleResult = this.ruleEngine.evaluate(request);
    if (ruleResult.confident && ruleResult.result !== undefined) {
      return { source: "rule", confidence: 1.0, result: ruleResult.result };
    }

    if (this.aiEngine) {
      const aiResult = await this.aiEngine.consult(request);
      if (aiResult) return aiResult;
    }

    return {
      source: "rule",
      confidence: 0.3,
      result: this.getDefaultResult(request.kind, ruleResult.result),
    };
  }

  /**
   * Whether an unconfident partial rule result may be used differs by kind
   * (intentional asymmetry):
   * - find-login-page / find-profile-links: candidates are only navigation
   *   suggestions; a miss just visits a harmless same-site page, so low-score
   *   partial results are worth trying and are used as-is.
   * - judge-login-result: wrongly deciding "success" would start collection
   *   from an unauthenticated session, so the RuleEngine returns no result
   *   when ambiguous and the failed-login default applies here.
   */
  private getDefaultResult<K extends DecisionKind>(
    kind: K,
    partial: DecisionResultMap[K] | undefined,
  ): DecisionResultMap[K] {
    if (partial !== undefined) return partial;
    return SAFE_DEFAULTS[kind]();
  }
}
