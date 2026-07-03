import assert from "node:assert/strict";
import { test } from "node:test";
import type { DecisionContext } from "../../src/automation/decision-engine.js";
import { DEFAULT_MAX_PAGES_PER_SITE, RuleEngine } from "../../src/automation/rule-engine.js";
import type { PageLink, PageSnapshot } from "../../src/types.js";

function snapshot(partial: Partial<PageSnapshot>): PageSnapshot {
  return {
    url: "https://example.com/mypage",
    title: "",
    fields: [],
    buttons: [],
    links: [],
    visibleText: "",
    iframeSrcs: [],
    wallMarkers: [],
    ...partial,
  };
}

function context(partial: Partial<DecisionContext> = {}): DecisionContext {
  return { siteAccount: { domain: "example.com", displayName: "Example" }, ...partial };
}

function links(...items: Array<[string, string]>): PageLink[] {
  return items.map(([text, href]) => ({ text, href }));
}

test("findProfileLinks scores profile-ish links and sorts by priority", () => {
  const engine = new RuleEngine();
  const result = engine.evaluate({
    kind: "find-profile-links",
    snapshot: snapshot({
      links: links(
        ["お届け先住所", "https://example.com/address"],
        ["マイページ", "https://example.com/mypage2"],
        ["登録情報の確認", "https://example.com/profile"],
        ["ヘルプ", "https://example.com/help"],
      ),
    }),
    context: context(),
  });

  assert.equal(result.confident, true);
  assert.deepEqual(
    result.result?.links.map((l) => l.href),
    ["https://example.com/mypage2", "https://example.com/profile", "https://example.com/address"],
  );
  assert.deepEqual(
    result.result?.links.map((l) => l.category),
    ["mypage", "profile", "address"],
  );
});

test("findProfileLinks skips visited URLs, comparing in normalized form", () => {
  const engine = new RuleEngine();
  const result = engine.evaluate({
    kind: "find-profile-links",
    snapshot: snapshot({
      links: links(
        ["会員情報", "https://example.com/profile/#top"],
        ["お支払い方法", "https://example.com/payment"],
      ),
    }),
    // Visited set holds normalized URLs; the link above differs only by
    // trailing slash + fragment and must still be recognized as visited.
    context: context({ visitedUrls: ["https://example.com/profile"] }),
  });

  assert.deepEqual(
    result.result?.links.map((l) => l.href),
    ["https://example.com/payment"],
  );
});

test("findProfileLinks skips external links and resolves relative hrefs", () => {
  const engine = new RuleEngine();
  const result = engine.evaluate({
    kind: "find-profile-links",
    snapshot: snapshot({
      url: "https://example.com/home",
      links: links(
        ["プロフィール", "https://tracker.test/profile"],
        ["アカウント設定", "/settings"],
      ),
    }),
    context: context(),
  });

  assert.deepEqual(
    result.result?.links.map((l) => l.href),
    ["https://example.com/settings"],
  );
});

test("findProfileLinks dedupes repeated links (header + footer nav)", () => {
  const engine = new RuleEngine();
  const result = engine.evaluate({
    kind: "find-profile-links",
    snapshot: snapshot({
      links: links(
        ["マイページ", "https://example.com/mypage2"],
        ["マイページ", "https://example.com/mypage2/"],
      ),
    }),
    context: context(),
  });

  assert.equal(result.result?.links.length, 1);
});

test("findProfileLinks with no matches is an unconfident empty result", () => {
  const engine = new RuleEngine();
  const result = engine.evaluate({
    kind: "find-profile-links",
    snapshot: snapshot({ links: links(["ヘルプ", "https://example.com/help"]) }),
    context: context(),
  });

  assert.equal(result.confident, false);
  assert.deepEqual(result.result, { links: [] });
});

test("shouldContinue keeps exploring below the page cap, unconfidently", () => {
  const engine = new RuleEngine();
  const result = engine.evaluate({
    kind: "should-continue",
    snapshot: snapshot({}),
    context: context({ visitedUrls: ["https://example.com/a"] }),
  });

  assert.equal(result.confident, false);
  assert.deepEqual(result.result, { continue: true });
});

test("shouldContinue stops confidently at the page cap (AI cannot override)", () => {
  const engine = new RuleEngine({ maxPagesPerSite: 2 });
  const result = engine.evaluate({
    kind: "should-continue",
    snapshot: snapshot({}),
    context: context({ visitedUrls: ["https://example.com/a", "https://example.com/b"] }),
  });

  assert.equal(result.confident, true);
  assert.deepEqual(result.result, { continue: false });
});

test("shouldContinue always has an explicit default cap", () => {
  const engine = new RuleEngine();
  const visitedUrls = Array.from({ length: DEFAULT_MAX_PAGES_PER_SITE }, (_, i) => `https://example.com/p${i}`);
  const result = engine.evaluate({ kind: "should-continue", snapshot: snapshot({}), context: context({ visitedUrls }) });

  assert.equal(result.confident, true);
  assert.deepEqual(result.result, { continue: false });
});

test("kinds without a rule implementation return unconfident with no result", () => {
  const engine = new RuleEngine();
  for (const kind of ["find-login-page", "detect-login-form", "judge-login-result", "classify-field", "name-new-attribute"] as const) {
    const result = engine.evaluate({ kind, snapshot: snapshot({}), context: context() });
    assert.equal(result.confident, false, kind);
    assert.equal(result.result, undefined, kind);
  }
});
