import assert from "node:assert/strict";
import { test } from "node:test";
import {
  analyzeTermsDeterministic,
  classifyPayment,
  detectHighRiskFlags,
  detectsAutoCreationBan,
  evaluateGuards,
  shouldCheckAttestation,
} from "../../src/agent/guards.js";
import { normalizeTermsAnalysis } from "../../src/agent/normalization.js";
import type { GateDecision, TermsAnalysis } from "../../src/types.js";

test("guard 1: auto-renewal and third-party-sharing clauses are flagged with evidence", () => {
  const terms =
    "契約は同一条件で自動的に更新されるものとします。当社は、取得した個人情報を提携企業その他の第三者に提供することがあります。";
  const { flags, evidence } = detectHighRiskFlags(terms);
  assert.ok(flags.includes("auto-renewal"));
  assert.ok(flags.includes("third-party-sharing"));
  assert.ok(evidence["auto-renewal"]?.includes("自動的に更新"));
});

test("guard 2 (Q2a): trial→subscription vs immediate payment vs ambiguous", () => {
  assert.equal(
    classifyPayment("30日間の無料トライアル期間の終了後は、月額980円が自動的に課金されます。"),
    "trial-subscription",
  );
  assert.equal(classifyPayment("「今すぐ購入」を押すとご注文を確定し、決済を実行します。"), "immediate-payment");
  // Ambiguous wording must stop on the safe side: never auto-fill a card on an unclear charge.
  assert.equal(classifyPayment("カード情報を入力してください。"), "unknown");
});

test("immediate-payment wording wins even when trial words also appear", () => {
  assert.equal(
    classifyPayment("無料トライアルもありますが、このプランは今すぐ購入で即時に決済されます。"),
    "immediate-payment",
  );
});

test("Q2c: automated account creation bans are detected", () => {
  assert.ok(
    detectsAutoCreationBan("自動化された手段（ボット、スクリプト、スクレイパー等）を用いたアカウントの作成を禁止します。"),
  );
  assert.ok(!detectsAutoCreationBan("当社はアカウントの作成を歓迎します。"));
});

test("Q2c analysis surfaces auto-creation ban as a high-risk flag with evidence", () => {
  const analysis = analyzeTermsDeterministic(
    "自動化された手段（ボット、スクリプト、スクレイパー等）を用いたアカウントの作成を禁止します。",
    "",
    false,
  );
  assert.equal(analysis.prohibitsAutoCreation, true);
  assert.ok(analysis.highRiskFlags.includes("no-auto-creation"));
  assert.ok(analysis.evidence["no-auto-creation"]?.includes("アカウントの作成"));
});

test("analysis composes: trial conversion is surfaced as a high-risk flag", () => {
  const analysis = analyzeTermsDeterministic(
    "無料トライアル期間の終了後は、月額980円が自動的に課金されます。",
    "30日間無料でお試しいただけます。",
    true,
  );
  assert.equal(analysis.payment, "trial-subscription");
  assert.ok(analysis.highRiskFlags.includes("trial-subscription"));
  assert.equal(analysis.prohibitsAutoCreation, false);
});

// --- Shared guard decision (SAFE-001) -----------------------------------------

function decision(overrides: Partial<GateDecision> = {}): GateDecision {
  return { approved: true, attestationApprovals: {}, cardApproved: false, ...overrides };
}

const clean = (a: Partial<TermsAnalysis>): TermsAnalysis =>
  normalizeTermsAnalysis({ highRiskFlags: [], evidence: {}, prohibitsAutoCreation: false, ...a });

test("guard seam: gate denial declines regardless of analysis", () => {
  const out = evaluateGuards({ analysis: clean({}), decision: decision({ approved: false }), hasCardFields: false });
  assert.equal(out.action, "declined");
  assert.equal(out.fillCard, false);
});

test("guard 2: card fields with non-trial payment stop and hand off", () => {
  for (const payment of ["immediate-payment", "unknown"] as const) {
    const out = evaluateGuards({ analysis: clean({ payment }), decision: decision(), hasCardFields: true });
    assert.equal(out.action, "stop-handoff", payment);
    assert.equal(out.fillCard, false);
  }
});

test("guard 2 exception: approved trial→subscription fills the card and proceeds", () => {
  const approved = evaluateGuards({
    analysis: clean({ payment: "trial-subscription" }),
    decision: decision({ cardApproved: true }),
    hasCardFields: true,
  });
  assert.equal(approved.action, "proceed-submit");
  assert.equal(approved.fillCard, true);

  const declined = evaluateGuards({
    analysis: clean({ payment: "trial-subscription" }),
    decision: decision({ cardApproved: false }),
    hasCardFields: true,
  });
  assert.equal(declined.action, "declined");
  assert.equal(declined.fillCard, false);
});

test("auto-creation ban downgrades a submit to assisted fill", () => {
  const out = evaluateGuards({ analysis: clean({ prohibitsAutoCreation: true }), decision: decision(), hasCardFields: false });
  assert.equal(out.action, "assisted-fill");
});

test("guard 3: attestations are checked only on an explicit per-item decision", () => {
  const d = decision({ attestationApprovals: { att1: true } });
  assert.equal(shouldCheckAttestation(d, "att1"), true);
  assert.equal(shouldCheckAttestation(d, "att2"), false);
});

test("deterministic and AI analyses reach the SAME guard stop condition", () => {
  // Same normalized analysis (the seam both variants share) -> identical outcome,
  // independent of which mapper produced it.
  const det = analyzeTermsDeterministic("無料トライアル期間の終了後は月額980円が自動的に課金されます。", "", true);
  const aiLike = normalizeTermsAnalysis({
    highRiskFlags: ["trial-subscription"],
    evidence: {},
    prohibitsAutoCreation: false,
    payment: "trial-subscription",
  });
  const d = decision({ cardApproved: true });
  assert.deepEqual(
    evaluateGuards({ analysis: det, decision: d, hasCardFields: true }),
    evaluateGuards({ analysis: aiLike, decision: d, hasCardFields: true }),
  );

  // And an immediate-payment analysis stops both ways.
  const detStop = analyzeTermsDeterministic("「今すぐ購入」で即時に決済されます。", "", true);
  const aiStop = normalizeTermsAnalysis({ highRiskFlags: [], evidence: {}, prohibitsAutoCreation: false, payment: "immediate-payment" });
  assert.equal(evaluateGuards({ analysis: detStop, decision: d, hasCardFields: true }).action, "stop-handoff");
  assert.equal(evaluateGuards({ analysis: aiStop, decision: d, hasCardFields: true }).action, "stop-handoff");
});
