import { validateCloudRequest, type OutcomeEvent, type ErrorCategory } from "../src/shared/cloud-contract.js";

export type { OutcomeEvent };
export type OperationType = OutcomeEvent["operationType"];
export type ResolutionTier = OutcomeEvent["resolutionTier"];
export type OutcomeResult = OutcomeEvent["result"];
export type MappingConfidenceBucket = OutcomeEvent["mappingConfidenceBucket"];

/**
 * Typed inputs for `TelemetryBuilder.build()`.
 * Every field is a closed enum, a number, or a known-format identifier (hash / semver / site).
 * No arbitrary strings; no user labels, values, or DOM content.
 */
export interface TelemetryInput {
  /** eTLD+1 of the site. */
  siteId: string;
  /** SHA-256 hash of the form (schemaId or pageFingerprint). */
  formId: string;
  /** Schema version number. */
  schemaVersion: number;
  operationType: OperationType;
  resolutionTier: ResolutionTier;
  result: OutcomeResult;
  errorCategory: ErrorCategory;
  mappingConfidenceBucket: MappingConfidenceBucket;
  /** Semver string, e.g. "1.2.3". */
  clientVersion: string;
  /** SHA-256 structural page fingerprint matched against the schema. */
  schemaFingerprint: string;
}

/**
 * Constructs `OutcomeEvent` objects for the `/v1/telemetry/outcome` endpoint.
 * Only `TelemetryBuilder` may build these events (§14.5, §15.3).
 * Inputs are enums, numbers, and known-format IDs; no free-text accepted.
 * The timestamp is truncated to the hour automatically.
 */
export class TelemetryBuilder {
  constructor(private readonly now: () => number = Date.now.bind(Date)) {}

  build(input: TelemetryInput): OutcomeEvent {
    const hourMs = Math.floor(this.now() / 3600000) * 3600000;
    const event: OutcomeEvent = {
      siteId: input.siteId,
      formId: input.formId,
      schemaVersion: input.schemaVersion,
      operationType: input.operationType,
      resolutionTier: input.resolutionTier,
      result: input.result,
      errorCategory: input.errorCategory,
      mappingConfidenceBucket: input.mappingConfidenceBucket,
      clientVersion: input.clientVersion,
      schemaFingerprint: input.schemaFingerprint,
      occurredAt: new Date(hourMs).toISOString(),
      // Client-generated key used as BigQuery insertId for deduplication on retry.
      idempotencyKey: crypto.randomUUID(),
    };
    // Validate immediately so invalid inputs are caught at construction time, not at send time.
    validateCloudRequest("outcome", event);
    return event;
  }

  /** User-settings boundary: disabled sharing produces no event. */
  buildWhenEnabled(input: TelemetryInput, telemetryEnabled: boolean): OutcomeEvent | null {
    return telemetryEnabled ? this.build(input) : null;
  }
}
