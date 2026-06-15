// Review-and-confirm gate (RFC-001 v3 §4): shown once, after form analysis and
// before submission. Sensitive values are masked before display and never logged.

import { createInterface } from "node:readline/promises";
import { isSensitiveKey, type GateDecision, type GateRequest, type ProfileKey } from "../types.js";

export interface Gate {
  decide(request: GateRequest): Promise<GateDecision>;
}

const PAYMENT_LABELS: Record<NonNullable<GateRequest["analysis"]["payment"]>, string> = {
  "trial-subscription": "無料トライアル後にサブスク課金（承認時のみカード入力）",
  "immediate-payment": "即時決済（対象外・停止）",
  unknown: "判別不能（安全側で停止）",
};

/** `du***@example.com` — keep enough of the local part + domain to recognize the address. */
function maskEmail(value: string): string {
  const at = value.indexOf("@");
  if (at <= 0) return "***";
  const local = value.slice(0, at);
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}***${value.slice(at)}`;
}

/** `090-****-5678` — keep the area/prefix and the last segment, mask the middle. */
function maskPhone(value: string): string {
  const parts = value.split("-");
  if (parts.length === 3) return `${parts[0]}-****-${parts[2]}`;
  if (value.length <= 4) return "*".repeat(value.length);
  return `${value.slice(0, 2)}${"*".repeat(value.length - 6)}${value.slice(-4)}`;
}

/**
 * Mask policy for interactive review surfaces (the review-and-confirm gate
 * and the local UI's profile listing, PRIV-002 / #21): card number to last 4,
 * CVV/expiry/holder/password to a strong mask (`isSensitiveKey`), email/phone
 * to a partial mask that still lets the user recognize their own value. Other
 * fields (name, address, company, account ID) are shown in full — the gate's
 * purpose is to let the user verify exactly what will be submitted, and the
 * "necessary minimum" principle for those fields is enforced instead at the
 * persisted-artifact boundary (`maskForArtifact`, docs/security.md §3).
 */
export function maskValue(key: ProfileKey, value: string): string {
  if (key === "card.number") return `**** **** **** ${value.slice(-4)}`;
  if (isSensitiveKey(key)) return "••••••";
  if (key === "email") return maskEmail(value);
  if (key === "phone.full") return maskPhone(value);
  return value;
}

/**
 * Mask policy for persisted artifacts (measurement JSON under `state/`,
 * PRIV-002 / #21): unlike `maskValue`, no field's raw value is written —
 * only enough to tell that a mismatch occurred and roughly how large the
 * value is. card / CVV / expiry / holder / password use the same strong mask
 * as `maskValue`.
 */
export function maskForArtifact(key: ProfileKey, value: string): string {
  if (key === "card.number" || isSensitiveKey(key)) return "••••••";
  return value ? `(${value.length}文字)` : "(空)";
}

export function renderGate(request: GateRequest): string {
  const lines: string[] = [];
  lines.push(`▼ 確認ゲート: ${request.serviceName} (${request.origin})`);
  lines.push("送信する項目:");
  for (const f of request.fields) lines.push(`  - ${f.label} [${f.profileKey}] = ${f.maskedValue}`);
  if (request.termsLinks.length > 0) {
    lines.push("規約 / ポリシー:");
    for (const l of request.termsLinks) lines.push(`  - ${l.text}: ${l.href}`);
  }
  if (request.analysis.highRiskFlags.length > 0) {
    lines.push("⚠ 高リスク条項（自動承認を停止し、ユーザー判断を仰ぐ項目）:");
    for (const flag of request.analysis.highRiskFlags) {
      lines.push(`  - ${flag}: ${request.analysis.evidence[flag] ?? ""}`);
    }
  }
  if (request.analysis.payment) {
    lines.push(`支払い項目の判定: ${PAYMENT_LABELS[request.analysis.payment]}`);
    if (request.analysis.payment === "trial-subscription") {
      lines.push(
        "  → 承認した場合のみカード情報を自動入力します（GateDecision.cardApproved）。承認しなければカードは入力しません。",
      );
    } else {
      lines.push("  → 支払いが必要なため自動入力・送信は行いません（ユーザーへハンドオフ）。");
    }
  }
  if (request.analysis.prohibitsAutoCreation) {
    lines.push("※ このサイトは自動アカウント作成を禁止しています。入力のみ行い、最後の登録ボタンはご自身で押してください。");
  }
  for (const a of request.attestations) {
    lines.push(`資格・本人性の表明（自動チェックしません）: ${a.label}`);
  }
  return lines.join("\n");
}

/** Scripted gate used by the measurement runner (simulated user decisions). */
export class ScriptedGate implements Gate {
  constructor(
    private readonly script: { approved: boolean; cardApproved: boolean; approveAttestations: boolean },
  ) {}

  decide(request: GateRequest): Promise<GateDecision> {
    // The simulated user decides each presented attestation individually
    // (guard 3 never checks them without this explicit per-item decision).
    const attestationApprovals: Record<string, boolean> = {};
    for (const a of request.attestations) attestationApprovals[a.fieldId] = this.script.approveAttestations;
    return Promise.resolve({
      approved: this.script.approved,
      attestationApprovals,
      cardApproved: this.script.cardApproved,
    });
  }
}

/** Interactive CLI gate for manual (headed) runs. */
export class CliGate implements Gate {
  async decide(request: GateRequest): Promise<GateDecision> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      process.stdout.write(`${renderGate(request)}\n`);
      const attestationApprovals: Record<string, boolean> = {};
      for (const a of request.attestations) {
        const answer = await rl.question(`「${a.label}」にチェックを入れますか？ [y/N] `);
        attestationApprovals[a.fieldId] = answer.trim().toLowerCase() === "y";
      }
      let cardApproved = false;
      if (request.analysis.payment === "trial-subscription") {
        const answer = await rl.question(
          "無料トライアル終了後に課金が始まります。承認するとカード情報を自動入力します。承認しますか？ [y/N] ",
        );
        cardApproved = answer.trim().toLowerCase() === "y";
      }
      const answer = await rl.question("この内容で登録しますか？ [y/N] ");
      return { approved: answer.trim().toLowerCase() === "y", attestationApprovals, cardApproved };
    } finally {
      rl.close();
    }
  }
}
