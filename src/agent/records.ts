// Per-site record construction (REQ-006b / REQ-010). The automation layer fills
// values locally; the record keeps only a SHA-256 hash of each filled value
// (FilledFieldRecord.filledValueHash), never the raw value, so per-site
// inventory and bulk-update diffing work without duplicating sensitive data.

import { applyTransform } from "../profile.js";
import { sha256Hex, type PocStore } from "../store/store.js";
import type {
  AccountNextAction,
  AccountState,
  FilledFieldRecord,
  HighRiskFlag,
  ProfileKey,
  RegistrationMandate,
  RegistrationStatus,
  SiteRecord,
  Transform,
} from "../types.js";
import type { FillOutcome } from "./filler.js";
import type { PaymentAudit } from "./guards.js";

/**
 * Filled fields whose stored hash no longer matches the current master value
 * (bulk-update diff, §5). Used both by `runUpdate` to decide what to fix and
 * by the UI to show which sites need an update before launching a browser.
 */
export function staleFilledFields(store: PocStore, record: SiteRecord): FilledFieldRecord[] {
  const view = store.profileView();
  return record.filledFields.filter((ff) => {
    const master = store.getValue(ff.profileKey);
    if (master === undefined) return false;
    return sha256Hex(applyTransform(master, ff.transform, view)) !== ff.filledValueHash;
  });
}

export function accountStateFromRegistrationStatus(status: RegistrationStatus | "updated"): AccountState {
  switch (status) {
    case "registered":
    case "updated":
      return "registered";
    case "assistedFill":
    case "manualHandoff":
      return "registrationPending";
    case "declined":
      return "notRegistered";
    case "failed":
      return "updateFailed";
  }
}

export function nextActionForAccountState(state: AccountState): AccountNextAction {
  switch (state) {
    case "unknown":
    case "notRegistered":
      return "startRegistration";
    case "registrationPending":
      return "resumeRegistration";
    case "registered":
    case "imported":
      return "reviewInventory";
    case "updateNeeded":
      return "runUpdate";
    case "updateFailed":
      return "retryUpdate";
    case "withdrawalCandidate":
      return "prepareWithdrawal";
  }
}

export function deriveAccountState(record: SiteRecord, staleCount = 0): AccountState {
  if (record.accountState === "withdrawalCandidate") return "withdrawalCandidate";
  if (staleCount > 0 && (record.accountState === "registered" || record.accountState === "imported")) return "updateNeeded";
  return record.accountState ?? accountStateFromRegistrationStatus(record.status === "needsUpdate" ? "updated" : record.status);
}

export function applyAccountState(record: SiteRecord, state: AccountState, now: number = Date.now()): SiteRecord {
  record.accountState = state;
  record.lastCheckedAt = now;
  record.nextAction = nextActionForAccountState(state);
  if (state === "withdrawalCandidate") record.withdrawalCandidateAt = now;
  return record;
}

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
  result: RegistrationStatus | "updated";
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
