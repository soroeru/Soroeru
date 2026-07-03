// RuleEngine: the deterministic side of the DecisionEngine
// (docs/design/visibility-exploration.md §2). This Issue (#245) implements
// only the exploration-specific decisions that have no existing
// implementation: find-profile-links and should-continue. The login and
// classification kinds are intentionally NOT reimplemented here — equivalent
// logic already lives in visibility-runner.ts (ensureLoginPage / findLoginLink
// / login) and classifier.ts (classifyFieldsWithEvidence); whether RuleEngine
// wraps them as thin adapters is decided in Phase 3 / Phase 5 to avoid
// maintaining the same heuristics twice.

import type { PageSnapshot } from "../types.js";
import type {
  DecisionContext,
  DecisionKind,
  DecisionRequest,
  LinkCandidate,
  ProfileLinkCategory,
  RuleEvaluator,
  RuleResult,
} from "./decision-engine.js";
import { isSameSite, normalizeUrl, resolveHref } from "./url-utils.js";

export interface RuleEngineOptions {
  /**
   * Hard cap on pages visited per site. shouldContinue is PageExplorer's only
   * loop-end safety valve besides pendingUrls running out, so the cap is
   * always explicit and, once reached, not overridable by the AI.
   */
  maxPagesPerSite?: number;
}

export const DEFAULT_MAX_PAGES_PER_SITE = 20;

/**
 * Link-text patterns pointing at pages likely to show registered personal
 * info, ordered by priority (lower = visited first): entry pages first, then
 * concrete info categories.
 */
const PROFILE_LINK_RULES: { pattern: RegExp; priority: number; category: ProfileLinkCategory }[] = [
  { pattern: /マイページ|my\s*page/i, priority: 1, category: "mypage" },
  { pattern: /会員情報|登録情報|プロフィール|profile/i, priority: 2, category: "profile" },
  { pattern: /アカウント.*設定|account.*setting/i, priority: 2, category: "account-settings" },
  { pattern: /個人情報|personal/i, priority: 3, category: "personal-info" },
  { pattern: /住所|配送先|address|delivery/i, priority: 4, category: "address" },
  { pattern: /クレジットカード|お支払い|payment|card/i, priority: 4, category: "payment" },
  { pattern: /連絡先|contact/i, priority: 4, category: "contact" },
  { pattern: /セキュリティ|security|パスワード/i, priority: 4, category: "security" },
];

export class RuleEngine implements RuleEvaluator {
  private readonly maxPagesPerSite: number;

  constructor(options: RuleEngineOptions = {}) {
    this.maxPagesPerSite = options.maxPagesPerSite ?? DEFAULT_MAX_PAGES_PER_SITE;
  }

  evaluate<K extends DecisionKind>(request: DecisionRequest & { kind: K }): RuleResult<K> {
    // The switch cannot prove to the compiler that each branch returns the
    // result type matching K, so the per-kind handlers are typed individually
    // and the union is cast back to RuleResult<K> at this single boundary.
    return this.evaluateAny(request) as RuleResult<K>;
  }

  private evaluateAny(request: DecisionRequest): RuleResult {
    switch (request.kind) {
      case "find-profile-links":
        return this.findProfileLinks(request.snapshot, request.context);
      case "should-continue":
        return this.shouldContinue(request.context);
      case "find-login-page":
      case "detect-login-form":
      case "judge-login-result":
        // Existing login heuristics live in visibility-runner.ts; the Phase 3
        // LoginHandler decides what to delegate. Until then these kinds fall
        // through to the AI (if configured) or the safe default.
        return { confident: false };
      case "classify-field":
        // The deterministic classifier (classifier.ts) is reused directly by
        // Phase 5; additional label/nearby-text rules may be added here then.
        return { confident: false };
      case "name-new-attribute":
        // Naming new attributes is not feasible with rules (design §2).
        return { confident: false };
    }
  }

  private findProfileLinks(snapshot: PageSnapshot, context: DecisionContext): RuleResult<"find-profile-links"> {
    const visited = new Set(context.visitedUrls ?? []);
    const seen = new Set<string>();
    const candidates: LinkCandidate[] = [];

    for (const link of snapshot.links) {
      // Resolve to an absolute URL so PageExplorer can navigate to it.
      const href = resolveHref(link.href, snapshot.url);
      if (!href) continue;
      // Never suggest leaving the site the user is acting on.
      if (!isSameSite(href, context.siteAccount.domain)) continue;
      // visitedUrls is a set of normalized URLs, so compare normalized;
      // also dedupe repeated links (header + footer navigation).
      const normalized = normalizeUrl(href);
      if (visited.has(normalized) || seen.has(normalized)) continue;

      const rule = PROFILE_LINK_RULES.find((r) => r.pattern.test(link.text));
      if (!rule) continue;

      seen.add(normalized);
      candidates.push({ href, text: link.text, category: rule.category, priority: rule.priority });
    }

    candidates.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));

    // No candidates is an unconfident empty result: the AI (if configured) may
    // find links the keyword rules missed; without AI the empty list stands.
    return { confident: candidates.length > 0, result: { links: candidates } };
  }

  private shouldContinue(context: DecisionContext): RuleResult<"should-continue"> {
    const visitedCount = context.visitedUrls?.length ?? 0;
    if (visitedCount >= this.maxPagesPerSite) {
      // Hard cap reached: confident so the AI is never asked to exceed it.
      return { confident: true, result: { continue: false } };
    }
    // Below the cap, rules cannot tell whether more pages are worth visiting
    // (design: 探索終了判断 is AI-recommended). The unconfident partial result
    // keeps exploring when no AI is configured; the cap above and the
    // explorer's pendingUrls exhaustion bound the loop either way.
    return { confident: false, result: { continue: true } };
  }
}
