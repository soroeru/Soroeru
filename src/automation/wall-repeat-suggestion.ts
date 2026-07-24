// Issue #421: when the same wall kind keeps recurring in one Visibility site
// run, stop silent max-handoff dead-ends and point the user at the saved-page /
// "read the page you opened" path instead of implying another wall solve will help.

import type { WallDetection } from "../types.js";

export type WallKind = WallDetection["kind"];

/** Suggest the manual/saved-page path on the Nth observation of the same wall kind. */
export const WALL_REPEAT_SUGGEST_THRESHOLD = 2;

/**
 * Stable Constraint / checkpoint marker for diagnostics (collection-failure
 * analysis). UI copy lives in the renderer; this string is structure-only.
 * Used only when the same wall kind repeated before auto-collect stopped.
 */
export const WALL_REPEAT_STOPPED_DETAIL =
  "wall-repeat-auto-collect-stopped: manual-read-suggested" as const;

/**
 * Budget / no-handoff exhaustion without a same-kind repeat — still points the
 * user at the manual/saved-page path, but keeps diagnostics distinct from
 * same-kind wall-repeat stops.
 */
export const HANDOFF_BUDGET_STOPPED_DETAIL =
  "handoff-budget-exhausted: manual-read-suggested" as const;

/** Soft observation: we suggested the alternate path while still paused at a wall. */
export const WALL_REPEAT_SUGGESTED_DETAIL_PREFIX = "wall-repeat-suggest-saved-page" as const;

export function noteWallOccurrence(
  counts: Map<WallKind, number>,
  kind: WallKind,
): { count: number; sameKindRepeat: boolean } {
  const count = (counts.get(kind) ?? 0) + 1;
  counts.set(kind, count);
  return {
    count,
    sameKindRepeat: count >= WALL_REPEAT_SUGGEST_THRESHOLD,
  };
}

export function shouldSuggestSavedPageImport(input: {
  sameKindRepeat: boolean;
  /** True when this wall cannot be handed off further (cap reached or no callback). */
  handoffExhausted: boolean;
}): boolean {
  return input.sameKindRepeat || input.handoffExhausted;
}

export function wallRepeatSuggestedDetail(kind: WallKind, count: number): string {
  return `${WALL_REPEAT_SUGGESTED_DETAIL_PREFIX}: ${kind} x${count}`;
}

export function wallRepeatStoppedDetail(kind: WallKind, count: number): string {
  return `${WALL_REPEAT_STOPPED_DETAIL}: ${kind} x${count}`;
}

export function handoffBudgetStoppedDetail(kind: WallKind, count: number): string {
  return `${HANDOFF_BUDGET_STOPPED_DETAIL}: ${kind} x${count}`;
}
