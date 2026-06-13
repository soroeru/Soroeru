// Fill execution: the only layer that touches decrypted profile values.
// Values are resolved locally (store -> transform -> element); they are never
// included in snapshots, prompts, or logs (RFC-001 v3 §6, §9).

import type { Page } from "playwright";
import { applyTransform } from "../profile.js";
import type { FormField, MappingEntry, ProfileKey } from "../types.js";

export interface FillContext {
  page: Page;
  fieldsById: Map<string, FormField>;
  /** Decrypt-on-demand accessor; CVV is read only at the moment it is filled. */
  getValue: (key: ProfileKey) => string | undefined;
  profileView: ReadonlyMap<ProfileKey, string>;
}

export interface FillOutcome {
  fieldId: string;
  fieldName: string;
  profileKey: ProfileKey;
  filledValue: string;
  ok: boolean;
}

export async function fillEntries(ctx: FillContext, entries: MappingEntry[]): Promise<FillOutcome[]> {
  const outcomes: FillOutcome[] = [];
  for (const entry of entries) {
    const field = ctx.fieldsById.get(entry.fieldId);
    if (!field) continue;
    const master = ctx.getValue(entry.profileKey);
    if (master === undefined) continue;
    const value = applyTransform(master, entry.transform, ctx.profileView);
    const ok = await fillOne(ctx.page, field, value);
    outcomes.push({
      fieldId: entry.fieldId,
      fieldName: field.name || field.id,
      profileKey: entry.profileKey,
      filledValue: value,
      ok,
    });
  }
  return outcomes;
}

async function fillOne(page: Page, field: FormField, value: string): Promise<boolean> {
  const locator = page.locator(`[data-af-id="${field.fieldId}"]`);
  try {
    if (field.tag === "select") {
      const options = field.options ?? [];
      const match =
        options.find((o) => o.value === value) ??
        options.find((o) => o.label === value) ??
        options.find((o) => o.label.includes(value) || value.includes(o.label));
      if (!match) return false;
      await locator.selectOption(match.value);
      return true;
    }
    if (field.type === "radio") {
      const options = field.options ?? [];
      const match =
        options.find((o) => o.value === value || o.label === value) ??
        options.find((o) => o.label.includes(value));
      if (!match?.afId) return false;
      await page.locator(`[data-af-id="${match.afId}"]`).check();
      return true;
    }
    await locator.fill(value);
    return true;
  } catch {
    return false;
  }
}

export async function setCheckbox(page: Page, fieldId: string, checked: boolean): Promise<void> {
  const locator = page.locator(`[data-af-id="${fieldId}"]`);
  if (checked) await locator.check();
  else await locator.uncheck();
}
