// Value normalization + hashing for Disclosure stale-state derivation
// (RFC-002 §4.2). The stale-state of a Disclosure is derived by comparing the
// normalized hash of the site-held value with the normalized hash of the
// canonical Personal Attribute. Normalization absorbs cosmetic differences
// (spacing, separators, case) so "090-1234-5678" and "09012345678" compare
// equal, while still being a one-way hash so raw values are not duplicated.

import { sha256Hex } from "../shared/sha256.js";

/**
 * Normalize a value for comparison, keyed by attribute. Japanese-only domain
 * for the MVP; locale-specific normalization is intentionally minimal here.
 */
export function normalizeValue(attributeKey: string, value: string): string {
  const trimmed = value.trim();
  if (attributeKey === "email") return trimmed.toLowerCase();
  if (
    attributeKey.startsWith("phone") ||
    attributeKey.startsWith("postal") ||
    attributeKey.startsWith("card")
  ) {
    // Strip spaces and common separators from numeric identifiers.
    return trimmed.replace(/[\s\-()]/g, "");
  }
  // Collapse internal whitespace for free-text values (names, addresses).
  return trimmed.replace(/\s+/g, " ");
}

/**
 * Keyed, one-way hash of a normalized value, suitable for storing inside an
 * encrypted record for comparison/audit. The attribute key is mixed in so the
 * same value under different attributes does not collide.
 */
export function normalizedValueHash(attributeKey: string, value: string): string {
  return sha256Hex(`${attributeKey}:${normalizeValue(attributeKey, value)}`);
}
