// Review-and-confirm gate (RFC-001 v3 §4): shown once, after form analysis and
// before submission. Sensitive values are masked before display and never logged.

import { createInterface } from "node:readline/promises";
import { isSensitiveKey, type GateDecision, type GateRequest, type ProfileKey } from "../types.js";

export interface Gate {
  decide(request: GateRequest): Promise<GateDecision>;
}

export function maskValue(key: ProfileKey, value: string): string {
  if (key === "card.number") return `**** **** **** ${value.slice(-4)}`;
  if (isSensitiveKey(key)) return "••••••";
  return value;
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
  if (request.analysis.payment) lines.push(`支払い項目の判定: ${request.analysis.payment}`);
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
