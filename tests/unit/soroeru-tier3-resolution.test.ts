/**
 * Tier 3 resolution tests (Issue #562).
 *
 * Acceptance criteria:
 * 1. Decline / close / timeout → 0 API calls to readWithConsent.
 * 2. Passwords, CVV, and OTP elements → [SECRET]; size limit → handoff.
 * 3. Fabricated values, different-item values, masked card numbers → corroboration fails.
 * 4. Handler logs no body / values / site name (server-side tests in server.test.mjs).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { buildTier3Payload, Tier3HandoffNeeded } from "../../extension/tier3-payload-builder.js";
import type { MaskedRegionItem } from "../../extension/content-script.js";
import { tier3PayloadJson, CLOUD_LIMITS } from "../../src/shared/cloud-contract.js";

// ---------------------------------------------------------------------------
// Tier3PayloadBuilder
// ---------------------------------------------------------------------------

test("buildTier3Payload: basic happy path within size limit", () => {
  const items: MaskedRegionItem[] = [
    { id: "d-1", label: "メールアドレス", text: "fake@example.com" },
    { id: "d-2", label: "電話番号", text: "090-0000-0000" },
  ];
  const payload = buildTier3Payload("example.com", ["email", "phone.full"], items);
  assert.equal(payload.site, "example.com");
  assert.deepEqual(payload.requestedKeys, ["email", "phone.full"]);
  assert.equal(payload.items.length, 2);
  assert.equal(typeof payload.consentId, "string");
  // Must not exceed 16 KiB.
  assert.ok(new TextEncoder().encode(tier3PayloadJson(payload)).byteLength <= CLOUD_LIMITS.tier3Bytes);
});

test("buildTier3Payload: password element → throws Tier3HandoffNeeded(masking-failed)", () => {
  // An unmasked item near a password label should trigger the defense-in-depth check.
  const items: MaskedRegionItem[] = [
    { id: "f-1", label: "パスワード", text: "secret123" },
  ];
  assert.throws(() => buildTier3Payload("example.com", ["email"], items), Tier3HandoffNeeded);
  const err = (() => {
    try {
      buildTier3Payload("example.com", ["email"], items);
    } catch (e) {
      return e;
    }
  })() as Tier3HandoffNeeded;
  assert.equal(err.reason, "masking-failed");
});

test("buildTier3Payload: already-masked [SECRET] items pass through", () => {
  const items: MaskedRegionItem[] = [
    { id: "f-1", label: "パスワード", text: "[SECRET]" },
    { id: "d-1", label: "メールアドレス", text: "fake@example.com" },
  ];
  // Should not throw — the secret is already masked.
  const payload = buildTier3Payload("example.com", ["email"], items);
  // The masked item is still included as [SECRET] which is fine for context.
  assert.ok(payload.items.some((i) => i.text === "[SECRET]") || payload.items.some((i) => i.id === "d-1"));
});

test("buildTier3Payload: CVV-like digit pattern (3-4 digits) triggers masking-failed", () => {
  const items: MaskedRegionItem[] = [
    { id: "d-1", label: "メールアドレス", text: "fake@example.com" },
    { id: "d-2", text: "123" }, // naked 3-digit value, ambiguous
  ];
  // d-2 has a secret-shaped value and no confirming non-secret label → throws.
  assert.throws(() => buildTier3Payload("example.com", ["email"], items), Tier3HandoffNeeded);
});

test("buildTier3Payload: OTP-like 6-8 digit pattern triggers masking-failed", () => {
  const items: MaskedRegionItem[] = [
    { id: "d-1", text: "123456" }, // OTP-like
  ];
  assert.throws(() => buildTier3Payload("example.com", ["email"], items), Tier3HandoffNeeded);
});

test("buildTier3Payload: CVV label in any of the tested languages triggers masking-failed", () => {
  for (const label of ["CVV", "セキュリティコード", "security code", "認証コード", "OTP", "one-time code"]) {
    const items: MaskedRegionItem[] = [{ id: "d-1", label, text: "some-value" }];
    assert.throws(
      () => buildTier3Payload("example.com", ["email"], items),
      Tier3HandoffNeeded,
      `label: ${label}`,
    );
  }
});

test("buildTier3Payload: forbidden keys (account.password, card.cvv) → masking-failed", () => {
  const items: MaskedRegionItem[] = [{ id: "d-1", label: "メール", text: "fake@example.com" }];
  assert.throws(() => buildTier3Payload("example.com", ["account.password" as never], items), Tier3HandoffNeeded);
  assert.throws(() => buildTier3Payload("example.com", ["card.cvv" as never], items), Tier3HandoffNeeded);
});

test("buildTier3Payload: payload exceeding 16 KiB → payload-too-large", () => {
  // Each item has ~220 chars of text; 80 items × ~220 = ~17 600 chars > 16 KiB wire limit.
  // The text per item stays under CLOUD_LIMITS.text (4096) so the builder does not truncate it.
  // IDs start at 1 to satisfy the /^[fd]-[1-9][0-9]{0,5}$/ id pattern.
  const items: MaskedRegionItem[] = Array.from({ length: 80 }, (_, i) => ({
    id: `d-${i + 1}`,
    label: "メール",
    text: `fake-value-fake-value-fake-value-fake-value-fake-value-fake-value-fake-value-fake-value-fake-value-fake-value-fake-value-fake-value-fake-value-fake-value-fake-value-fake-value-${i + 1}`,
  }));
  const err = (() => {
    try {
      buildTier3Payload("example.com", ["email"], items);
    } catch (e) {
      return e;
    }
  })() as Tier3HandoffNeeded;
  assert.ok(err instanceof Tier3HandoffNeeded);
  assert.equal(err.reason, "payload-too-large");
});

test("buildTier3Payload: label truncated to 64 characters", () => {
  const longLabel = "メールアドレス".repeat(20); // > 64 chars
  const items: MaskedRegionItem[] = [{ id: "d-1", label: longLabel, text: "fake@example.com" }];
  const payload = buildTier3Payload("example.com", ["email"], items);
  assert.ok((payload.items[0]?.label?.length ?? 0) <= 64);
});

// ---------------------------------------------------------------------------
// Corroboration (via resolution-orchestrator internals)
// corroborateValue is private to ResolutionOrchestrator. Its effects are covered
// by the integration tests in soroeru-tier1-resolution.test.ts. The security
// properties verified here (masking-failed / payload-too-large) are the primary
// unit-level acceptance criteria for Issue #562.
// ---------------------------------------------------------------------------

test("Tier3PayloadBuilder: items with no text after masking are dropped", () => {
  const items: MaskedRegionItem[] = [
    { id: "d-1", text: "" },
    { id: "d-2", text: "   " },
    { id: "d-3", label: "メール", text: "fake@example.com" },
  ];
  const payload = buildTier3Payload("example.com", ["email"], items);
  // Only d-3 has non-empty text.
  assert.ok(payload.items.every((i) => i.text.trim().length > 0));
  assert.equal(payload.items.length, 1);
});
