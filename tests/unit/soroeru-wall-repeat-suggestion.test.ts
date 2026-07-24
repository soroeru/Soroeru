import assert from "node:assert/strict";
import { test } from "node:test";
import {
  handoffBudgetStoppedDetail,
  noteWallOccurrence,
  shouldSuggestSavedPageImport,
  WALL_REPEAT_SUGGEST_THRESHOLD,
  wallRepeatStoppedDetail,
  wallRepeatSuggestedDetail,
  type WallKind,
} from "../../src/automation/wall-repeat-suggestion.js";

test("noteWallOccurrence flags same-kind repeat at the threshold only", () => {
  const counts = new Map<WallKind, number>();
  const first = noteWallOccurrence(counts, "password-reset");
  assert.equal(first.count, 1);
  assert.equal(first.sameKindRepeat, false);

  const second = noteWallOccurrence(counts, "password-reset");
  assert.equal(second.count, WALL_REPEAT_SUGGEST_THRESHOLD);
  assert.equal(second.sameKindRepeat, true);

  const other = noteWallOccurrence(counts, "captcha");
  assert.equal(other.count, 1);
  assert.equal(other.sameKindRepeat, false);
});

test("shouldSuggestSavedPageImport is true for same-kind repeat or exhausted hand-off", () => {
  assert.equal(shouldSuggestSavedPageImport({ sameKindRepeat: false, handoffExhausted: false }), false);
  assert.equal(shouldSuggestSavedPageImport({ sameKindRepeat: true, handoffExhausted: false }), true);
  assert.equal(shouldSuggestSavedPageImport({ sameKindRepeat: false, handoffExhausted: true }), true);
});

test("wall-repeat detail strings stay structure-only for diagnostics", () => {
  assert.equal(
    wallRepeatSuggestedDetail("mfa", 2),
    "wall-repeat-suggest-saved-page: mfa x2",
  );
  assert.equal(
    wallRepeatStoppedDetail("password-reset", 3),
    "wall-repeat-auto-collect-stopped: manual-read-suggested: password-reset x3",
  );
  assert.equal(
    handoffBudgetStoppedDetail("mfa", 1),
    "handoff-budget-exhausted: manual-read-suggested: mfa x1",
  );
});
