import { BigQuery } from "@google-cloud/bigquery";
import type { OutcomeEvent } from "../../src/shared/cloud-contract.js";

export interface TelemetryWriter {
  insert(event: OutcomeEvent): Promise<void>;
}

/**
 * BigQuery table schema matching §15.3 exactly.
 * All fields required; no free-text column; no client id / IP / URL path.
 */
export const OUTCOME_TELEMETRY_SCHEMA = [
  { name: "siteId", type: "STRING", mode: "REQUIRED" },
  { name: "formId", type: "STRING", mode: "REQUIRED" },
  { name: "schemaVersion", type: "INTEGER", mode: "REQUIRED" },
  { name: "operationType", type: "STRING", mode: "REQUIRED" },
  { name: "resolutionTier", type: "STRING", mode: "REQUIRED" },
  { name: "result", type: "STRING", mode: "REQUIRED" },
  { name: "errorCategory", type: "STRING", mode: "REQUIRED" },
  { name: "mappingConfidenceBucket", type: "STRING", mode: "REQUIRED" },
  { name: "clientVersion", type: "STRING", mode: "REQUIRED" },
  { name: "schemaFingerprint", type: "STRING", mode: "REQUIRED" },
  { name: "occurredAt", type: "TIMESTAMP", mode: "REQUIRED" },
] as const;

/** Field names in the BigQuery telemetry table. */
export type OutcomeTelemetryFieldName = (typeof OUTCOME_TELEMETRY_SCHEMA)[number]["name"];

export class BigQueryTelemetryWriter implements TelemetryWriter {
  private readonly bq: BigQuery;
  constructor(
    private readonly projectId: string,
    private readonly dataset: string,
    private readonly table: string,
    bq?: BigQuery,
  ) {
    this.bq = bq ?? new BigQuery({ projectId });
  }
  async insert(event: OutcomeEvent): Promise<void> {
    // Only the fixed §15.3 fields are inserted; no client id, IP, URL path, label, value, or DOM.
    await this.bq
      .dataset(this.dataset)
      .table(this.table)
      .insert([
        {
          siteId: event.siteId,
          formId: event.formId,
          schemaVersion: event.schemaVersion,
          operationType: event.operationType,
          resolutionTier: event.resolutionTier,
          result: event.result,
          errorCategory: event.errorCategory,
          mappingConfidenceBucket: event.mappingConfidenceBucket,
          clientVersion: event.clientVersion,
          schemaFingerprint: event.schemaFingerprint,
          occurredAt: event.occurredAt,
        },
      ]);
  }
}
