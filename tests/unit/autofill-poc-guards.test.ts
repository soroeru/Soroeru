import assert from "node:assert/strict";
import { test } from "node:test";
import {
  analyzeTermsDeterministic,
  classifyPayment,
  detectHighRiskFlags,
  detectsAutoCreationBan,
} from "../../poc/autofill-agent/src/agent/guards.js";

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
