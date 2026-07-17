import assert from "node:assert/strict";
import { test } from "node:test";
import { filterLedgerSitesByCollection } from "../../src/renderer/ledger-filter.js";
import { orderLedgerSites } from "../../src/renderer/ledger-ordering.js";

const sites = [
  { siteAccountId: "a", displayName: "Alpha", collected: true },
  { siteAccountId: "b", displayName: "Beta", collected: false },
  { siteAccountId: "c", displayName: "Charlie", collected: true },
  { siteAccountId: "d", displayName: "Delta", collected: false },
];

test("all shows every site and preserves input order", () => {
  assert.deepEqual(
    filterLedgerSitesByCollection(sites, "all").map((site) => site.siteAccountId),
    ["a", "b", "c", "d"],
  );
  // Non-destructive: original array order unchanged.
  assert.deepEqual(
    sites.map((site) => site.siteAccountId),
    ["a", "b", "c", "d"],
  );
});

test("collected shows only collected: true sites", () => {
  assert.deepEqual(
    filterLedgerSitesByCollection(sites, "collected").map((site) => site.siteAccountId),
    ["a", "c"],
  );
});

test("uncollected shows only collected: false sites", () => {
  assert.deepEqual(
    filterLedgerSitesByCollection(sites, "uncollected").map((site) => site.siteAccountId),
    ["b", "d"],
  );
});

test("filter is orthogonal to name sort", () => {
  const filtered = filterLedgerSitesByCollection(sites, "collected");
  assert.deepEqual(
    orderLedgerSites(filtered, "name-desc").map((site) => site.siteAccountId),
    ["c", "a"],
  );
});

test("select-all over filtered list keeps hidden selections when unioned into selected set", () => {
  // Mirrors LedgerPanel selectAllVisible: add visible ids without clearing hidden ones.
  const selected = new Set(["b"]);
  const visible = filterLedgerSitesByCollection(sites, "collected");
  for (const site of visible) selected.add(site.siteAccountId);

  assert.equal(selected.has("b"), true);
  assert.deepEqual([...selected].sort(), ["a", "b", "c"]);
  // selectedVisibleIds contract: selected ∩ visible, in visible order.
  const selectedVisible = visible.map((site) => site.siteAccountId).filter((id) => selected.has(id));
  assert.deepEqual(selectedVisible, ["a", "c"]);
});

test("empty result for filter when no sites match", () => {
  const onlyCollected = sites.filter((site) => site.collected);
  assert.deepEqual(filterLedgerSitesByCollection(onlyCollected, "uncollected"), []);
});
