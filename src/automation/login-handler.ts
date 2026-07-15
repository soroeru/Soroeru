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

export type LoginFailureReason =
  | "login-page-not-found"
  | "login-form-not-found"
  /** A form was found but had no recognizable submit control; nothing was attempted. */
  | "login-not-submitted"
  | "login-failed";

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
    // Without a submit control nothing would ever be submitted; filling and
    // then judging the unchanged page would record a credential rejection
    // that never happened, so report the distinct reason before touching
    // any field.
    if (!form.submitSelector) return { success: false, error: "login-not-submitted" };

    // Step 4: fill and submit. Credential values are filled locally into the
    // page and never appear in a snapshot or an AI request.
    await page.fillField(form.usernameFieldId, credential.username);
    await page.fillField(form.passwordFieldId, credential.password);
    await page.click(form.submitSelector);
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

/**
 * Conservative positive signal that the current, already-loaded page belongs
 * to an authenticated session. Scanner snapshots contain visible controls
 * only, so an exact logout action is stronger than account/mypage wording.
 * Any credential-entry field wins: partial and multi-step login pages must
 * continue through the existing login flow.
 */
export function hasAuthenticatedSessionMarker(snapshot: PageSnapshot): boolean {
  if (hasLoginCredentialEntryField(snapshot)) return false;
  return [...snapshot.links, ...snapshot.buttons].some((control) => isLogoutAction(control.text));
}

function hasLoginCredentialEntryField(snapshot: PageSnapshot): boolean {
  if (findLoginField(snapshot.fields, "password")) return true;
  return snapshot.fields.some(
    (field) =>
      field.autocomplete === "username" ||
      /(?:^|[^a-z0-9])(?:user(?:name)?|login)(?:$|[^a-z0-9])/i.test(`${field.name} ${field.id}`),
  );
}

function isLogoutAction(text: string): boolean {
  const normalized = text.trim().replace(/\s+/g, " ");
  return /^(?:ログアウト|サインアウト)(?:する)?$|^(?:log|sign) out$/i.test(normalized);
}

/**
 * Detected third-party SSO login control on a login page (structure only).
 * Used only during the login stage — never as a wall signal (see Issue #351).
 */
export interface SsoLoginOption {
  provider: "google" | "apple" | "facebook" | "x" | "line" | "yahoo" | "other";
  /** Visible button/link label (no credentials or account identifiers). */
  label: string;
}

/** Login/continue wording that, with a provider name, marks an SSO control. */
const SSO_ACTION_RE = /ログイン|サインイン|続行|continue|sign[\s_-]?in|log[\s_-]?in/i;

/** Share / social engagement — must not be treated as SSO login. */
const SSO_NEGATIVE_RE = /シェア|\bshare\b|ツイート|\btweet\b|いいね|\blike\b|フォロー|\bfollow\b|ポスト|\bpost\b/i;

const SSO_PROVIDER_NAME_RE: Array<{
  provider: Exclude<SsoLoginOption["provider"], "other">;
  name: RegExp;
}> = [
  { provider: "google", name: /google|グーグル/i },
  { provider: "apple", name: /apple|アップル/i },
  { provider: "facebook", name: /facebook|フェイスブック|\bmeta\b/i },
  // "Xでログイン" / "Sign in with X" / Twitter — word-boundary so plain "x" in other words is skipped.
  { provider: "x", name: /\bx\b|twitter|ツイッター/i },
  { provider: "line", name: /\bline\b|ライン/i },
  { provider: "yahoo", name: /yahoo|ヤフー/i },
];

/** Href shapes that indicate an OAuth / IdP entry (design Issue #351). */
const OAUTH_HREF_RE = /oauth|openid/i;
const IDP_HOST_RE =
  /accounts\.google\.com|appleid\.apple\.com|facebook\.com|fb\.com|twitter\.com|(?:^|[/.])x\.com|line\.me|yahoo\.(?:co\.jp|com)/i;
const AUTH_PROVIDER_PATH_RE = /\/auth\/(google|facebook|twitter|line|apple|yahoo|x)\b/i;

/**
 * Deterministic SSO login-button/link detection for the login stage only.
 * Does not click, navigate to IdPs, or select accounts — detection only (Issue #351).
 */
export function findSsoLoginOptions(snapshot: PageSnapshot): SsoLoginOption[] {
  const byProvider = new Map<SsoLoginOption["provider"], SsoLoginOption>();

  const consider = (text: string, href: string | undefined): void => {
    const label = text.trim() || (href ? href.trim() : "");
    if (!label) return;
    if (SSO_NEGATIVE_RE.test(`${text} ${href ?? ""}`)) return;

    // Text: provider name × login/continue action (primary signal).
    const textHit = matchProviderFromText(text);
    if (textHit && SSO_ACTION_RE.test(text)) {
      if (!byProvider.has(textHit)) byProvider.set(textHit, { provider: textHit, label });
      return;
    }

    if (!href) return;

    // Href assist: known IdP hosts, /auth/<provider>, or oauth+provider — not bare social profile links.
    const hrefHit = matchProviderFromHref(href);
    if (hrefHit) {
      if (!byProvider.has(hrefHit)) byProvider.set(hrefHit, { provider: hrefHit, label });
      return;
    }
    // Generic oauth without a named provider → "other".
    if (OAUTH_HREF_RE.test(href)) {
      if (!byProvider.has("other")) byProvider.set("other", { provider: "other", label });
    }
  };

  for (const button of snapshot.buttons) {
    consider(button.text, undefined);
  }
  for (const link of snapshot.links) {
    consider(link.text, link.href);
  }

  return [...byProvider.values()];
}

function matchProviderFromText(text: string): Exclude<SsoLoginOption["provider"], "other"> | undefined {
  for (const entry of SSO_PROVIDER_NAME_RE) {
    if (entry.name.test(text)) return entry.provider;
  }
  return undefined;
}

/** Path tokens that indicate an auth/OAuth entry on an IdP host (not help/profile pages). */
const IDP_AUTH_PATH_RE = /\/(o\/oauth|oauth2?|openid|signin|ServiceLogin|login|auth|authorize)\b/i;

function matchProviderFromHref(href: string): Exclude<SsoLoginOption["provider"], "other"> | undefined {
  const auth = href.match(AUTH_PROVIDER_PATH_RE);
  if (auth) {
    const key = auth[1]!.toLowerCase();
    if (key === "twitter") return "x";
    return key as Exclude<SsoLoginOption["provider"], "other">;
  }
  // oauth/openid URL that also names a provider (query or path).
  if (OAUTH_HREF_RE.test(href)) {
    return matchProviderFromText(href);
  }
  // Known IdP host only when the path looks like auth (not a public profile/share/help URL).
  if (IDP_HOST_RE.test(href) && IDP_AUTH_PATH_RE.test(href)) {
    if (/accounts\.google/i.test(href)) return "google";
    if (/appleid\.apple/i.test(href)) return "apple";
    if (/facebook|fb\.com/i.test(href)) return "facebook";
    if (/twitter|\bx\.com\b/i.test(href)) return "x";
    if (/line\.me/i.test(href)) return "line";
    if (/yahoo\./i.test(href)) return "yahoo";
  }
  return undefined;
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
