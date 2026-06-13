// Per-site record construction (REQ-006b / REQ-010). The automation layer fills
// values locally; the record keeps only a SHA-256 hash of each filled value
// (FilledFieldRecord.filledValueHash), never the raw value, so per-site
// inventory and bulk-update diffing work without duplicating sensitive data.

import { sha256Hex } from "../store/store.js";
import type { FilledFieldRecord, ProfileKey, Transform } from "../types.js";
import type { FillOutcome } from "./filler.js";

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
