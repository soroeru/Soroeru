import test from "node:test";
import assert from "node:assert/strict";
import {
  TelemetryBuilder,
  type TelemetryInput,
  type SiteId,
  type FormId,
  type ClientVersion,
  type SchemaFingerprint,
} from "../../extension/telemetry-builder.js";
import { CloudContractError } from "../../src/shared/cloud-contract.js";

const hash = "a".repeat(64);

// Branded-type casts are explicit and intentional: the runtime validator in
// TelemetryBuilder.build() is the enforcement gate.  The brands prevent
// accidental assignment of arbitrary strings at other call sites.
const validInput: TelemetryInput = {
  siteId: "example.com" as SiteId,
  formId: hash as FormId,
  schemaVersion: 1,
  operationType: "read" as const,
  resolutionTier: "local_only" as const,
  result: "success" as const,
  errorCategory: "unknown" as const,
  mappingConfidenceBucket: "high" as const,
  clientVersion: "1.2.3" as ClientVersion,
  schemaFingerprint: hash as SchemaFingerprint,
};

test("TelemetryBuilder truncates timestamp to the hour", () => {
  const minuteOffset = 37 * 60 * 1000 + 23 * 1000 + 456;
  const baseHour = 1700000000000 - (1700000000000 % 3600000);
  const now = baseHour + minuteOffset;
  const builder = new TelemetryBuilder(() => now);
  const event = builder.build(validInput);
  assert.equal(event.occurredAt, new Date(baseHour).toISOString());
  assert.match(event.occurredAt, /T\d{2}:00:00\.000Z$/);
});

test("TelemetryBuilder produces a valid OutcomeEvent from typed inputs", () => {
  const builder = new TelemetryBuilder();
  const event = builder.build(validInput);
  assert.equal(event.siteId, "example.com");
  assert.equal(event.formId, hash);
  assert.equal(event.operationType, "read");
  assert.equal(event.resolutionTier, "local_only");
  assert.equal(event.result, "success");
  assert.equal(event.errorCategory, "unknown");
  assert.equal(event.mappingConfidenceBucket, "high");
  assert.equal(event.clientVersion, "1.2.3");
  assert.equal(event.schemaFingerprint, hash);
  // occurredAt must be hour-truncated ISO8601
  assert.match(event.occurredAt, /^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/);
});

test("TelemetryBuilder throws CloudContractError for siteId with path (no URL paths allowed)", () => {
  const builder = new TelemetryBuilder();
  // The cast exercises the runtime validator; the brand alone does not prevent invalid values.
  assert.throws(
    () => builder.build({ ...validInput, siteId: "example.com/path" as SiteId }),
    CloudContractError,
  );
});

test("TelemetryBuilder throws CloudContractError for free-text formId (must be hash)", () => {
  const builder = new TelemetryBuilder();
  assert.throws(
    () => builder.build({ ...validInput, formId: "free-text-value" as FormId }),
    CloudContractError,
  );
});

test("TelemetryBuilder throws CloudContractError for invalid clientVersion", () => {
  const builder = new TelemetryBuilder();
  assert.throws(
    () => builder.build({ ...validInput, clientVersion: "not-semver" as ClientVersion }),
    CloudContractError,
  );
});

test("TelemetryBuilder throws CloudContractError for personal-looking siteId (email address)", () => {
  const builder = new TelemetryBuilder();
  // Email addresses must be rejected by the site() validator (@ character)
  assert.throws(
    () => builder.build({ ...validInput, siteId: "fake@example.com" as SiteId }),
    CloudContractError,
  );
});

test("TelemetryBuilder throws for schemaVersion below minimum", () => {
  const builder = new TelemetryBuilder();
  assert.throws(() => builder.build({ ...validInput, schemaVersion: -1 }), CloudContractError);
});

test("TelemetryBuilder rejects invalid resolutionTier enum value", () => {
  const builder = new TelemetryBuilder();
  assert.throws(
    () => builder.build({ ...validInput, resolutionTier: "unknown_tier" as never }),
    CloudContractError,
  );
});
