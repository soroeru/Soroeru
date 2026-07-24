import test from "node:test";
import assert from "node:assert/strict";

import {
  canConfirmSiteDeletion,
  collectVisibleSelectedSiteIds,
  DELETE_TARGET_LIST_PREVIEW_LIMIT,
  deleteSitesForBatch,
  deleteTargetListVisibility,
  enableSessionPersistenceForSites,
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

test("runVisibilityBatch preserves suggestSavedPageImport on batch results (Issue #421)", async () => {
  const summary = await runVisibilityBatch(["amazon", "rakuten"], {
    run: async (siteAccountId) => {
      if (siteAccountId === "amazon") {
        return { ...result(siteAccountId, "handoff"), suggestSavedPageImport: true };
      }
      return result(siteAccountId, "collected");
    },
    isCanceled: () => false,
  });

  assert.equal(summary.results[0]?.suggestSavedPageImport, true);
  assert.equal(summary.results[1]?.suggestSavedPageImport, undefined);
});

test("enableSessionPersistenceForSites sets each selected site sequentially and tallies failures", async () => {
  const requested: string[] = [];

  const summary = await enableSessionPersistenceForSites(
    ["amazon", "rakuten", "yoyostore"],
    async (siteAccountId) => {
      requested.push(siteAccountId);
      if (siteAccountId === "rakuten") return { ok: false, error: "not-found" };
      return { ok: true };
    },
  );

  assert.deepEqual(requested, ["amazon", "rakuten", "yoyostore"]);
  assert.deepEqual(
    summary.results.map((entry) => [entry.siteAccountId, entry.ok, entry.error]),
    [
      ["amazon", true, undefined],
      ["rakuten", false, "not-found"],
      ["yoyostore", true, undefined],
    ],
  );
  assert.equal(summary.failedCount, 1);
});

test("enableSessionPersistenceForSites records a failure entry when the setter throws", async () => {
  const summary = await enableSessionPersistenceForSites(["amazon"], async () => {
    throw new Error("ipc failed");
  });

  assert.deepEqual(summary.results, [{ siteAccountId: "amazon", ok: false, error: "unknown" }]);
  assert.equal(summary.failedCount, 1);
});

test("deleteSitesForBatch deletes each selected site sequentially and tallies failures", async () => {
  const deleted: string[] = [];

  const summary = await deleteSitesForBatch(
    ["amazon", "rakuten", "yoyostore"],
    async (siteAccountId) => {
      deleted.push(siteAccountId);
      if (siteAccountId === "rakuten") return { ok: false, error: "not-found" };
      return { ok: true };
    },
  );

  assert.deepEqual(deleted, ["amazon", "rakuten", "yoyostore"]);
  assert.deepEqual(
    summary.results.map((entry) => [entry.siteAccountId, entry.ok, entry.error]),
    [
      ["amazon", true, undefined],
      ["rakuten", false, "not-found"],
      ["yoyostore", true, undefined],
    ],
  );
  assert.equal(summary.failedCount, 1);
});

test("deleteSitesForBatch records a failure entry when the delete function throws", async () => {
  const summary = await deleteSitesForBatch(["amazon"], async () => {
    throw new Error("delete error");
  });

  assert.deepEqual(summary.results, [{ siteAccountId: "amazon", ok: false, error: "delete-failed" }]);
  assert.equal(summary.failedCount, 1);
});

test("canConfirmSiteDeletion requires acknowledgment and at least one target (fourth absolute boundary)", () => {
  assert.equal(
    canConfirmSiteDeletion({ targetCount: 2, acknowledged: false, deleting: false }),
    false,
  );
  assert.equal(
    canConfirmSiteDeletion({ targetCount: 0, acknowledged: true, deleting: false }),
    false,
  );
  assert.equal(
    canConfirmSiteDeletion({ targetCount: 2, acknowledged: true, deleting: true }),
    false,
  );
  assert.equal(
    canConfirmSiteDeletion({ targetCount: 2, acknowledged: true, deleting: false }),
    true,
  );
});

test("deleteTargetListVisibility folds beyond the first ten sites until expanded", () => {
  assert.deepEqual(deleteTargetListVisibility(10, false), {
    visibleCount: 10,
    hiddenCount: 0,
    foldable: false,
  });
  assert.deepEqual(deleteTargetListVisibility(11, false), {
    visibleCount: DELETE_TARGET_LIST_PREVIEW_LIMIT,
    hiddenCount: 1,
    foldable: true,
  });
  assert.deepEqual(deleteTargetListVisibility(23, false), {
    visibleCount: DELETE_TARGET_LIST_PREVIEW_LIMIT,
    hiddenCount: 13,
    foldable: true,
  });
  assert.deepEqual(deleteTargetListVisibility(23, true), {
    visibleCount: 23,
    hiddenCount: 0,
    foldable: true,
  });
});

