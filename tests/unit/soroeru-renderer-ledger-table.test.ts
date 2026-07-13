import test from "node:test";
import assert from "node:assert/strict";

import { buildLedgerColumns, disclosureFor } from "../../src/renderer/ledger-table.js";
import type { DisclosureView, SiteLedgerDetail } from "../../electron/ipc/contract.js";

function disclosure(attributeKey: string, label: string, preview = "value"): DisclosureView {
  return {
    disclosureId: `${attributeKey}-disclosure`,
    attributeKey,
    label,
    sensitivity: "normal",
    staleState: "current",
    sourceKind: "form-field",
    observedAt: 0,
    preview,
    revealable: false,
    evidenceCount: 0,
  };
}

function siteDetail(siteAccountId: string, disclosures: DisclosureView[]): SiteLedgerDetail {
  return {
    siteAccountId,
    domain: `${siteAccountId}.example`,
    displayName: siteAccountId,
    credentialCount: 1,
    disclosureCount: disclosures.length,
    stale: { current: disclosures.length, stale: 0, unknown: 0 },
    relationshipKinds: [],
    constraintCount: 0,
    collected: true,
    disclosures,
    relationships: [],
    constraints: [],
    pendingAttributeCandidates: [],
    credentials: [],
    sessionPersistence: { enabled: false, hasPersistedSession: false },
  };
}

test("buildLedgerColumns returns an empty list for no sites", () => {
  assert.deepEqual(buildLedgerColumns([]), []);
});

test("buildLedgerColumns unions heterogeneous per-site attribute sets without duplicates, sorted by label", () => {
  const sites = [
    siteDetail("amazon", [disclosure("email", "メール"), disclosure("phone.full", "電話")]),
    siteDetail("shop", [disclosure("phone.full", "電話"), disclosure("custom.occupation", "職業")]),
  ];

  assert.deepEqual(buildLedgerColumns(sites), [
    { attributeKey: "email", label: "メール" },
    { attributeKey: "custom.occupation", label: "職業" },
    { attributeKey: "phone.full", label: "電話" },
  ]);
});

test("disclosureFor returns the matching disclosure or undefined when the site lacks that attribute", () => {
  const site = siteDetail("amazon", [disclosure("email", "メール")]);
  assert.equal(disclosureFor(site, "email")?.attributeKey, "email");
  assert.equal(disclosureFor(site, "phone.full"), undefined);
});
