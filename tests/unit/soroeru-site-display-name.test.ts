import assert from "node:assert/strict";
import { test } from "node:test";
import { siteDisplayNameCandidate } from "../../src/automation/site-display-name.js";
import type { PageSnapshot } from "../../src/types.js";

function snapshot(title: string, siteName?: string): PageSnapshot {
  return {
    url: "https://account.example.test/",
    title,
    ...(siteName !== undefined ? { siteName } : {}),
    fields: [],
    buttons: [],
    links: [],
    visibleText: "",
    iframeSrcs: [],
    wallMarkers: [],
  };
}

test("prefers a trimmed Open Graph site name over the page title", () => {
  assert.equal(
    siteDisplayNameCandidate(snapshot("Account - Example", "  Example Service  "), "example.test"),
    "Example Service",
  );
});

for (const title of [
  "ニコニコ動画｜マイページ",
  "ニコニコ動画 | マイページ",
  "ニコニコ動画 — マイページ",
  "ニコニコ動画 – マイページ",
  "ニコニコ動画 - マイページ",
  "ニコニコ動画: マイページ",
  "ニコニコ動画 · マイページ",
]) {
  test(`extracts the first service-name segment from ${title}`, () => {
    assert.equal(siteDisplayNameCandidate(snapshot(title), "account.nicovideo.jp"), "ニコニコ動画");
  });
}

test("keeps a title without a delimiter as the service-name candidate", () => {
  assert.equal(
    siteDisplayNameCandidate(snapshot("  ニコニコ動画  "), "account.nicovideo.jp"),
    "ニコニコ動画",
  );
});

test("ignores empty and domain-equivalent candidates", () => {
  assert.equal(siteDisplayNameCandidate(snapshot("   "), "example.test"), undefined);
  assert.equal(siteDisplayNameCandidate(snapshot("Account", " example.test "), "example.test"), undefined);
});
