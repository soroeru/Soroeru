// Guard logic (RFC-001 v3 §4): high-risk clause detection (guard 1), payment
// classification incl. the trial→subscription exception (guard 2), and the
// auto-creation prohibition that triggers assisted fill (Q2c).
// Pure text analysis over terms / page wording; vocabulary is the deterministic
// starting point for open question Q2a.

import type { HighRiskFlag, PaymentClassification, TermsAnalysis } from "../types.js";

const HIGH_RISK_PATTERNS: { flag: HighRiskFlag; re: RegExp }[] = [
  { flag: "auto-renewal", re: /自動的に更新|自動更新|自動的に有料|自動的に課金/ },
  { flag: "third-party-sharing", re: /第三者(に|へ)(提供|販売|開示)/ },
  { flag: "arbitration", re: /仲裁|arbitration/i },
  { flag: "content-license", re: /コンテンツ.{0,20}(利用|使用)を?(許諾|ライセンス)/ },
];

const NO_AUTO_CREATION_RE =
  /(自動化された手段|ボット|スクリプト|スクレイパー|プログラム)[^。]{0,60}(アカウント|登録|作成)[^。]{0,30}禁止/;

// Q2a: distinguishing "free trial that later converts" from "immediate checkout"
// is safety-critical (guard 2 exception must never fire on an immediate charge).
const TRIAL_RE = /(無料トライアル|無料期間|お試し期間)[^。]{0,80}(終了後|経過後|後に)[^。]{0,40}(課金|請求|有料)|無料トライアル|無料期間/;
const TRIAL_CONVERSION_RE = /(終了後|経過後)[^。]{0,40}(自動的に)?(課金|請求|有料プラン)/;
const IMMEDIATE_PAYMENT_RE = /今すぐ購入|ご注文を確定|お支払いに進む|お支払い手続き|決済を実行|ただちに課金|即時に?決済/;

export function detectHighRiskFlags(text: string): { flags: HighRiskFlag[]; evidence: Partial<Record<HighRiskFlag, string>> } {
  const flags: HighRiskFlag[] = [];
  const evidence: Partial<Record<HighRiskFlag, string>> = {};
  for (const { flag, re } of HIGH_RISK_PATTERNS) {
    const m = re.exec(text);
    if (m) {
      flags.push(flag);
      evidence[flag] = excerpt(text, m.index);
    }
  }
  return { flags, evidence };
}

export function classifyPayment(text: string): PaymentClassification {
  if (IMMEDIATE_PAYMENT_RE.test(text)) return "immediate-payment";
  if (TRIAL_RE.test(text) && TRIAL_CONVERSION_RE.test(text)) return "trial-subscription";
  // Ambiguous wording: stop on the safe side (never auto-fill a card on an unclear charge).
  return "unknown";
}

export function detectsAutoCreationBan(text: string): boolean {
  return NO_AUTO_CREATION_RE.test(text);
}

/** Deterministic variant of the terms/wording analysis. */
export function analyzeTermsDeterministic(termsText: string, pageText: string, hasCardFields: boolean): TermsAnalysis {
  const combined = `${termsText}\n${pageText}`;
  const { flags, evidence } = detectHighRiskFlags(combined);
  const prohibitsAutoCreation = detectsAutoCreationBan(combined);

  const analysis: TermsAnalysis = {
    highRiskFlags: flags,
    evidence,
    prohibitsAutoCreation,
  };
  if (hasCardFields) {
    analysis.payment = classifyPayment(combined);
    if (analysis.payment === "trial-subscription" && !flags.includes("trial-subscription")) {
      // The trial→subscription conversion itself is surfaced as a high-risk item:
      // approving it at the gate is what authorizes the future charge (§4 guard 2).
      analysis.highRiskFlags = [...flags, "trial-subscription"];
      const m = TRIAL_RE.exec(combined);
      if (m) analysis.evidence["trial-subscription"] = excerpt(combined, m.index);
    }
  }
  return analysis;
}

function excerpt(text: string, index: number): string {
  const start = Math.max(0, index - 10);
  return text.slice(start, index + 60).replace(/\s+/g, " ").trim();
}
