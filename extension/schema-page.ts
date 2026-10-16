import { sha256Hex } from "../src/shared/sha256.js";
import { sanitizeStructure, sanitizedLabel } from "./structure-sanitizer.js";
import { WallDetectionService } from "../src/automation/wall-detection.js";
import { classifyFields } from "../src/agent/classifier.js";
import { detectWall } from "../src/agent/walls.js";
import { scanInPage } from "../src/agent/scan.js";
import { structuralFingerprintInPage } from "../src/automation/collection-observation.js";
import { validateFormSchema, type FormSchema } from "../src/shared/cloud-contract.js";

export type { SchemaReadResult } from "../src/shared/schema-resolution.js";
import type { SchemaReadResult } from "../src/shared/schema-resolution.js";
let structureObservation:
  { url: string; fingerprint: string; observer: MutationObserver; invalidated: boolean } | undefined;
/** Wall, terms, and missing-document checks shared by fingerprint and Tier 3 reads. */
export function assertReadablePage(): void {
  const snapshot = { ...scanInPage(), url: location.href, title: document.title };
  if (detectWall(snapshot) || new WallDetectionService().detectTosProhibition(snapshot) || !document.body)
    throw new Error("wall-or-page-unavailable");
}
export function schemaPageFingerprint(): string {
  assertReadablePage();
  const print = structuralFingerprintInPage(document.body);
  if (!print) throw new Error("page-too-large");
  return print;
}
// Local-only identity: never sent as a Cloud fingerprint or persisted in Evidence.
let documentIdentity: string | undefined;
export function schemaPageObservation(leaseId: string, epoch: number): { fingerprint: string; identity: string } {
  if (!documentIdentity) {
    documentIdentity = crypto.randomUUID();
    const invalidate = (): void => { documentIdentity = crypto.randomUUID(); };
    addEventListener("pagehide", invalidate);
    addEventListener("pageshow", invalidate);
  }
  const fingerprint = schemaPageFingerprint();
  const values = Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input,textarea,select"))
    .map(element => [element.value, element instanceof HTMLInputElement ? element.checked : false]);
  return { fingerprint, identity: sha256Hex(JSON.stringify([
    documentIdentity, location.href, leaseId, epoch, fingerprint, document.body.innerText, values,
  ])) };
}
/** Executes synchronously in the leased content script: validate first, read only accepted elements. */
export function readSchemaPage(schema: FormSchema): SchemaReadResult {
  validateFormSchema(schema);
  const isStructureProposal = schema.status === "candidate" && schema.provenance === "gemini_structure";
  if (isStructureProposal) {
    const observed = structureObservation;
    if (
      !observed ||
      observed.invalidated ||
      observed.url !== location.href ||
      !schema.pageFingerprints.includes(observed.fingerprint) ||
      observed.observer.takeRecords().length
    )
      throw new Error("stale-structure-page");
    observed.observer.disconnect();
    structureObservation = undefined;
  }
  const snapshot = { ...scanInPage(), url: location.href, title: document.title };
  if (
    detectWall(snapshot) ||
    new WallDetectionService().detectTosProhibition(snapshot) ||
    !document.body ||
    (schema.status !== "active" && !isStructureProposal) ||
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

/** Sanitization happens inside the leased content script, before page data leaves it. */
export function structurePageSnapshot(site: string) {
  if (!(location.hostname === site || location.hostname.endsWith("." + site)))
    throw new Error("stale-schema-page");
  const pageFingerprint = schemaPageFingerprint();
  const snapshot = { ...scanInPage(), url: location.href, title: document.title };
  const result = sanitizeStructure(snapshot, site, pageFingerprint);
  for (const item of result.items) {
    const elements = document.querySelectorAll(`[data-af-id="${item.id}"]`);
    if (elements.length !== 1) throw new Error("ambiguous-structure-item");
    const element = elements[0]!;
    const tag = element.tagName.toLowerCase();
    if (["input", "select", "textarea", "dd", "td", "span", "div", "p", "output"].includes(tag))
      item.tag = tag;
    const heading = sanitizedLabel(
      element.closest("section, form, fieldset")?.querySelector("h1,h2,h3,legend")?.textContent ?? "",
    );
    if (heading) item.heading = heading;
    // No checked/selection state or secret shape. Unknown display values are
    // deliberately shape-less: they may be a password, token or CVV.
    if (
      item.id.startsWith("f-") &&
      element instanceof HTMLInputElement &&
      !["password", "hidden", "checkbox", "radio"].includes(element.type) &&
      !/password|one-time-code|cc-csc/.test(element.autocomplete)
    ) {
      const field = snapshot.fields.find((f) => f.fieldId === item.id);
      const key = field ? classifyFields([field], []).entries[0]?.profileKey : undefined;
      if (key && key !== "account.password" && key !== "card.cvv") {
        const value = element.value;
        item.valueShape = {
          length: Math.min(value.length, 65536),
          charClass: /^\d+$/.test(value)
            ? "digit"
            : /^[a-z]+$/i.test(value)
              ? "alpha"
              : /^[\u3040-\u30ff]+$/.test(value)
                ? "kana"
                : /^[\u4e00-\u9fff]+$/.test(value)
                  ? "kanji"
                  : "mixed",
        };
      }
    }
  }
  structureObservation?.observer.disconnect();
  const observed = {
    url: location.href,
    fingerprint: pageFingerprint,
    invalidated: false,
    observer: new MutationObserver(() => {
      observed.invalidated = true;
    }),
  };
  observed.observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
  structureObservation = observed;
  return result;
}
