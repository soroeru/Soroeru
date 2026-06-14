// PERF-001 (#18): phase-timing instrumentation. `slowPhaseNote` and
// `emptyPhaseTimings` carry only a phase name and a number — never profile
// values, page content, AI request payloads, or provider API keys.

import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyPhaseTimings, PHASES, slowPhaseNote, SLOW_PHASE_THRESHOLD_MS } from "../../poc/autofill-agent/src/agent/perf.js";

test("emptyPhaseTimings returns all 8 phases at zero", () => {
  const timings = emptyPhaseTimings();
  assert.deepEqual(Object.keys(timings).sort(), [...PHASES].sort());
  for (const phase of PHASES) assert.equal(timings[phase], 0);
});

test("slowPhaseNote returns undefined at or under the threshold", () => {
  for (const phase of PHASES) {
    assert.equal(slowPhaseNote(phase, 1000, 5000), undefined);
    assert.equal(slowPhaseNote(phase, 5000, 5000), undefined);
  }
});

test("slowPhaseNote returns a Japanese progress note over the threshold, for every phase", () => {
  for (const phase of PHASES) {
    const note = slowPhaseNote(phase, 7500, 5000);
    assert.ok(note);
    assert.match(note, /処理に時間がかかっています/);
    assert.match(note, /7\.5秒/);
    assert.match(note, /続行します/);
  }
});

test("slowPhaseNote defaults to SLOW_PHASE_THRESHOLD_MS when no threshold is passed", () => {
  assert.equal(slowPhaseNote("fill", SLOW_PHASE_THRESHOLD_MS), undefined);
  assert.ok(slowPhaseNote("fill", SLOW_PHASE_THRESHOLD_MS + 1));
});

test("slowPhaseNote contains no data beyond the phase label and the duration in seconds", () => {
  // Privacy (PRIV-001/PRIV-002, Claude review follow-up on #18): the note must
  // not leak page content, profile values, or anything other than a phase
  // name and a number.
  const note = slowPhaseNote("submit", 12345, 5000)!;
  assert.match(note, /^処理に時間がかかっています（送信: 12\.3秒）。このまま自動で続行します…$/);
});
