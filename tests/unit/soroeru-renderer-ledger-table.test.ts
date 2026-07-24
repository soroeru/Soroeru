import test from "node:test";
import assert from "node:assert/strict";

import {
  buildLedgerColumns,
  buildSiteDetailDisclosureGroups,
  clampLedgerAttributeColumnWidth,
  disclosureFor,
  LEDGER_ATTRIBUTE_COLUMN_DEFAULT_WIDTH_PX,
  LEDGER_EMPTY_ATTRIBUTE_AREA_WIDTH_PX,
  LEDGER_FIXED_COLUMNS_WIDTH_PX,
  ledgerAttributeColumnMaxWidthPx,
  ledgerAttributeColumnMinWidthPx,
  ledgerAttributeColumnWidthPx,
  ledgerTableWidthPx,
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

test("attribute column default is 8rem (128px) and resize bounds are 1/3–3×", () => {
  assert.equal(LEDGER_ATTRIBUTE_COLUMN_DEFAULT_WIDTH_PX, 128);
  assert.equal(ledgerAttributeColumnMinWidthPx(), Math.round(128 / 3));
  assert.equal(ledgerAttributeColumnMaxWidthPx(), Math.round(128 * 3));
  assert.equal(LEDGER_EMPTY_ATTRIBUTE_AREA_WIDTH_PX, Math.round(128 * 1.5));
});

test("clampLedgerAttributeColumnWidth clamps below min and above max", () => {
  const def = LEDGER_ATTRIBUTE_COLUMN_DEFAULT_WIDTH_PX;
  const min = ledgerAttributeColumnMinWidthPx();
  const max = ledgerAttributeColumnMaxWidthPx();
  assert.equal(clampLedgerAttributeColumnWidth(min - 1), min);
  assert.equal(clampLedgerAttributeColumnWidth(0), min);
  assert.equal(clampLedgerAttributeColumnWidth(-50), min);
  assert.equal(clampLedgerAttributeColumnWidth(max + 1), max);
  assert.equal(clampLedgerAttributeColumnWidth(10_000), max);
  assert.equal(clampLedgerAttributeColumnWidth(def), def);
  assert.equal(clampLedgerAttributeColumnWidth(def * 2), def * 2);
  assert.equal(clampLedgerAttributeColumnWidth(100.4), 100);
  assert.equal(clampLedgerAttributeColumnWidth(Number.NaN), def);
  assert.equal(clampLedgerAttributeColumnWidth(Number.POSITIVE_INFINITY), def);
});

test("clampLedgerAttributeColumnWidth honors a custom default width", () => {
  assert.equal(clampLedgerAttributeColumnWidth(10, 90), Math.round(90 / 3));
  assert.equal(clampLedgerAttributeColumnWidth(300, 90), Math.round(90 * 3));
  assert.equal(clampLedgerAttributeColumnWidth(100, 90), 100);
});

test("ledgerAttributeColumnWidthPx uses default when unset and clamps stored values", () => {
  assert.equal(ledgerAttributeColumnWidthPx({}, "email"), LEDGER_ATTRIBUTE_COLUMN_DEFAULT_WIDTH_PX);
  assert.equal(ledgerAttributeColumnWidthPx({ email: 200 }, "email"), 200);
  assert.equal(ledgerAttributeColumnWidthPx({ email: 1 }, "email"), ledgerAttributeColumnMinWidthPx());
  assert.equal(ledgerAttributeColumnWidthPx({ email: 9999 }, "email"), ledgerAttributeColumnMaxWidthPx());
});

test("ledgerTableWidthPx is sticky fixed columns plus each attribute width", () => {
  const def = LEDGER_ATTRIBUTE_COLUMN_DEFAULT_WIDTH_PX;
  assert.equal(LEDGER_FIXED_COLUMNS_WIDTH_PX, Math.round((2.5 + 2.75 + 14 + 16) * 16));
  assert.equal(ledgerTableWidthPx({}, []), LEDGER_FIXED_COLUMNS_WIDTH_PX + LEDGER_EMPTY_ATTRIBUTE_AREA_WIDTH_PX);
  assert.equal(ledgerTableWidthPx({}, ["email", "phone.full"]), LEDGER_FIXED_COLUMNS_WIDTH_PX + def * 2);
  assert.equal(
    ledgerTableWidthPx({ email: 200 }, ["email", "phone.full"]),
    LEDGER_FIXED_COLUMNS_WIDTH_PX + 200 + def,
  );
});
