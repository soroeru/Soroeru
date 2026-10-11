// Evidence redaction (RFC-002 §5.1): build audit Evidence that records only
// URL, timestamp, field label, field type, a MASKED snippet, and a normalized
// hash. Raw values, screenshots/pixels, full HTML, cookies, and tokens are
// never produced here.

import { sha256Hex } from "../shared/sha256.js";
import { normalizeValue } from "../domain/normalize.js";
import type { AddEvidenceInput } from "../domain/domain-service.js";

/**
 * Mask a value into a structure-only snippet: every alphanumeric / kana / kanji
 * character becomes "•", while separators (@ . - / _ space) are kept so the
 * shape (e.g. an email or phone) is recognizable without revealing content.
 */
export function maskSnippet(value: string): string {
  return value.replace(/[^\s@./_-]/gu, "•");
}

/** Normalized-value hash for audit/compare without storing the raw value. */
export function evidenceHash(attributeKey: string, value: string): string {
  const normalized = normalizeValue(attributeKey, value);
  return sha256Hex(`${attributeKey}:${normalized}`);
}

export interface ObservedFieldEvidence {
  siteAccountId: string;
  pageUrl: string;
  fieldLabel: string;
  fieldType: string;
  attributeKey: string;
  /** The raw observed value — used here ONLY to derive the mask and hash, never stored. */
  value: string;
  observedAt?: number;
}

/**
 * Build a redacted Evidence input from an observed field. The raw `value` is
 * consumed to produce the masked snippet and hash and is not placed on the
 * returned record.
 */
export function redactedEvidence(observed: ObservedFieldEvidence): AddEvidenceInput {
  const input: AddEvidenceInput = {
    siteAccountId: observed.siteAccountId,
    pageUrl: observed.pageUrl,
    fieldLabel: observed.fieldLabel,
    fieldType: observed.fieldType,
    maskedSnippet: maskSnippet(observed.value),
    normalizedHash: evidenceHash(observed.attributeKey, observed.value),
  };
  if (observed.observedAt !== undefined) input.observedAt = observed.observedAt;
  return input;
}
