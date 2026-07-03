import assert from "node:assert/strict";
import { test } from "node:test";
import { isSameSite, normalizeUrl, resolveHref } from "../../src/automation/url-utils.js";

test("normalizeUrl strips fragments", () => {
  assert.equal(normalizeUrl("https://example.com/mypage#section"), "https://example.com/mypage");
  assert.equal(normalizeUrl("https://example.com/#top"), "https://example.com/");
});

test("normalizeUrl drops a trailing slash on non-root paths only", () => {
  assert.equal(normalizeUrl("https://example.com/mypage/"), "https://example.com/mypage");
  assert.equal(normalizeUrl("https://example.com/"), "https://example.com/");
  assert.equal(normalizeUrl("https://example.com"), "https://example.com/");
});

test("normalizeUrl keeps query strings as-is", () => {
  assert.equal(normalizeUrl("https://example.com/page?b=2&a=1#f"), "https://example.com/page?b=2&a=1");
});

test("normalizeUrl drops a trailing slash before a query string too", () => {
  assert.equal(normalizeUrl("https://example.com/page/?a=1"), "https://example.com/page?a=1");
  assert.equal(normalizeUrl("https://example.com/?a=1"), "https://example.com/?a=1");
});

test("normalizeUrl returns unparseable input unchanged", () => {
  assert.equal(normalizeUrl("not a url"), "not a url");
  assert.equal(normalizeUrl("/relative/path#x"), "/relative/path#x");
});

test("normalizeUrl makes fragment/slash variants of the same page compare equal", () => {
  const variants = ["https://example.com/account/", "https://example.com/account#profile", "https://example.com/account"];
  const normalized = new Set(variants.map(normalizeUrl));
  assert.equal(normalized.size, 1);
});

test("isSameSite matches the domain and its subdomains, not others", () => {
  assert.equal(isSameSite("https://example.com/a", "example.com"), true);
  assert.equal(isSameSite("https://www.example.com/a", "example.com"), true);
  assert.equal(isSameSite("https://shop.example.com/a", "example.com"), true);
  assert.equal(isSameSite("https://evil-example.com/a", "example.com"), false);
  assert.equal(isSameSite("https://other.test/a", "example.com"), false);
});

test("isSameSite treats relative hrefs as same-site", () => {
  assert.equal(isSameSite("/mypage", "example.com"), true);
  assert.equal(isSameSite("./mypage", "example.com"), true);
  assert.equal(isSameSite("javascript:void(0)", "example.com"), false);
});

test("resolveHref resolves relative hrefs against the page URL", () => {
  assert.equal(resolveHref("/mypage", "https://example.com/home"), "https://example.com/mypage");
  assert.equal(resolveHref("settings", "https://example.com/account/home"), "https://example.com/account/settings");
  assert.equal(resolveHref("https://example.com/abs", "https://example.com/home"), "https://example.com/abs");
});

test("resolveHref returns undefined when no absolute URL can be formed", () => {
  assert.equal(resolveHref("/mypage", "not a base"), undefined);
});
