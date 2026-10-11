import { WallDetectionService } from "../src/automation/wall-detection.js";
import { classifyFields } from "../src/agent/classifier.js";
import { detectWall } from "../src/agent/walls.js";
import { scanInPage } from "../src/agent/scan.js";
import { structuralFingerprintInPage } from "../src/automation/collection-observation.js";
import { validateFormSchema, type FormSchema } from "../src/shared/cloud-contract.js";

export type { SchemaReadResult } from "../src/shared/schema-resolution.js";
import type { SchemaReadResult } from "../src/shared/schema-resolution.js";
export function schemaPageFingerprint(): string {
  const snapshot = { ...scanInPage(), url: location.href, title: document.title };
  if (detectWall(snapshot) || new WallDetectionService().detectTosProhibition(snapshot) || !document.body)
    throw new Error("wall-or-page-unavailable");
  const print = structuralFingerprintInPage(document.body);
  if (!print) throw new Error("page-too-large");
  return print;
}
/** Executes synchronously in the leased content script: validate first, read only accepted elements. */
export function readSchemaPage(schema: FormSchema): SchemaReadResult {
  validateFormSchema(schema);
  const snapshot = { ...scanInPage(), url: location.href, title: document.title };
  if (
    detectWall(snapshot) ||
    new WallDetectionService().detectTosProhibition(snapshot) ||
    !document.body ||
    schema.status !== "active" ||
    !(location.hostname === schema.site || location.hostname.endsWith("." + schema.site)) ||
    !schema.pageFingerprints.includes(structuralFingerprintInPage(document.body))
  )
    throw new Error("stale-schema-page");
  const result: SchemaReadResult = { values: [], unresolved: [] };
  const used = new Set<Element>();
  for (const mapping of schema.fields) {
    const selector = /^[fd]-/.test(mapping.anchor) ? `[data-af-id="${mapping.anchor}"]` : mapping.anchor;
    const elements = document.querySelectorAll(selector);
    const element = elements[0];
    if (elements.length !== 1 || !element) {
      result.unresolved.push({
        attributeKey: mapping.attributeKey,
        reason: elements.length > 1 ? "anchor-ambiguous" : "anchor-not-found",
      });
      continue;
    }
    const itemId = element.getAttribute("data-af-id") ?? "";
    const field = snapshot.fields.find((f) => f.fieldId === itemId);
    const display = snapshot.displayValues?.find((f) => f.valueId === itemId);
    const local =
      field ??
      (display
        ? {
            fieldId: display.valueId,
            tag: "input" as const,
            type: "text",
            name: "",
            id: "",
            autocomplete: "",
            required: false,
            placeholder: "",
            labels: [display.labelText],
            nearbyText: display.nearbyText,
          }
        : undefined);
    const classification = local ? classifyFields([local], []).entries[0] : undefined;
    // Require positive corroboration; unknown classifications never authorize a read.
    if (
      !local ||
      classification?.profileKey !== mapping.attributeKey ||
      classification.transform !== undefined ||
      schema.fields.filter((f) => f.attributeKey === mapping.attributeKey).length !== 1 ||
      used.has(element) ||
      (field && ["hidden", "checkbox", "radio"].includes(field.type)) ||
      /one-time-code/.test(local.autocomplete)
    ) {
      result.unresolved.push({ attributeKey: mapping.attributeKey, reason: "classifier-conflict" });
      continue;
    }
    used.add(element);
    const value =
      field &&
      (element instanceof HTMLInputElement ||
        element instanceof HTMLSelectElement ||
        element instanceof HTMLTextAreaElement)
        ? element.value
        : (element.textContent?.trim() ?? "");
    result.values.push({ attributeKey: mapping.attributeKey, itemId, value });
  }
  return result;
}
