// Pure column-building logic for the spreadsheet-style Disclosure ledger view
// (Issue #301). Kept free of React so it is unit-testable without a DOM.
// The comparison table intentionally exposes only attributes that are useful
// to compare across sites. Site-specific, password, and card disclosures stay
// in the complete per-site detail view.

import type { DisclosureView, SiteLedgerDetail } from "../../electron/ipc/contract.js";

export interface LedgerColumn {
  attributeKey: string;
  label: string;
}

export interface SiteDetailDisclosureGroup {
  label: "共通項目" | "認証・カード" | "その他";
  disclosures: DisclosureView[];
}

function isCommonProfileAttribute(attributeKey: string): boolean {
  return (
    attributeKey === "email" ||
    attributeKey.startsWith("phone.") ||
    attributeKey.startsWith("postal.") ||
    attributeKey.startsWith("address.") ||
    attributeKey.startsWith("name.")
  );
}

function isComparisonAttribute(attributeKey: string): boolean {
  return isCommonProfileAttribute(attributeKey) || attributeKey === "account.id";
}

const byLabel = (a: DisclosureView, b: DisclosureView): number => a.label.localeCompare(b.label, "ja");

function authenticationRank(attributeKey: string): number {
  if (attributeKey === "account.id") return 0;
  if (attributeKey === "account.password") return 1;
  if (attributeKey === "card.number") return 2;
  return 3;
}

/** Disclosed comparison attributes across all sites, de-duplicated and sorted by label. */
export function buildLedgerColumns(sites: readonly SiteLedgerDetail[]): LedgerColumn[] {
  const labelByKey = new Map<string, string>();
  for (const site of sites) {
    for (const disclosure of site.disclosures) {
      if (isComparisonAttribute(disclosure.attributeKey) && !labelByKey.has(disclosure.attributeKey)) {
        labelByKey.set(disclosure.attributeKey, disclosure.label);
      }
    }
  }
  return [...labelByKey.entries()]
    .map(([attributeKey, label]) => ({ attributeKey, label }))
    .sort((a, b) => a.label.localeCompare(b.label, "ja"));
}

/** Complete per-site disclosure list grouped in the PO-specified display order. */
export function buildSiteDetailDisclosureGroups(
  disclosures: readonly DisclosureView[],
): SiteDetailDisclosureGroup[] {
  const common = disclosures.filter((item) => isCommonProfileAttribute(item.attributeKey)).sort(byLabel);
  const authentication = disclosures
    .filter(
      (item) =>
        item.attributeKey === "account.id" ||
        item.attributeKey === "account.password" ||
        item.attributeKey.startsWith("card."),
    )
    .sort((a, b) => authenticationRank(a.attributeKey) - authenticationRank(b.attributeKey) || byLabel(a, b));
  const other = disclosures
    .filter((item) => !isCommonProfileAttribute(item.attributeKey) && !authentication.includes(item))
    .sort(byLabel);

  return [
    { label: "共通項目", disclosures: common },
    { label: "認証・カード", disclosures: authentication },
    { label: "その他", disclosures: other },
  ].filter((group) => group.disclosures.length > 0) as SiteDetailDisclosureGroup[];
}

/** The disclosure a site carries for one attribute column, if any. */
export function disclosureFor(site: SiteLedgerDetail, attributeKey: string): DisclosureView | undefined {
  return site.disclosures.find((disclosure) => disclosure.attributeKey === attributeKey);
}

/**
 * Default width for dynamic attribute columns (Issue #382).
 * Matches the previous implicit `min-w-[8rem]` baseline so fixed sticky columns
 * and horizontal scroll behavior stay familiar.
 */
export const LEDGER_ATTRIBUTE_COLUMN_DEFAULT_WIDTH_PX = 128;

/**
 * Combined width of sticky non-attribute columns (select + reorder + site + actions),
 * in CSS pixels assuming a 16px root (matches `styles.css` rem widths).
 */
export const LEDGER_FIXED_COLUMNS_WIDTH_PX = Math.round((2.5 + 2.75 + 14 + 16) * 16);

/** Total table width so fixed layout does not redistribute free space into attribute cols. */
export function ledgerTableWidthPx(
  attributeColumnCount: number,
  widths: Readonly<Record<string, number>>,
  attributeKeys: readonly string[],
  defaultWidthPx: number = LEDGER_ATTRIBUTE_COLUMN_DEFAULT_WIDTH_PX,
): number {
  let attributeSum = 0;
  if (attributeColumnCount === 0) {
    // Empty comparison set still needs room for the "未収集" placeholder cell.
    attributeSum = defaultWidthPx * 1.5;
  } else {
    for (const key of attributeKeys) {
      attributeSum += ledgerAttributeColumnWidthPx(widths, key, defaultWidthPx);
    }
  }
  return LEDGER_FIXED_COLUMNS_WIDTH_PX + attributeSum;
}

/** Resize floor: one third of the default width. */
export function ledgerAttributeColumnMinWidthPx(
  defaultWidthPx: number = LEDGER_ATTRIBUTE_COLUMN_DEFAULT_WIDTH_PX,
): number {
  return defaultWidthPx / 3;
}

/** Resize ceiling: three times the default width. */
export function ledgerAttributeColumnMaxWidthPx(
  defaultWidthPx: number = LEDGER_ATTRIBUTE_COLUMN_DEFAULT_WIDTH_PX,
): number {
  return defaultWidthPx * 3;
}

/**
 * Clamp a dragged attribute-column width to [default/3, default×3].
 * Non-finite inputs fall back to the default width.
 */
export function clampLedgerAttributeColumnWidth(
  widthPx: number,
  defaultWidthPx: number = LEDGER_ATTRIBUTE_COLUMN_DEFAULT_WIDTH_PX,
): number {
  if (!Number.isFinite(widthPx)) return defaultWidthPx;
  const min = ledgerAttributeColumnMinWidthPx(defaultWidthPx);
  const max = ledgerAttributeColumnMaxWidthPx(defaultWidthPx);
  return Math.min(max, Math.max(min, widthPx));
}

/** Resolved width for one attribute column, applying clamp when a stored value exists. */
export function ledgerAttributeColumnWidthPx(
  widths: Readonly<Record<string, number>>,
  attributeKey: string,
  defaultWidthPx: number = LEDGER_ATTRIBUTE_COLUMN_DEFAULT_WIDTH_PX,
): number {
  const stored = widths[attributeKey];
  if (stored === undefined) return defaultWidthPx;
  return clampLedgerAttributeColumnWidth(stored, defaultWidthPx);
}
