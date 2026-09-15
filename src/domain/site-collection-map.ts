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

/** Shape validation only; callers must still minimize coordinates and enforce site scope. */
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
          (object(locator, ["kind", "selector"]) && locator.kind === "css" && text(locator.selector)) ||
          (object(locator, ["kind", "fieldId"]) && locator.kind === "field-id" && text(locator.fieldId))
        );
      });
    })
  );
}
