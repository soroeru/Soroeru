// PageExplorer: the multi-page exploration loop of the Visibility flow
// (docs/architecture.md#resolution-and-validation). Starting from the logged-in
// landing page it follows DecisionEngine-suggested profile/settings links,
// yields a structure-only snapshot per page for downstream collection
// (Phase 5), and pauses on a detected wall so the human can resolve it in the
// same session — never solving or bypassing it. Exploration state lives on the
// instance so `resume()` continues after the hand-off; that single resume slot
// is why sites are processed sequentially (design §known-constraints).
//
// Issue #420: after a wall hand-off is resolved, `resume()` observes the
// user's current page rather than re-navigating to the walled URL. Machine
// re-navigation to the same URL would re-trigger the site's risk gate (bot
// detection), looping the hand-off. The user already navigated past the wall
// in the headed session; the agent reads what is visible — the existing
// detect-and-hand-off principle, now applied to the exploration resume path.

import type { PageSnapshot, WallDetection } from "../types.js";
import type { DecisionContext, DecisionEngine } from "./decision-engine.js";
import type { PageDriver } from "./page-driver.js";
import { isSameSite, normalizeUrl } from "./url-utils.js";
import type { WallDetectionService } from "./wall-detection.js";

/** Hand-off descriptor for a wall the human must resolve (never bypassed). */
export interface ExplorationHandoff {
  reason: WallDetection["kind"];
  evidence: string;
  /** Always true: the paused state is kept and `resume()` continues it. */
  resumable: true;
}

export type ExplorationEvent =
  | { kind: "navigating"; url: string }
  | { kind: "wall-detected"; url: string; wall: WallDetection; handoff: ExplorationHandoff }
  /** Structure-only snapshot; Phase 5 collection reads values separately. */
  | { kind: "page-snapshot"; url: string; snapshot: PageSnapshot }
  | { kind: "exploration-complete"; reason: "decision-engine" | "no-more-urls" };

interface ExplorationState {
  siteAccount: { id: string; domain: string; displayName: string };
  /**
   * The page being explored (logged-in session). Passed to `explore` rather
   * than the constructor because the orchestrator opens a fresh driver per
   * site; resume must continue on the same driver the wall was detected on.
   */
  pageDriver: PageDriver;
  /** Normalized URLs already collected (never re-visited). */
  visitedUrls: Set<string>;
  /** Normalized URLs queued for exploration, in priority order. */
  pendingUrls: string[];
  /**
   * URLs where a wall was observed on the *current* page and exploration
   * paused. Cleared on each `resume()` attempt; not used to re-navigate.
   */
  deferredUrls: string[];
  /**
   * Issue #420: normalized URLs that machine `goto` must never re-attempt
   * after a wall (including via later link rediscovery). Distinct from
   * `visitedUrls` so a human-resolved current page at a formerly walled URL
   * can still be collected without a machine re-navigation.
   */
  blockedUrls: Set<string>;
}

export class PageExplorer {
  /** Exploration state, kept across a wall hand-off so `resume()` can continue. */
  private currentState: ExplorationState | null = null;

  constructor(
    private readonly decisionEngine: DecisionEngine,
    private readonly wallDetector: WallDetectionService,
  ) {}

  async *explore(
    pageDriver: PageDriver,
    startUrl: string,
    siteAccount: { id: string; domain: string; displayName: string },
    startSnapshot?: PageSnapshot,
  ): AsyncGenerator<ExplorationEvent> {
    this.currentState = {
      siteAccount: { id: siteAccount.id, domain: siteAccount.domain, displayName: siteAccount.displayName },
      pageDriver,
      visitedUrls: new Set(),
      pendingUrls: [normalizeUrl(startUrl)],
      deferredUrls: [],
      blockedUrls: new Set(),
    };
    yield* this.continueExploration(startSnapshot);
  }

