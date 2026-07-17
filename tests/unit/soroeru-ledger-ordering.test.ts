import assert from "node:assert/strict";
import { test } from "node:test";
import { moveLedgerSite, orderLedgerSites } from "../../src/renderer/ledger-ordering.js";

const sites = [
  { siteAccountId: "b", displayName: "Beta" },
  { siteAccountId: "a", displayName: "Alpha" },
  { siteAccountId: "c", displayName: "Charlie" },
];

test("manual ordering preserves canonical order and name modes are non-destructive views", () => {
  assert.deepEqual(orderLedgerSites(sites, "manual").map((site) => site.siteAccountId), ["b", "a", "c"]);
  assert.deepEqual(orderLedgerSites(sites, "name-asc").map((site) => site.siteAccountId), ["a", "b", "c"]);
  assert.deepEqual(orderLedgerSites(sites, "name-desc").map((site) => site.siteAccountId), ["c", "b", "a"]);
  assert.deepEqual(sites.map((site) => site.siteAccountId), ["b", "a", "c"]);
});

test("name modes sort Latin display names alphabetically and reverse under desc", () => {
  const latin = [
    { siteAccountId: "3", displayName: "zeta" },
    { siteAccountId: "1", displayName: "Alpha" },
    { siteAccountId: "2", displayName: "beta" },
  ];
  assert.deepEqual(orderLedgerSites(latin, "name-asc").map((site) => site.displayName), [
    "Alpha",
    "beta",
    "zeta",
  ]);
  assert.deepEqual(orderLedgerSites(latin, "name-desc").map((site) => site.displayName), [
    "zeta",
    "beta",
    "Alpha",
  ]);
});

test("name modes sort Japanese kana with ja localeCompare (あ→ん / ん→あ)", () => {
  // Hiragana only: localeCompare("ja") yields gojuon order without yomi for kanji.
  const japanese = [
    { siteAccountId: "u", displayName: "うなぎサービス" },
    { siteAccountId: "a", displayName: "あおぞら銀行" },
    { siteAccountId: "n", displayName: "のあしす" },
    { siteAccountId: "i", displayName: "いぬねこ" },
  ];
  assert.deepEqual(orderLedgerSites(japanese, "name-asc").map((site) => site.siteAccountId), [
    "a",
    "i",
    "u",
    "n",
  ]);
  assert.deepEqual(orderLedgerSites(japanese, "name-desc").map((site) => site.siteAccountId), [
    "n",
    "u",
    "i",
    "a",
  ]);
  // Input order is unchanged (name sort is a non-destructive view).
  assert.deepEqual(
    japanese.map((site) => site.siteAccountId),
    ["u", "a", "n", "i"],
  );
});

test("name modes apply after an arbitrary filter (orthogonal to collection filter #388)", () => {
  const all = [
    { siteAccountId: "b", displayName: "Beta", collected: true },
    { siteAccountId: "a", displayName: "Alpha", collected: false },
    { siteAccountId: "c", displayName: "Charlie", collected: true },
  ];
  const collectedOnly = all.filter((site) => site.collected);
  assert.deepEqual(orderLedgerSites(collectedOnly, "name-asc").map((site) => site.siteAccountId), [
    "b",
    "c",
  ]);
  assert.deepEqual(orderLedgerSites(collectedOnly, "name-desc").map((site) => site.siteAccountId), [
    "c",
    "b",
  ]);
});

test("moving one ledger row keeps every site exactly once", () => {
  assert.deepEqual(moveLedgerSite(sites, "b", "c").map((site) => site.siteAccountId), ["a", "c", "b"]);
  assert.deepEqual(moveLedgerSite(sites, "missing", "c"), sites);
});
