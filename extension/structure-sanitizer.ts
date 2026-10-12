import { PROFILE_FIELD_LABELS, type PageSnapshot } from "../src/types.js";
import { validateCloudRequest, type StructureSnapshot } from "../src/shared/cloud-contract.js";

// Exact structural vocabulary: redaction alone cannot distinguish a person's name
// from a label. Unknown prose, display values and arbitrary name/id tokens are omitted.
const labels = new Set<string>([
  ...Object.values(PROFILE_FIELD_LABELS),
  "メール",
  "電話",
  "郵便",
  "お名前",
  "住所情報",
  "基本情報",
  "連絡先",
  "支払い情報",
  "アカウント情報",
]);
const tokens = new Set(
  "name first last full sei mei kana email mail phone tel postal zip address pref city street building company department birth year month day gender card number expiry holder cvv csc account login password user profile contact payment security".split(
    " ",
  ),
);
const types = new Set("text email tel number date password checkbox radio hidden search url".split(" "));
const autocomplete = new Set(
  "name given-name family-name additional-name email tel postal-code street-address address-line1 address-line2 address-line3 address-level1 address-level2 country country-name organization organization-title bday bday-day bday-month bday-year sex username current-password new-password one-time-code cc-name cc-given-name cc-family-name cc-number cc-exp cc-exp-month cc-exp-year cc-csc off on".split(
    " ",
  ),
);
export function sanitizedLabel(text: string): string | undefined {
  const redacted = text
    .normalize("NFKC")
    .replace(/[\w.+-]+@[\w.-]+|https?:\/\/\S+|\d[\d\s()-]*/gi, "[REDACTED]")
    .trim();
  return redacted.length <= 64 && labels.has(redacted) ? redacted : undefined;
}
export function sanitizeStructure(
  snapshot: PageSnapshot,
  site: string,
  pageFingerprint: string,
): StructureSnapshot {
  const items: StructureSnapshot["items"] = [];
  for (const field of snapshot.fields) {
    const label = field.labels.map(sanitizedLabel).find((v) => v !== undefined);
    const nameTokens = [
      ...new Set(
        (field.name + " " + field.id)
          .replace(/([a-z])([A-Z])/g, "$1 $2")
          .toLowerCase()
          .split(/[^a-z]+/)
          .filter((v) => tokens.has(v)),
      ),
    ];
    items.push({
      id: field.fieldId,
      tag: field.tag,
      nameTokens,
      ...(types.has(field.type) ? { type: field.type } : {}),
      ...(autocomplete.has(field.autocomplete) ? { autocomplete: field.autocomplete } : {}),
      ...(label ? { label } : {}),
    });
  }
  for (const display of snapshot.displayValues ?? []) {
    const label = sanitizedLabel(display.labelText);
    items.push({ id: display.valueId, tag: "dd", nameTokens: [], ...(label ? { label } : {}) });
  }
  const result: StructureSnapshot = { site, pageFingerprint, purposeHint: "unknown", items };
  validateCloudRequest("mapStructure", result);
  return result;
}