  /**
   * Continue after the human resolved a wall (CAPTCHA / MFA / verification)
   * in the same browser session.
   *
   * Issue #420: instead of re-navigating to the walled URL (which would
   * re-trigger the site's risk gate), observe the page the user is currently
   * on. The deferred (walled) URLs are dropped — machine re-navigation to
   * them is what caused the loop in the first place. If the user's current
   * page is same-site and wall-free, it is collected and exploration
   * continues from there; otherwise exploration falls through to the
   * remaining pending URLs (if any) or completes.
   */
  async *resume(): AsyncGenerator<ExplorationEvent> {
    const state = this.currentState;
    if (!state) throw new Error("no exploration state to resume");
    const { pageDriver } = state;

    // Issue #420: drop deferred (walled) URLs — re-navigating to them would
    // re-trigger the same bot detection that caused the wall. The user has
    // already navigated past the wall in the headed session.
    state.deferredUrls = [];

    // Observe the user's current page instead of re-navigating.
    const currentUrl = pageDriver.currentUrl();
    const normalizedCurrentUrl = normalizeUrl(currentUrl);

    // Safety: only collect when the visible page is same-site, http(s)-safe,
    // and not already visited. Off-site / non-local http / already-visited
    // pages are skipped before snapshotting — exploration falls through to
    // remaining pending URLs.
    if (
      isCollectableResumeUrl(currentUrl, state.siteAccount.domain) &&
      !state.visitedUrls.has(normalizedCurrentUrl)
    ) {
      const currentSnapshot = await pageDriver.snapshot();
      const wall = this.wallDetector.detect(currentSnapshot);
      if (wall) {
        // The user's current page itself still has a wall (they may not have
        // fully cleared it). Re-defer and hand off again, without a goto().
        state.deferredUrls.push(normalizedCurrentUrl);
        state.blockedUrls.add(normalizedCurrentUrl);
        yield {
          kind: "wall-detected",
          url: normalizedCurrentUrl,
          wall,
          handoff: { reason: wall.kind, evidence: wall.evidence, resumable: true },
        };
        return;
      }

      // Current page is collectable — yield it as a snapshot.
      // (Allowed even if this URL is in blockedUrls: the human is already here.)
      state.visitedUrls.add(normalizedCurrentUrl);
      yield { kind: "page-snapshot", url: normalizedCurrentUrl, snapshot: currentSnapshot };

      // Discover links from the current page for further exploration.
      const linkDecision = await this.decisionEngine.decide({
        kind: "find-profile-links",
        snapshot: currentSnapshot,
        context: this.buildContext(state, normalizedCurrentUrl),
      });
      for (const link of linkDecision.result.links) {
        if (!isSameSite(link.href, state.siteAccount.domain)) continue;
        const normalized = normalizeUrl(link.href);
        if (
          !state.visitedUrls.has(normalized) &&
          !state.blockedUrls.has(normalized) &&
          !state.pendingUrls.includes(normalized)
        ) {
          state.pendingUrls.push(normalized);
        }
      }

      // Check whether exploration should continue.
      const continueDecision = await this.decisionEngine.decide({
        kind: "should-continue",
        snapshot: currentSnapshot,
        context: this.buildContext(state, normalizedCurrentUrl),
      });
      if (!continueDecision.result.continue) {
        this.currentState = null;
        yield { kind: "exploration-complete", reason: "decision-engine" };
        return;
      }
    }

    // Continue with any remaining pending URLs via the normal exploration loop.
    // (Does not re-queue the previously walled URL.)
    yield* this.continueExploration();
  }

  /** The exploration loop shared by explore() and resume(). */
  private async *continueExploration(startSnapshot?: PageSnapshot): AsyncGenerator<ExplorationEvent> {
    const state = this.currentState;
    if (!state) throw new Error("no exploration state");
    const { pageDriver } = state;

    while (state.pendingUrls.length > 0) {
      const url = normalizeUrl(state.pendingUrls.shift()!);
      // Issue #420: never machine-navigate to a URL that already hit a wall.
      if (state.visitedUrls.has(url) || state.blockedUrls.has(url)) continue;
      let snapshot: PageSnapshot;

      yield { kind: "navigating", url };
      // egress: target-site — pendingUrls holds only the caller-provided start
      // URL and links that passed the isSameSite check in the queueing loop.
      if (state.visitedUrls.size === 0 && startSnapshot && normalizeUrl(startSnapshot.url) === url) {
        state.visitedUrls.add(url);
        snapshot = startSnapshot;
        yield { kind: "page-snapshot", url, snapshot };
      } else {
        await pageDriver.goto(url);
        await pageDriver.waitForReady();
        snapshot = await pageDriver.snapshot();
        const wall = this.wallDetector.detect(snapshot);
        if (wall) {
          // Not marked visited (resume may still collect if the human is on
          // this URL wall-free). Block machine re-navigation permanently.
          state.deferredUrls.push(url);
          state.blockedUrls.add(url);
          yield {
            kind: "wall-detected",
            url,
            wall,
            handoff: { reason: wall.kind, evidence: wall.evidence, resumable: true },
          };
          // Pause here; state stays on the instance until the caller resumes.
          return;
        }
        state.visitedUrls.add(url);
        yield { kind: "page-snapshot", url, snapshot };
      }

      const linkDecision = await this.decisionEngine.decide({
        kind: "find-profile-links",
        snapshot,
        context: this.buildContext(state, url),
      });
      for (const link of linkDecision.result.links) {
        // The rule path already filters off-site links, but the decision may
        // also come from the optional AI engine — the site boundary is enforced
        // here, at the point that feeds navigation, not trusted from upstream.
        if (!isSameSite(link.href, state.siteAccount.domain)) continue;
        const normalized = normalizeUrl(link.href);
        if (
          !state.visitedUrls.has(normalized) &&
          !state.blockedUrls.has(normalized) &&
          !state.pendingUrls.includes(normalized)
        ) {
          state.pendingUrls.push(normalized);
        }
      }

      const continueDecision = await this.decisionEngine.decide({
        kind: "should-continue",
        snapshot,
        context: this.buildContext(state, url),
      });
      if (!continueDecision.result.continue) {
        this.currentState = null;
        yield { kind: "exploration-complete", reason: "decision-engine" };
        return;
      }
    }

    this.currentState = null;
    yield { kind: "exploration-complete", reason: "no-more-urls" };
  }

  private buildContext(state: ExplorationState, currentUrl: string): DecisionContext {
    return {
      currentUrl,
      visitedUrls: [...state.visitedUrls],
      siteAccount: { domain: state.siteAccount.domain, displayName: state.siteAccount.displayName },
    };
  }
}

/**
 * Whether a resume-time current URL is safe to collect from without navigation.
 * Same-site HTTPS is the production case; the plain-http scheme on localhost
 * / 127.0.0.1 is allowed for local PoC fixtures. Other schemes/hosts are skipped.
 */
function isCollectableResumeUrl(url: string, domain: string): boolean {
  if (!isSameSite(url, domain)) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:") return true;
    if (
      parsed.protocol === "http:" &&
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
