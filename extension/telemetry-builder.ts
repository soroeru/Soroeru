import {
  validateCloudRequest,
  type OutcomeEvent,
  type ErrorCategory,
  type SiteId,
  type FormId,
  type ClientVersion,
  type SchemaFingerprint,
} from "../src/shared/cloud-contract.js";

export type { OutcomeEvent, SiteId, FormId, ClientVersion, SchemaFingerprint };
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
  /** eTLD+1 of the site. Must be a `SiteId` branded value — rejects free-text at compile time. */
  siteId: SiteId;
  /** SHA-256 hash of the form (schemaId or pageFingerprint). Must be a `FormId` branded value. */
  formId: FormId;
  /** Schema version number. */
  schemaVersion: number;
  operationType: OperationType;
  resolutionTier: ResolutionTier;
  result: OutcomeResult;
  errorCategory: ErrorCategory;
  mappingConfidenceBucket: MappingConfidenceBucket;
  /** Semver string, e.g. "1.2.3". Must be a `ClientVersion` branded value. */
  clientVersion: ClientVersion;
  /** SHA-256 structural page fingerprint. Must be a `SchemaFingerprint` branded value. */
  schemaFingerprint: SchemaFingerprint;
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
    };
    // Validate immediately so invalid inputs are caught at construction time, not at send time.
    validateCloudRequest("outcome", event);
    return event;
  }
}
