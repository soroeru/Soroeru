// RuleEngine: the deterministic side of the DecisionEngine
// (docs/architecture.md#resolution-and-validation). #245 implemented the
// exploration-specific decisions (find-profile-links, should-continue); #246
// wired the login kinds (find-login-page, detect-login-form,
// judge-login-result) to the heuristics shared with visibility-runner.ts,
// which now live in login-handler.ts — one implementation, not two. The
// classification kinds stay with classifier.ts (classifyFieldsWithEvidence)
// until Phase 5 decides whether extra label/nearby-text rules belong here.

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
import { findLoginField, findLoginLinkCandidates, findLoginSubmitButton, LOGIN_LINK_CONFIDENT_SCORE } from "./login-handler.js";
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
        return this.findLoginPageLinks(request.snapshot, request.context);
      case "detect-login-form":
        return this.detectLoginForm(request.snapshot);
      case "judge-login-result":
        return this.judgeLoginResult(request.snapshot, request.context);
      case "classify-field":
        // The deterministic classifier (classifier.ts) is reused directly by
        // Phase 5; additional label/nearby-text rules may be added here then.
        return { confident: false };
      case "name-new-attribute":
        // Naming new attributes is not feasible with rules (design §2).
        return { confident: false };
    }
  }

  private findLoginPageLinks(snapshot: PageSnapshot, context: DecisionContext): RuleResult<"find-login-page"> {
    const candidates = findLoginLinkCandidates(snapshot, context.siteAccount.domain);
    // Confident only when the top candidate matched an explicit login keyword;
    // weaker href-only hints stay an unconfident partial result, which the
    // DecisionEngine still uses as the navigation fallback (a miss just visits
    // a harmless same-site page).
    return {
      confident: (candidates[0]?.score ?? 0) >= LOGIN_LINK_CONFIDENT_SCORE,
      result: { links: candidates },
    };
  }

  private detectLoginForm(snapshot: PageSnapshot): RuleResult<"detect-login-form"> {
    const password = findLoginField(snapshot.fields, "password");
    // No password field: confidently not a login form page.
    if (!password) return { confident: true, result: { form: null } };

    const username = findLoginField(snapshot.fields, "username");
    // A password without a recognizable username field is ambiguous (a
    // password-only step, or a layout the heuristics miss). A partial form
    // would make the caller fill an undefined field, so no form is returned
    // and the AI (if configured) may still find the pair.
    if (!username) return { confident: false, result: { form: null } };

    const submit = findLoginSubmitButton(snapshot.buttons);
    return {
      // Without a recognizable submit button the field pair is still
      // returned, but unconfidently, so a configured AI gets the chance to
      // find the button; the partial form remains the no-AI fallback.
      confident: submit !== undefined,
      result: {
        form: {
          usernameFieldId: username.fieldId,
          passwordFieldId: password.fieldId,
          ...(submit ? { submitSelector: submit.selector } : {}),
        },
      },
    };
  }

  private judgeLoginResult(snapshot: PageSnapshot, context: DecisionContext): RuleResult<"judge-login-result"> {
    const successSignals = [
      snapshot.links.some((link) => /ログアウト|sign\s*out|log\s*out/i.test(link.text)),
      snapshot.links.some((link) => /マイページ|my\s*page|dashboard/i.test(link.text)),
      // currentUrl unknown is neutral: it counts toward neither side.
      context.currentUrl != null && !context.currentUrl.includes("login"),
    ];
    const failureSignals = [
      findLoginField(snapshot.fields, "password") !== undefined,
      /エラー|error|失敗|incorrect|invalid|wrong/i.test(snapshot.visibleText),
    ];
    const successScore = successSignals.filter(Boolean).length;
    const failureScore = failureSignals.filter(Boolean).length;

    if (successScore >= 2 && failureScore === 0) {
      return { confident: true, result: { success: true, reason: "success-indicators" } };
    }
    if (failureScore >= 1 && successScore === 0) {
      return { confident: true, result: { success: false, reason: "failure-indicators" } };
    }
    // Mixed or weak signals: intentionally no result — wrongly deciding
    // "success" would start collection from an unauthenticated session, so the
    // DecisionEngine's safe default (login treated as failed) applies.
    return { confident: false };
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
