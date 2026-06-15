// Existing-account import (#84): read personal data from a user-opened account
// settings/profile page, show candidates for review, and save only approved
// values into the encrypted local store. The mapper receives page structure
// only; raw extracted values stay local and are never sent to AI.

import type { Page } from "playwright";
import { PROFILE_FIELD_LABELS } from "../types.js";
import type { ProfileKey, SiteRecord } from "../types.js";
import { sha256Hex, type PocStore } from "../store/store.js";
import { maskValue } from "./gate.js";
import type { Mapper } from "./mapper.js";
import { snapshotPage, waitForFields } from "./scan.js";
import type { CustomFieldDef } from "./classifier.js";
import { nextActionForAccountState } from "./records.js";

export interface ImportCandidate {
  fieldId: string;
  label: string;
  profileKey: ProfileKey;
  value: string;
  maskedValue: string;
}

export interface ImportReviewDecision {
  approved: boolean;
  edits?: Record<string, string>;
}

export interface ImportResult {
  origin: string;
  siteId: string;
  serviceName: string;
  candidates: ImportCandidate[];
}

export function profileImportCustoms(store: PocStore): CustomFieldDef[] {
  return [...store.profile.values()]
    .filter((entry) => entry.key.startsWith("custom."))
    .map((entry) => ({ key: entry.key, matchTerms: entry.matchTerms ?? [entry.label] }));
}

export async function collectImportCandidates(page: Page, mapper: Mapper, customs: CustomFieldDef[] = []): Promise<ImportCandidate[]> {
  const snapshot = await waitForFields(page);
  const plan = await mapper.mapFields(snapshot, customs);
  const valuesByFieldId = await readFieldValues(page);
  const labelsByFieldId = new Map(
    snapshot.fields.map((field) => [
      field.fieldId,
      field.labels[0] || field.nearbyText || field.placeholder || field.name || field.id || field.fieldId,
    ]),
  );

  const seen = new Set<string>();
  const candidates: ImportCandidate[] = [];
  for (const entry of plan.entries) {
    if (entry.profileKey.startsWith("card.") || entry.profileKey === "account.password") continue;
    const value = valuesByFieldId[entry.fieldId]?.trim();
    if (!value) continue;
    const uniqueKey = `${entry.profileKey}:${value}`;
    if (seen.has(uniqueKey)) continue;
    seen.add(uniqueKey);
    candidates.push({
      fieldId: entry.fieldId,
      label: labelsByFieldId.get(entry.fieldId) ?? profileLabel(entry.profileKey),
      profileKey: entry.profileKey,
      value,
      maskedValue: maskValue(entry.profileKey, value),
    });
  }
  return candidates;
}

export async function runExistingAccountImport(
  page: Page,
  profileUrl: string,
  mapper: Mapper,
  store: PocStore,
): Promise<ImportResult> {
  await page.goto(profileUrl);
  await page.waitForLoadState();
  const candidates = await collectImportCandidates(page, mapper, profileImportCustoms(store));
  const snapshot = await snapshotPage(page);
  return {
    origin: new URL(snapshot.url).origin,
    siteId: new URL(snapshot.url).host,
    serviceName: (snapshot.title.split(" - ")[0] || new URL(snapshot.url).host).trim(),
    candidates,
  };
}

export async function saveImportedProfileValues(
  store: PocStore,
  importResult: ImportResult,
  decision: ImportReviewDecision,
  now: number = Date.now(),
): Promise<SiteRecord | undefined> {
  if (!decision.approved) return undefined;
  const approved = importResult.candidates
    .map((candidate) => ({ ...candidate, value: decision.edits?.[candidate.fieldId]?.trim() || candidate.value }))
    .filter((candidate) => candidate.value.length > 0);
  for (const candidate of approved) {
    store.setProfileValue(candidate.profileKey, candidate.label, candidate.value);
  }
  const record: SiteRecord = {
    origin: importResult.origin,
    siteId: importResult.siteId,
    serviceName: importResult.serviceName,
    registeredAt: now,
    filledFields: approved.map((candidate) => ({
      profileKey: candidate.profileKey,
      filledValueHash: sha256Hex(candidate.value),
      fieldName: candidate.label,
      filledAt: now,
    })),
    accountState: "imported",
    status: "registered",
    lastCheckedAt: now,
    nextAction: nextActionForAccountState("imported"),
  };
  store.upsertSiteRecord(record);
  await store.save();
  return record;
}

async function readFieldValues(page: Page): Promise<Record<string, string>> {
  return await page.evaluate(() => {
    const values: Record<string, string> = {};
    for (const el of Array.from(document.querySelectorAll("[data-af-id]"))) {
      const id = el.getAttribute("data-af-id");
      if (!id) continue;
      if (el instanceof HTMLInputElement) {
        if (el.type === "checkbox" || el.type === "radio") {
          if (el.checked) values[id] = el.value;
        } else {
          values[id] = el.value;
        }
      } else if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
        values[id] = el.value;
      }
    }
    return values;
  });
}

function profileLabel(key: ProfileKey): string {
  return key in PROFILE_FIELD_LABELS ? PROFILE_FIELD_LABELS[key as keyof typeof PROFILE_FIELD_LABELS] : key;
}
