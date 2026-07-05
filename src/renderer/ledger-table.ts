// Pure column-building logic for the spreadsheet-style Disclosure ledger view
// (Issue #301). Kept free of React so it is unit-testable without a DOM. Each
// site can carry a different set of attributes (especially `custom.*` dynamic
// fields discovered per site), so the table's columns are the union of every
// attribute observed across all sites, not a fixed global schema.

import type { DisclosureView, SiteLedgerDetail } from "../../electron/ipc/contract.js";

export interface LedgerColumn {
  attributeKey: string;
  label: string;
}

/** Union of {attributeKey, label} across all sites' disclosures, sorted by label. */
export function buildLedgerColumns(sites: readonly SiteLedgerDetail[]): LedgerColumn[] {
  const labelByKey = new Map<string, string>();
  for (const site of sites) {
    for (const disclosure of site.disclosures) {
      if (!labelByKey.has(disclosure.attributeKey)) labelByKey.set(disclosure.attributeKey, disclosure.label);
    }
  }
  return [...labelByKey.entries()]
    .map(([attributeKey, label]) => ({ attributeKey, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** The disclosure a site carries for one attribute column, if any. */
export function disclosureFor(site: SiteLedgerDetail, attributeKey: string): DisclosureView | undefined {
  return site.disclosures.find((disclosure) => disclosure.attributeKey === attributeKey);
}
