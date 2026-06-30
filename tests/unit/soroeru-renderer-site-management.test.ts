import test from "node:test";
import assert from "node:assert/strict";

import {
  collectVisibleSelectedSiteIds,
  runVisibilityBatch,
} from "../../src/renderer/site-management-batch.js";
import type { SiteLedgerSummary, VisibilityRunResultView } from "../../electron/ipc/contract.js";

function site(siteAccountId: string): SiteLedgerSummary {
  return {
    siteAccountId,
    domain: `${siteAccountId}.example`,
    displayName: siteAccountId,
    credentialCount: 1,
    disclosureCount: 0,
    stale: { current: 0, stale: 0, unknown: 0 },
    relationshipKinds: [],
    constraintCount: 0,
    collected: false,
  };
}

function result(siteAccountId: string, status: VisibilityRunResultView["status"]): VisibilityRunResultView {
  return {
    siteAccountId,
    status,
    disclosures: 0,
    relationships: 0,
    constraints: 0,
  };
}

test("collectVisibleSelectedSiteIds preserves visible row order and ignores hidden selections", () => {
  const visibleSites = [site("rakuten"), site("amazon"), site("yoyostore")];
  const selected = new Set(["hidden", "amazon", "rakuten"]);

  assert.deepEqual(collectVisibleSelectedSiteIds(visibleSites, selected), ["rakuten", "amazon"]);
});

test("runVisibilityBatch runs checked sites sequentially and records per-site failures", async () => {
  const started: string[] = [];
  const refreshed: string[] = [];

  const summary = await runVisibilityBatch(["amazon", "rakuten", "yoyostore"], {
    run: async (siteAccountId) => {
      started.push(siteAccountId);
      if (siteAccountId === "rakuten") throw new Error("navigation failed");
      return result(siteAccountId, "collected");
    },
    refreshAfterSite: async (siteAccountId) => {
      refreshed.push(siteAccountId);
    },
    isCanceled: () => false,
  });

  assert.deepEqual(started, ["amazon", "rakuten", "yoyostore"]);
  assert.deepEqual(refreshed, ["amazon", "rakuten", "yoyostore"]);
  assert.deepEqual(
    summary.results.map((entry) => [entry.siteAccountId, entry.status]),
    [
      ["amazon", "collected"],
      ["rakuten", "failed"],
      ["yoyostore", "collected"],
    ],
  );
  assert.equal(summary.completed, 3);
  assert.equal(summary.canceled, false);
});

test("runVisibilityBatch stops before the next site when canceled", async () => {
  const started: string[] = [];
  let canceled = false;

  const summary = await runVisibilityBatch(["amazon", "rakuten", "yoyostore"], {
    run: async (siteAccountId) => {
      started.push(siteAccountId);
      canceled = true;
      return result(siteAccountId, "handoff");
    },
    isCanceled: () => canceled,
  });

  assert.deepEqual(started, ["amazon"]);
  assert.equal(summary.completed, 1);
  assert.equal(summary.canceled, true);
});
