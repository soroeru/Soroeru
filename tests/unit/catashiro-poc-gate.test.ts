// REQ-006a (#11): the review-and-confirm gate renders the submission summary,
// terms, high-risk flags, and the trial-subscription card decision, masks
// sensitive values, and returns an explicit GateDecision.

import assert from "node:assert/strict";
import { test } from "node:test";
import { maskForArtifact, maskValue, renderGate, ScriptedGate } from "../../src/agent/gate.js";
import type { GateRequest, ProfileKey } from "../../src/types.js";

function gateRequest(overrides: Partial<GateRequest> = {}): GateRequest {
  return {
    origin: "http://127.0.0.1:8080",
    serviceName: "テストサービス",
    fields: [
      { label: "メールアドレス", profileKey: "email", maskedValue: "dummy@example.com" },
      { label: "カード番号", profileKey: "card.number", maskedValue: maskValue("card.number", "4111111111111111") },
    ],
    termsLinks: [{ href: "http://127.0.0.1:8080/terms", text: "利用規約" }],
    analysis: { highRiskFlags: [], evidence: {}, prohibitsAutoCreation: false },
    attestations: [],
    ...overrides,
  };
}

test("masks sensitive values: card number to last 4, CVV/password fully", () => {
  assert.equal(maskValue("card.number", "4111111111111111"), "**** **** **** 1111");
  assert.equal(maskValue("card.cvv", "123"), "••••••");
  assert.equal(maskValue("account.password", "Dummy-Passw0rd!"), "••••••");
});

test("masks email and phone partially: enough to recognize, not the full value (PRIV-002 / #21)", () => {
  assert.equal(maskValue("email", "dummy@example.com"), "du***@example.com");
  assert.equal(maskValue("email", "a@example.com"), "a***@example.com");
  assert.equal(maskValue("phone.full", "090-1234-5678"), "090-****-5678");
});

test("other profile fields (name, address, account ID) are shown in full for gate review", () => {
  assert.equal(maskValue("name.full", "山田 太郎"), "山田 太郎");
  assert.equal(maskValue("address.full", "東京都千代田区千代田1-1"), "東京都千代田区千代田1-1");
  assert.equal(maskValue("account.id", "taro_yamada"), "taro_yamada");
});

test("maskForArtifact: persisted artifacts (measurement JSON) never contain a raw value (PRIV-002 / #21)", () => {
  assert.equal(maskForArtifact("card.number", "4111111111111111"), "••••••");
  assert.equal(maskForArtifact("card.cvv", "123"), "••••••");
  assert.equal(maskForArtifact("account.password", "Dummy-Passw0rd!"), "••••••");
  assert.equal(maskForArtifact("email", "dummy@example.com"), "(17文字)");
  assert.equal(maskForArtifact("address.full", "東京都千代田区千代田1-1"), "(13文字)");
  assert.equal(maskForArtifact("email", ""), "(空)");
});

test("renders service, origin, masked fields, and terms links", () => {
  const out = renderGate(gateRequest());
  assert.ok(out.includes("テストサービス"));
  assert.ok(out.includes("http://127.0.0.1:8080"));
  assert.ok(out.includes("[email]"));
  assert.ok(out.includes("**** **** **** 1111"));
  assert.ok(out.includes("利用規約"));
  // The raw card number must never appear in the rendered gate.
  assert.ok(!out.includes("4111111111111111"));
});

test("renders high-risk flags with their evidence quotes", () => {
  const out = renderGate(
    gateRequest({
      analysis: {
        highRiskFlags: ["auto-renewal"],
        evidence: { "auto-renewal": "自動的に更新され課金されます" },
        prohibitsAutoCreation: false,
      },
    }),
  );
  assert.ok(out.includes("auto-renewal"));
  assert.ok(out.includes("自動的に更新され課金されます"));
});

test("trial-subscription surfaces the card auto-fill approval as a gate item", () => {
  const out = renderGate(
    gateRequest({
      analysis: { highRiskFlags: ["trial-subscription"], evidence: {}, prohibitsAutoCreation: false, payment: "trial-subscription" },
    }),
  );
  assert.ok(out.includes("cardApproved"));
  assert.ok(out.includes("カード"));
});

test("immediate-payment is shown as a stop/handoff, not an approval", () => {
  const out = renderGate(
    gateRequest({ analysis: { highRiskFlags: [], evidence: {}, prohibitsAutoCreation: false, payment: "immediate-payment" } }),
  );
  assert.ok(out.includes("停止") || out.includes("ハンドオフ"));
  assert.ok(!out.includes("cardApproved"));
});

test("attestations are displayed as individual, non-auto-checked decisions", () => {
  const out = renderGate(gateRequest({ attestations: [{ fieldId: "att1", label: "私は18歳以上です" }] }));
  assert.ok(out.includes("自動チェックしません"));
  assert.ok(out.includes("私は18歳以上です"));
});

test("ScriptedGate returns an explicit decision with per-attestation approvals", async () => {
  const req = gateRequest({
    attestations: [
      { fieldId: "att1", label: "私は18歳以上です" },
      { fieldId: "att2", label: "東京都に在住しています" },
    ],
    analysis: { highRiskFlags: ["trial-subscription"], evidence: {}, prohibitsAutoCreation: false, payment: "trial-subscription" },
  });

  const approved = await new ScriptedGate({ approved: true, cardApproved: true, approveAttestations: true }).decide(req);
  assert.deepEqual(approved, {
    approved: true,
    cardApproved: true,
    attestationApprovals: { att1: true, att2: true },
  });

  const declined = await new ScriptedGate({ approved: false, cardApproved: false, approveAttestations: false }).decide(req);
  assert.equal(declined.approved, false);
  assert.equal(declined.cardApproved, false);
  assert.deepEqual(declined.attestationApprovals, { att1: false, att2: false });
});

test("gate decision keys cover exactly approved/attestationApprovals/cardApproved", async () => {
  const decision = await new ScriptedGate({ approved: true, cardApproved: false, approveAttestations: false }).decide(
    gateRequest(),
  );
  assert.deepEqual(Object.keys(decision).sort(), ["approved", "attestationApprovals", "cardApproved"]);
  // Sanity: ProfileKey typing still flows through maskValue.
  const k: ProfileKey = "card.cvv";
  assert.equal(maskValue(k, "999"), "••••••");
});
