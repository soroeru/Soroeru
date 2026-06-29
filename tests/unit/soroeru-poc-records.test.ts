// REQ-006b (#12): per-site records keep only a hash of each filled value, never
// the raw value. The fill/submit flow runs in the automation layer; this pins
// the record-construction invariant that flow depends on.

import assert from "node:assert/strict";
import { test } from "node:test";
import { toFilledFieldRecords } from "../../src/agent/records.js";
import { sha256Hex } from "../../src/store/store.js";
import type { FillOutcome } from "../../src/agent/filler.js";

function outcome(partial: Partial<FillOutcome> & { fieldId: string }): FillOutcome {
  return {
    fieldName: partial.fieldId,
    profileKey: "email",
    filledValue: "dummy@example.com",
    ok: true,
    ...partial,
  };
}

test("records store the value hash, not the raw value", () => {
  const recs = toFilledFieldRecords(
    [outcome({ fieldId: "a", profileKey: "email", filledValue: "dummy@example.com" })],
    [{ fieldName: "a", profileKey: "email" }],
    1000,
  );
  assert.equal(recs.length, 1);
  assert.equal(recs[0]!.filledValueHash, sha256Hex("dummy@example.com"));
  assert.equal(recs[0]!.filledAt, 1000);
  // No property on the record holds the raw value.
  assert.ok(!Object.values(recs[0]!).includes("dummy@example.com"));
});

test("only successful fills are recorded", () => {
  const recs = toFilledFieldRecords(
    [
      outcome({ fieldId: "a", ok: true }),
      outcome({ fieldId: "b", ok: false }),
    ],
    [
      { fieldName: "a", profileKey: "email" },
      { fieldName: "b", profileKey: "email" },
    ],
  );
  assert.equal(recs.length, 1);
  assert.equal(recs[0]!.fieldName, "a");
});

test("the transform is carried onto the record for split fields", () => {
  const recs = toFilledFieldRecords(
    [outcome({ fieldId: "zip", profileKey: "postal.full", filledValue: "100" })],
    [{ fieldName: "zip", profileKey: "postal.full", transform: "postal3" }],
  );
  assert.equal(recs[0]!.transform, "postal3");
  assert.equal(recs[0]!.filledValueHash, sha256Hex("100"));
});

test("a card value (when an approved trial fills it) is hashed like any other", () => {
  const recs = toFilledFieldRecords(
    [outcome({ fieldId: "cc", profileKey: "card.number", filledValue: "4111111111111111" })],
    [{ fieldName: "cc", profileKey: "card.number" }],
  );
  assert.equal(recs[0]!.filledValueHash, sha256Hex("4111111111111111"));
  assert.ok(!Object.values(recs[0]!).includes("4111111111111111"));
});
