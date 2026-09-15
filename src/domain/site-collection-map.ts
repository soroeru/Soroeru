import type { SiteCollectionMap } from "./entities.js";

function object(value: unknown, keys: string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function timestamp(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function pageUrl(value: unknown): boolean {
  if (!text(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

// Positional CSS contains no page-provided attribute, id, class, or text values.
// Field IDs match the bounded local scanner coordinates (f-N / d-N), not DOM IDs.
function positionalSelector(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.length <= 2048 &&
    /^:root(?: > \*:nth-child\([1-9][0-9]{0,5}\)){1,64}$/.test(value)
  );
}
function scannerFieldId(value: unknown): boolean {
  return typeof value === "string" && /^[fd]-[1-9][0-9]{0,5}$/.test(value);
}

/** Shape/coordinate validation; producers must still minimize page routes and enforce site scope. */
export function isSiteCollectionMap(value: unknown): value is SiteCollectionMap {
  if (
    !object(value, [
      "id",
      "schemaVersion",
      "siteAccountId",
      "revision",
      "generationStatus",
      "provenance",
      "pages",
    ])
  )
    return false;
  if (
    !text(value.id) ||
    !text(value.siteAccountId) ||
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 1 ||
    !["candidate", "ready", "failed"].includes(value.generationStatus as string)
  )
    return false;
  const provenance = value.provenance;
  if (
    !object(provenance, ["kind", "observedAt"]) ||
    !["ai-driven", "user-confirmed"].includes(provenance.kind as string) ||
    !timestamp(provenance.observedAt)
  )
    return false;
  return (
    Array.isArray(value.pages) &&
    value.pages.every((page: unknown) => {
      if (
        !object(page, ["url", "purpose", "fingerprint", "items"]) ||
        !pageUrl(page.url) ||
        !["profile", "billing", "security", "notifications", "other"].includes(page.purpose as string) ||
        !text(page.fingerprint) ||
        !Array.isArray(page.items)
      )
        return false;
      return page.items.every((item: unknown) => {
        if (
          !object(item, ["attributeKey", "locator", "fingerprint"]) ||
          !text(item.attributeKey) ||
          !text(item.fingerprint)
        )
          return false;
        const locator = item.locator;
        return (
          (object(locator, ["kind", "selector"]) &&
            locator.kind === "css" &&
            positionalSelector(locator.selector)) ||
          (object(locator, ["kind", "fieldId"]) &&
            locator.kind === "field-id" &&
            scannerFieldId(locator.fieldId))
        );
      });
    })
  );
}
