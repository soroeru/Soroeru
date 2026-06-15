import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyPhaseTimings } from "../../src/agent/perf.js";
import { hasFailures, type VariantRunResult } from "../../run/measure.js";

function okResult(): VariantRunResult {
  return {
    variant: "deterministic",
    engine: "chromium",
    registration: [
      {
        siteId: "01-basic",
        status: "registered",
        registrationOk: true,
        mappedCorrect: 1,
        mappedWrong: 0,
        missed: 0,
        spurious: 0,
        gtTotal: 1,
        guardsOk: true,
        guardNotes: [],
        notes: [],
        phaseTimingsMs: emptyPhaseTimings(),
      },
    ],
    update: [
      { siteId: "01-basic", expected: "updated", actual: "updated", valuesOk: true, mandateOk: true, phaseTimingsMs: emptyPhaseTimings() },
    ],
    trialCardDeclinePathOk: true,
    wallDetectionOk: true,
    wallResumeFlowOk: true,
    successRate: 1,
    misMappingRate: 0,
  };
}

test("hasFailures is false when every safety-critical check passes", () => {
  assert.equal(hasFailures(okResult()), false);
});

test("hasFailures is true when a site's registration result fails", () => {
  const r = okResult();
  r.registration[0]!.registrationOk = false;
  assert.equal(hasFailures(r), true);
});

test("hasFailures is true when a guard check fails", () => {
  const r = okResult();
  r.registration[0]!.guardsOk = false;
  assert.equal(hasFailures(r), true);
});

test("hasFailures is true when a bulk-update value or mandate is wrong", () => {
  const valuesBad = okResult();
  valuesBad.update[0]!.valuesOk = false;
  assert.equal(hasFailures(valuesBad), true);

  const mandateBad = okResult();
  mandateBad.update[0]!.mandateOk = false;
  assert.equal(hasFailures(mandateBad), true);
});

test("hasFailures is true when the trial-card decline path or a wall check fails", () => {
  const decline = okResult();
  decline.trialCardDeclinePathOk = false;
  assert.equal(hasFailures(decline), true);

  const wallDetect = okResult();
  wallDetect.wallDetectionOk = false;
  assert.equal(hasFailures(wallDetect), true);

  const wallResume = okResult();
  wallResume.wallResumeFlowOk = false;
  assert.equal(hasFailures(wallResume), true);
});
