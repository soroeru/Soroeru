import test from "node:test";
import assert from "node:assert/strict";

import {
  buildLedgerColumns,
  buildSiteDetailDisclosureGroups,
  disclosureFor,
} from "../../src/renderer/ledger-table.js";
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

test("buildLedgerColumns includes only disclosed cross-site comparison attributes", () => {
  const sites = [
    siteDetail("amazon", [
      disclosure("email", "メール"),
      disclosure("phone.full", "電話"),
      disclosure("account.password", "パスワード"),
      disclosure("card.number", "カード番号"),
    ]),
    siteDetail("shop", [
      disclosure("name.full", "氏名"),
      disclosure("postal.code", "郵便番号"),
      disclosure("address.full", "住所"),
      disclosure("account.id", "ログイン ID"),
      disclosure("custom.occupation", "職業"),
    ]),
  ];

  assert.deepEqual(buildLedgerColumns(sites), [
    { attributeKey: "email", label: "メール" },
    { attributeKey: "account.id", label: "ログイン ID" },
    { attributeKey: "name.full", label: "氏名" },
    { attributeKey: "address.full", label: "住所" },
    { attributeKey: "phone.full", label: "電話" },
    { attributeKey: "postal.code", label: "郵便番号" },
  ]);
});

test("buildSiteDetailDisclosureGroups orders common, authentication/card, then other disclosures", () => {
  const disclosures = [
    disclosure("custom.occupation", "職業"),
    disclosure("card.expiry", "カード有効期限"),
    disclosure("phone.full", "電話"),
    disclosure("account.password", "パスワード"),
    disclosure("custom.nickname", "ニックネーム"),
    disclosure("account.id", "ログイン ID"),
    disclosure("card.number", "カード番号"),
    disclosure("email", "メール"),
  ];

  assert.deepEqual(
    buildSiteDetailDisclosureGroups(disclosures).map((group) => ({
      label: group.label,
      keys: group.disclosures.map((item) => item.attributeKey),
    })),
    [
      { label: "共通項目", keys: ["email", "phone.full"] },
      {
        label: "認証・カード",
        keys: ["account.id", "account.password", "card.number", "card.expiry"],
      },
      { label: "その他", keys: ["custom.nickname", "custom.occupation"] },
    ],
  );
});

test("disclosureFor returns the matching disclosure or undefined when the site lacks that attribute", () => {
  const site = siteDetail("amazon", [disclosure("email", "メール")]);
  assert.equal(disclosureFor(site, "email")?.attributeKey, "email");
  assert.equal(disclosureFor(site, "phone.full"), undefined);
});
