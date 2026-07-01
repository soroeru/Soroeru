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

test("buildCollectionResultModalContent excludes an in-progress handoff from the failure list", () => {
  const content = buildCollectionResultModalContent([{ siteAccountId: "amazon", status: "handoff" }], nameOf);

  assert.equal(content, undefined);
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
