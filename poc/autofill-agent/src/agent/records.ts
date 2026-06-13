// Per-site record construction (REQ-006b / REQ-010). The automation layer fills
// values locally; the record keeps only a SHA-256 hash of each filled value
// (FilledFieldRecord.filledValueHash), never the raw value, so per-site
// inventory and bulk-update diffing work without duplicating sensitive data.

import { sha256Hex } from "../store/store.js";
import type {
  FilledFieldRecord,
  HighRiskFlag,
  ProfileKey,
  RegistrationMandate,
  RegistrationStatus,
  Transform,
} from "../types.js";
import type { FillOutcome } from "./filler.js";
import type { PaymentAudit } from "./guards.js";

/** Minimal planned-field shape needed to attach the transform to a record. */
export interface PlannedFieldRef {
  fieldName: string;
  profileKey: ProfileKey;
  transform?: Transform;
}

/**
 * Build FilledFieldRecords from fill outcomes. Only successful fills are
 * recorded, and only the hash of the filled value is stored — never the value.
 */
export function toFilledFieldRecords(
  outcomes: readonly FillOutcome[],
  planned: readonly PlannedFieldRef[],
  now: number = Date.now(),
): FilledFieldRecord[] {
  return outcomes
    .filter((o) => o.ok)
    .map((o) => {
      const plannedEntry = planned.find((p) => p.fieldName === o.fieldName && p.profileKey === o.profileKey);
      const rec: FilledFieldRecord = {
        profileKey: o.profileKey,
        filledValueHash: sha256Hex(o.filledValue),
        fieldName: o.fieldName,
        filledAt: now,
      };
      if (plannedEntry?.transform) rec.transform = plannedEntry.transform;
      return rec;
    });
}

export interface MandateInput {
  origin: string;
  submittedFieldKeys: ProfileKey[];
  termsUrl?: string;
  /** Raw terms text; hashed into termsVersionHash (never stored verbatim). */
  termsText?: string;
  highRiskFlags: HighRiskFlag[];
  attestationsApproved: string[];
  result: RegistrationStatus;
  audit: PaymentAudit;
}

/**
 * Build the authorization mandate (RFC-001 v3 §4). Records what the user
 * approved plus the payment-guard decision for audit; the terms text is stored
 * only as a hash, never verbatim, and no raw personal values are included.
 */
export function buildMandate(input: MandateInput, now: number = Date.now()): RegistrationMandate {
  const mandate: RegistrationMandate = {
    origin: input.origin,
    authorizedAt: now,
    submittedFieldKeys: input.submittedFieldKeys,
    highRiskFlags: input.highRiskFlags,
    attestationsApproved: input.attestationsApproved,
    result: input.result,
    paymentStopped: input.audit.paymentStopped,
    cardFilled: input.audit.cardFilled,
  };
  if (input.termsUrl) mandate.termsUrl = input.termsUrl;
  if (input.termsText) mandate.termsVersionHash = sha256Hex(input.termsText);
  if (input.audit.payment) mandate.payment = input.audit.payment;
  return mandate;
}
