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

test("moving one ledger row keeps every site exactly once", () => {
  assert.deepEqual(moveLedgerSite(sites, "b", "c").map((site) => site.siteAccountId), ["a", "c", "b"]);
  assert.deepEqual(moveLedgerSite(sites, "missing", "c"), sites);
});
