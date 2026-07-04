import assert from "node:assert/strict";
import { test } from "node:test";
import type { DecisionContext } from "../../src/automation/decision-engine.js";
import { DEFAULT_MAX_PAGES_PER_SITE, RuleEngine } from "../../src/automation/rule-engine.js";
import type { FormField, PageLink, PageSnapshot } from "../../src/types.js";

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

function loginField(fieldId: string, partial: Partial<FormField>): FormField {
  return {
    fieldId,
    tag: "input",
    type: "text",
    name: "",
    id: "",
    autocomplete: "",
    required: false,
    placeholder: "",
    labels: [],
    nearbyText: "",
    ...partial,
  };
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
  for (const kind of ["classify-field", "name-new-attribute"] as const) {
    const result = engine.evaluate({ kind, snapshot: snapshot({}), context: context() });
    assert.equal(result.confident, false, kind);
    assert.equal(result.result, undefined, kind);
  }
});

test("findLoginPageLinks is confident on an explicit login keyword and filters external/negative links", () => {
  const engine = new RuleEngine();
  const result = engine.evaluate({
    kind: "find-login-page",
    snapshot: snapshot({
      url: "https://example.com/",
      links: links(
        ["新規登録", "https://example.com/register"],
        ["ログイン", "/login"],
        ["ログイン", "https://phish.test/login"],
      ),
    }),
    context: context(),
  });

  assert.equal(result.confident, true);
  assert.deepEqual(
    result.result?.links.map((l) => l.href),
    ["https://example.com/login"],
  );
});

test("findLoginPageLinks with only an href hint is an unconfident partial result", () => {
  const engine = new RuleEngine();
  const result = engine.evaluate({
    kind: "find-login-page",
    snapshot: snapshot({
      url: "https://example.com/",
      links: links(["会員メニュー", "https://example.com/member"]),
    }),
    context: context(),
  });

  assert.equal(result.confident, false);
  assert.deepEqual(
    result.result?.links.map((l) => l.href),
    ["https://example.com/member"],
  );
});

test("detectLoginForm returns the form confidently when username, password, and submit are present", () => {
  const engine = new RuleEngine();
  const result = engine.evaluate({
    kind: "detect-login-form",
    snapshot: snapshot({
      fields: [
        loginField("f-user", { type: "email", autocomplete: "username" }),
        loginField("f-pass", { type: "password", autocomplete: "current-password" }),
      ],
      buttons: [{ selector: "button[type=submit]", text: "ログイン" }],
    }),
    context: context(),
  });

  assert.equal(result.confident, true);
  assert.deepEqual(result.result?.form, {
    usernameFieldId: "f-user",
    passwordFieldId: "f-pass",
    submitSelector: "button[type=submit]",
  });
});

test("detectLoginForm without a submit button returns the field pair unconfidently (AI may find the button)", () => {
  const engine = new RuleEngine();
  const result = engine.evaluate({
    kind: "detect-login-form",
    snapshot: snapshot({
      fields: [
        loginField("f-user", { type: "email", autocomplete: "username" }),
        loginField("f-pass", { type: "password", autocomplete: "current-password" }),
      ],
    }),
    context: context(),
  });

  assert.equal(result.confident, false);
  assert.deepEqual(result.result?.form, { usernameFieldId: "f-user", passwordFieldId: "f-pass" });
});

test("detectLoginForm without a password field is confidently no form", () => {
  const engine = new RuleEngine();
  const result = engine.evaluate({
    kind: "detect-login-form",
    snapshot: snapshot({ fields: [loginField("f-search", { type: "text", name: "q" })] }),
    context: context(),
  });

  assert.equal(result.confident, true);
  assert.deepEqual(result.result, { form: null });
});

test("detectLoginForm with a password but no recognizable username stays unconfident with no form", () => {
  const engine = new RuleEngine();
  const result = engine.evaluate({
    kind: "detect-login-form",
    snapshot: snapshot({ fields: [loginField("f-pass", { type: "password" })] }),
    context: context(),
  });

  assert.equal(result.confident, false);
  assert.deepEqual(result.result, { form: null });
});

test("judgeLoginResult is confident success on two success signals and no failure signal", () => {
  const engine = new RuleEngine();
  const result = engine.evaluate({
    kind: "judge-login-result",
    snapshot: snapshot({ links: links(["ログアウト", "/logout"], ["マイページ", "/mypage"]) }),
    context: context({ currentUrl: "https://example.com/account" }),
  });

  assert.equal(result.confident, true);
  assert.deepEqual(result.result, { success: true, reason: "success-indicators" });
});

test("judgeLoginResult is confident failure when a password field remains", () => {
  const engine = new RuleEngine();
  const result = engine.evaluate({
    kind: "judge-login-result",
    snapshot: snapshot({ fields: [loginField("f-pass", { type: "password" })] }),
    context: context({ currentUrl: "https://example.com/login" }),
  });

  assert.equal(result.confident, true);
  assert.deepEqual(result.result, { success: false, reason: "failure-indicators" });
});

test("judgeLoginResult with mixed signals returns no result (safe default decides)", () => {
  const engine = new RuleEngine();
  const result = engine.evaluate({
    kind: "judge-login-result",
    snapshot: snapshot({
      links: links(["ログアウト", "/logout"], ["マイページ", "/mypage"]),
      visibleText: "パスワードが正しくありません（エラー）",
    }),
    context: context({ currentUrl: "https://example.com/account" }),
  });

  assert.equal(result.confident, false);
  assert.equal(result.result, undefined);
});
