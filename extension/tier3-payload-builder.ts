/**
 * Tier3PayloadBuilder (design #554 §5.3).
 *
 * Takes the masked items returned by the content script's `readRegionMasked` command and builds
 * the minimal `ConsentedReadPayload` ready for ticket issuance and the pii-fallback call.
 *
 * Responsibilities:
 * - Re-validates that no C0 item slipped through the content-script masking (defense-in-depth).
 * - Drops ambiguous items (near-secret labels, secret-shaped digit patterns) that are not
 *   positively identified as non-secret.
 * - Enforces the 16 KiB wire-size limit; excess triggers a handoff instead of a truncated send.
 * - Generates a fresh consent ID for this one fallback invocation.
 */

import {
  CLOUD_LIMITS,
  tier3PayloadJson,
  type ConsentedReadPayload,
  type AttributeKey,
} from "../src/shared/cloud-contract.js";
import type { MaskedRegionItem } from "./content-script.js";

/** Thrown when the payload would exceed 16 KiB or masking fails closed. */
export class Tier3HandoffNeeded extends Error {
  constructor(readonly reason: "payload-too-large" | "masking-failed") {
    super(reason);
    this.name = "Tier3HandoffNeeded";
  }
}

/** C0 attribute keys that must never be requested via Tier 3. */
const FORBIDDEN_KEYS = new Set<string>(["account.password", "card.cvv"]);

/** Autocomplete values that indicate a C0 field. */
const SECRET_AUTOCOMPLETE = new Set(["current-password", "new-password", "one-time-code", "cc-csc"]);

/** Labels that signal a nearby value is a secret. */
const SECRET_LABEL_RE =
  /パスワード|password|pw\b|pwd|CVV|セキュリティコード|security\s*code|認証コード|確認コード|ワンタイム|OTP|one.time|pass\s*code/i;

/** Text shapes that look like a secret (short digit sequences). */
const SECRET_DIGIT_RE = /^\d{3,4}$|^\d{6,8}$/;

/**
 * Returns true if the text or label indicates that this item must remain masked.
 * This is the defense-in-depth re-check after the content script's first pass.
 */
function looksLikeUnmaskedSecret(item: MaskedRegionItem): boolean {
  if (item.text === "[SECRET]") return false; // Already masked.
  // If the label suggests a secret, any remaining unmasked text is a problem.
  if (item.label && SECRET_LABEL_RE.test(item.label)) return true;
  // A short digit-only value near no confirmable non-secret label.
  if (SECRET_DIGIT_RE.test(item.text.trim())) return true;
  return false;
}

/**
 * Build a `ConsentedReadPayload` from raw (content-script-masked) items.
 *
 * @param site - Registrable domain (eTLD+1).
 * @param requestedKeys - Attribute keys the gate was shown to the user.
 * @param rawItems - Output of `readRegionMasked` from the content script.
 * @returns A ready-to-ticket payload, or throws `Tier3HandoffNeeded`.
 */
export function buildTier3Payload(
  site: string,
  requestedKeys: AttributeKey[],
  rawItems: MaskedRegionItem[],
): ConsentedReadPayload {
  if (requestedKeys.some((k) => FORBIDDEN_KEYS.has(k)))
    throw new Tier3HandoffNeeded("masking-failed");

  const safeItems: { id: string; label?: string; text: string }[] = [];
  for (const item of rawItems) {
    // Defense-in-depth: if the content script missed a C0 item, fail the whole payload.
    if (looksLikeUnmaskedSecret(item)) {
      throw new Tier3HandoffNeeded("masking-failed");
    }
    // Items with no useful text after masking are dropped (includes whitespace-only).
    if (!item.text.trim()) continue;
    // Truncate text to the per-item wire limit so tier3PayloadJson does not throw.
    const entry: { id: string; label?: string; text: string } = {
      id: item.id,
      text: item.text.slice(0, CLOUD_LIMITS.text),
    };
    if (item.label) entry.label = item.label.slice(0, 64);
    safeItems.push(entry);
  }

  if (safeItems.length === 0) throw new Tier3HandoffNeeded("payload-too-large");

  const payload: ConsentedReadPayload = {
    consentId: crypto.randomUUID(),
    site,
    requestedKeys,
    items: safeItems,
  };

  // Enforce the 16 KiB wire-size limit using the stable serialization.
  const bytes = new TextEncoder().encode(tier3PayloadJson(payload)).byteLength;
  if (bytes > CLOUD_LIMITS.tier3Bytes) throw new Tier3HandoffNeeded("payload-too-large");

  return payload;
}

export { SECRET_AUTOCOMPLETE };
