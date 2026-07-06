// Unit tests for the collection-run failure analysis (Issue #317): JSONL
// parsing tolerance, terminal-outcome reduction (last entry wins, wall-kind
// attribution), and the ranked cause ordering. Fake domains only.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeErrorText,
  parseLogEntries,
  rankFailureCauses,
  siteOutcomes,
} from "../../src/logging/collection-log-analysis.js";

function line(fields: Record<string, unknown>): string {
  return JSON.stringify({ at: "2026-07-06T00:00:00.000Z", level: "info", category: "visibility", ...fields });
}

test("parseLogEntries skips non-JSON lines and blank lines", () => {
  const text = [line({ message: "collection completed", domain: "a.example" }), "", "not json", "42"].join("\n");
  const entries = parseLogEntries(text);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.domain, "a.example");
});

test("siteOutcomes maps each terminal message to its cause bucket", () => {
  const text = [
    line({ message: "collection completed", domain: "ok.example" }),
    line({ message: "site unreachable", domain: "gone.example", reason: "dns-not-found" }),
    line({
      message: "login failed: still on a login page after submitting credentials",
      domain: "login.example",
    }),
    line({ message: "no collectable data found", domain: "empty.example" }),
    line({ message: "skipped non-web credential", domain: "app.example", scheme: "android" }),
    line({ message: "run canceled", siteAccountId: "site-9" }),
    line({ message: "run failed", domain: "boom.example", error: "Timeout 30000ms exceeded." }),
  ].join("\n");

  const outcomes = siteOutcomes(parseLogEntries(text));
  const bySite = new Map(outcomes.map((outcome) => [outcome.site, outcome.category]));
  assert.equal(bySite.get("ok.example"), "collected");
  assert.equal(bySite.get("gone.example"), "unreachable:dns-not-found");
  assert.equal(bySite.get("login.example"), "login-incomplete");
  assert.equal(bySite.get("empty.example"), "no-data");
  assert.equal(bySite.get("app.example"), "non-web-credential");
  assert.equal(bySite.get("site-9"), "canceled");
  assert.equal(bySite.get("boom.example"), "failed:operation-timeout");
});

test("a wall pause is attributed to the site's preceding wall-detected kind", () => {
  const text = [
    line({ message: "wall detected", domain: "wall.example", wall: "captcha", step: "login-page", level: "warn" }),
    line({ message: "run paused for wall hand-off", domain: "wall.example", siteAccountId: "site-1" }),
    line({ message: "run paused for wall hand-off", domain: "nokind.example", siteAccountId: "site-2" }),
  ].join("\n");

  const outcomes = siteOutcomes(parseLogEntries(text));
  const bySite = new Map(outcomes.map((outcome) => [outcome.site, outcome.category]));
  assert.equal(bySite.get("wall.example"), "wall:captcha");
  assert.equal(bySite.get("nokind.example"), "wall:unknown");
});

test("a retried site keeps only its last terminal outcome", () => {
  const text = [
    line({ message: "site unreachable", domain: "retry.example", reason: "timeout" }),
    line({ message: "collection completed", domain: "retry.example" }),
  ].join("\n");

  const outcomes = siteOutcomes(parseLogEntries(text));
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]?.category, "collected");
});

test("rankFailureCauses ranks by count, excludes collected/canceled, and computes share over all sites", () => {
  const text = [
    line({ message: "collection completed", domain: "ok.example" }),
    line({ message: "run canceled", domain: "cancel.example" }),
    line({ message: "site unreachable", domain: "a.example", reason: "dns-not-found" }),
    line({ message: "site unreachable", domain: "b.example", reason: "dns-not-found" }),
    line({ message: "no collectable data found", domain: "c.example" }),
  ].join("\n");

  const causes = rankFailureCauses(siteOutcomes(parseLogEntries(text)));
  assert.deepEqual(
    causes.map((cause) => [cause.category, cause.count]),
    [
      ["unreachable:dns-not-found", 2],
      ["no-data", 1],
    ],
  );
  assert.equal(causes[0]?.share, 2 / 5);
  assert.deepEqual(causes[0]?.sites, ["a.example", "b.example"]);
});

test("normalizeErrorText buckets known failure shapes and strips URLs from the rest", () => {
  assert.equal(normalizeErrorText("Timeout 30000ms exceeded."), "operation-timeout");
  assert.equal(normalizeErrorText("Target page, context or browser has been closed"), "browser-closed");
  assert.equal(normalizeErrorText(undefined), "unknown");
  const stripped = normalizeErrorText("boom at https://user.example/account?id=1 now");
  assert.equal(stripped.includes("user.example"), false);
  assert.equal(stripped.includes("<url>"), true);
});
