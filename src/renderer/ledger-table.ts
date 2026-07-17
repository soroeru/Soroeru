// Pure column-building logic for the spreadsheet-style Disclosure ledger view
// (Issue #301). Kept free of React so it is unit-testable without a DOM. Each
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
