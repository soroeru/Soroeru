// PageExplorer: the multi-page exploration loop of the Visibility flow
// (docs/design/visibility-exploration.md §3). Starting from the logged-in
// landing page it follows DecisionEngine-suggested profile/settings links,
// yields a structure-only snapshot per page for downstream collection
// (Phase 5), and pauses on a detected wall so the human can resolve it in the
// same session — never solving or bypassing it. Exploration state lives on the
// instance so `resume()` continues after the hand-off; that single resume slot
// is why sites are processed sequentially (design §known-constraints).

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
  /** URLs skipped on a wall, re-queued by `resume()` after the human clears it. */
  deferredUrls: string[];
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
    };
    yield* this.continueExploration(startSnapshot);
  }

  /**
   * Continue after the human resolved a wall (CAPTCHA / MFA / verification)
   * in the same browser session: deferred URLs are re-queued and re-visited.
   */
  async *resume(): AsyncGenerator<ExplorationEvent> {
    const state = this.currentState;
    if (!state) throw new Error("no exploration state to resume");
    state.pendingUrls.push(...state.deferredUrls);
    state.deferredUrls = [];
    yield* this.continueExploration();
  }

  /** The exploration loop shared by explore() and resume(). */
  private async *continueExploration(startSnapshot?: PageSnapshot): AsyncGenerator<ExplorationEvent> {
    const state = this.currentState;
    if (!state) throw new Error("no exploration state");
    const { pageDriver } = state;

    while (state.pendingUrls.length > 0) {
      const url = normalizeUrl(state.pendingUrls.shift()!);
      if (state.visitedUrls.has(url)) continue;
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
          // Not marked visited: resume() must re-visit this URL after the human
          // clears the wall, so it goes to deferredUrls instead.
          state.deferredUrls.push(url);
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
        if (!state.visitedUrls.has(normalized) && !state.pendingUrls.includes(normalized)) {
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
