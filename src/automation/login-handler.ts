// LoginHandler (docs/design/visibility-exploration.md §7): drives a PageDriver
// through login-page discovery, form detection, credential fill, submit, and
// result judgement. Each decision is delegated to the DecisionEngine (rules
// first, optional AI fallback); any detected wall pauses the flow for a human
// hand-off — never bypassed.
//
// The deterministic heuristics exported below (findLoginField / hasLoginFields
// / findLoginLink / findLoginLinkCandidates / findLoginSubmitButton) were
// extracted from visibility-runner.ts (#246) so the RuleEngine, this handler,
// and the VisibilityRunner share one implementation instead of maintaining the
// same heuristics twice.

import type { Credential, SiteAccount } from "../domain/entities.js";
import type { FormField, PageButton, PageSnapshot, WallDetection } from "../types.js";
import type { DecisionContext, DecisionEngine, LinkCandidate } from "./decision-engine.js";
import type { PageDriver } from "./page-driver.js";
import { isSameSite, resolveHref } from "./url-utils.js";
import type { WallDetectionService } from "./wall-detection.js";

export type LoginFailureReason = "login-page-not-found" | "login-form-not-found" | "login-failed";

export interface LoginResult {
  success: boolean;
  error?: LoginFailureReason;
  /** Detected wall to hand off to the human in the same session (never bypassed). */
  wall?: WallDetection;
}

export class LoginHandler {
  constructor(
    private readonly decisionEngine: DecisionEngine,
    private readonly wallDetection: WallDetectionService,
  ) {}

  async login(page: PageDriver, credential: Credential, siteAccount: SiteAccount): Promise<LoginResult> {
    const context: DecisionContext = {
      siteAccount: { domain: siteAccount.domain, displayName: siteAccount.displayName },
    };

    // Step 1: start from the imported login/entry URL (Credential carries no
    // URL of its own; SiteAccount.url is the anchor from the CSV import).
    // egress: target-site — navigate only to the site account the user imported/selected.
    await page.goto(siteAccount.url ?? `https://${siteAccount.domain}/`);
    await page.waitForReady();
    let snapshot = await page.snapshot();

    // Walls are checked after every snapshot. §7 checks once before filling;
    // checking earlier is strictly more conservative — it prevents navigating
    // away from a wall the human must resolve in this same session.
    let wall = this.wallDetection.detect(snapshot);
    if (wall) return { success: false, wall };

    // Step 2: detect the login form; when absent, look for a login page.
    let detection = await this.decisionEngine.decide({ kind: "detect-login-form", snapshot, context });
    if (!detection.result.form) {
      const loginPage = await this.findLoginPage(page, siteAccount, context);
      if (loginPage.wall) return { success: false, wall: loginPage.wall };
      if (!loginPage.found) return { success: false, error: "login-page-not-found" };
      snapshot = await page.snapshot();
      wall = this.wallDetection.detect(snapshot);
      if (wall) return { success: false, wall };
      detection = await this.decisionEngine.decide({ kind: "detect-login-form", snapshot, context });
    }
    const form = detection.result.form;
    if (!form) return { success: false, error: "login-form-not-found" };

    // Step 4: fill and submit. Credential values are filled locally into the
    // page and never appear in a snapshot or an AI request.
    await page.fillField(form.usernameFieldId, credential.username);
    await page.fillField(form.passwordFieldId, credential.password);
    if (form.submitSelector) await page.click(form.submitSelector);
    await page.waitForReady();

    // Step 5: judge the result; a post-login wall (MFA / OTP) hands off first.
    snapshot = await page.snapshot();
    wall = this.wallDetection.detect(snapshot);
    if (wall) return { success: false, wall };

    const judged = await this.decisionEngine.decide({
      kind: "judge-login-result",
      snapshot,
      context: { ...context, currentUrl: page.currentUrl() },
    });
    return judged.result.success ? { success: true } : { success: false, error: "login-failed" };
  }

  private async findLoginPage(
    page: PageDriver,
    siteAccount: SiteAccount,
    context: DecisionContext,
  ): Promise<{ found: boolean; wall?: WallDetection }> {
    // egress: target-site — the top page of the same site account's domain.
    await page.goto(`https://${siteAccount.domain}/`);
    await page.waitForReady();
    const snapshot = await page.snapshot();
    const wall = this.wallDetection.detect(snapshot);
    if (wall) return { found: false, wall };

    const decided = await this.decisionEngine.decide({ kind: "find-login-page", snapshot, context });
    const top = decided.result.links[0];
    // Rule candidates are same-site by construction; re-check here so an AI
    // fallback answer can never navigate off the site the user acts on.
    if (!top || !isSameSite(top.href, siteAccount.domain)) return { found: false };

    // egress: target-site — a same-site login link found on the top page.
    await page.goto(top.href);
    await page.waitForReady();
    return { found: true };
  }
}

export function findLoginField(fields: FormField[], kind: "username" | "password"): FormField | undefined {
  if (kind === "password") return fields.find((field) => field.type === "password" || field.autocomplete === "current-password");
  return fields.find((field) => field.autocomplete === "username" || field.type === "email" || /mail|email|user|login/i.test(`${field.name} ${field.id}`));
}

export function hasLoginFields(snapshot: PageSnapshot): boolean {
  return (
    findLoginField(snapshot.fields, "password") !== undefined &&
    findLoginField(snapshot.fields, "username") !== undefined
  );
}

export function findLoginSubmitButton(buttons: PageButton[]): PageButton | undefined {
  return buttons.find((b) => /ログイン|login|sign in/i.test(b.text));
}

/**
 * Minimum top-candidate score for a confident find-login-page rule answer.
 * The keyword rule scores an explicit login wording +3 and an href-only hint
 * +1, so reaching 3 requires the explicit keyword.
 */
export const LOGIN_LINK_CONFIDENT_SCORE = 3;

/**
 * Same-site login-link candidates, scored and sorted best-first. Hrefs are
 * resolved against the page URL so callers can navigate to them directly.
 */
export function findLoginLinkCandidates(snapshot: PageSnapshot, domain: string): LinkCandidate[] {
  const candidates: LinkCandidate[] = [];
  for (const link of snapshot.links) {
    // Never suggest leaving the site the user is acting on.
    if (!isSameSite(link.href, domain)) continue;
    const href = resolveHref(link.href, snapshot.url);
    if (!href) continue;
    const score = loginLinkScore(link.text, link.href);
    if (score <= 0) continue;
    candidates.push({ href, text: link.text, score });
  }
  return candidates.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

/** Best same-site login link on the page, or undefined. */
export function findLoginLink(snapshot: PageSnapshot, domain: string): string | undefined {
  return findLoginLinkCandidates(snapshot, domain)[0]?.href;
}

function loginLinkScore(text: string, href: string): number {
  const haystack = `${text} ${href}`;
  let score = 0;
  if (/ログイン|login|sign[\s_-]?in|サインイン|会員ログイン|マイページ/i.test(haystack)) score += 3;
  if (/account|member|auth|session|mypage/i.test(href)) score += 1;
  if (/logout|sign[\s_-]?out|登録|register|signup|sign[\s_-]?up/i.test(haystack)) score -= 5;
  return score;
}
