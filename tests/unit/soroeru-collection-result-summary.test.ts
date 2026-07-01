import test from "node:test";
import assert from "node:assert/strict";

import { buildCollectionResultModalContent } from "../../src/renderer/collection-result-summary.js";

function nameOf(siteAccountId: string): string {
  return `${siteAccountId}-name`;
}

test("buildCollectionResultModalContent returns undefined when every site collected", () => {
  const content = buildCollectionResultModalContent(
    [
      { siteAccountId: "amazon", status: "collected" },
      { siteAccountId: "rakuten", status: "collected" },
    ],
    nameOf,
  );

  assert.equal(content, undefined);
});

test("buildCollectionResultModalContent treats a terminal handoff (abandoned at a wall) as a failure", () => {
  // runVisibilityBatch only records a result once a site's run has resolved, so a
  // "handoff" status here always means the user skipped/abandoned the wall, not
  // that it is still paused (that state never reaches `results`).
  const content = buildCollectionResultModalContent([{ siteAccountId: "amazon", status: "handoff" }], nameOf);

  assert.ok(content);
  assert.equal(content.failures.length, 1);
  assert.equal(content.failures[0]?.status, "handoff");
  assert.equal(content.failures[0]?.actionable, true);
});

test("buildCollectionResultModalContent marks a skipped non-website credential as not actionable", () => {
  const content = buildCollectionResultModalContent([{ siteAccountId: "authenticator-app", status: "skipped" }], nameOf);

  assert.ok(content);
  assert.equal(content.failures[0]?.actionable, false);
});

test("buildCollectionResultModalContent reports a single failed site with its reason and name", () => {
  const content = buildCollectionResultModalContent(
    [{ siteAccountId: "amazon", status: "login-failed" }],
    nameOf,
  );

  assert.ok(content);
  assert.equal(content.successCount, 0);
  assert.equal(content.failures.length, 1);
  assert.equal(content.failures[0]?.siteAccountId, "amazon");
  assert.equal(content.failures[0]?.siteName, "amazon-name");
  assert.equal(content.failures[0]?.status, "login-failed");
  assert.match(content.title, /amazon-name/);
});

test("buildCollectionResultModalContent summarizes a batch with mixed outcomes", () => {
  const content = buildCollectionResultModalContent(
    [
      { siteAccountId: "amazon", status: "collected" },
      { siteAccountId: "rakuten", status: "failed" },
      { siteAccountId: "yoyostore", status: "unreachable" },
    ],
    nameOf,
  );

  assert.ok(content);
  assert.equal(content.successCount, 1);
  assert.deepEqual(
    content.failures.map((entry) => entry.siteAccountId),
    ["rakuten", "yoyostore"],
  );
  assert.match(content.title, /失敗 2 件/);
  assert.match(content.title, /成功 1 件/);
});
