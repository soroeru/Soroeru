// Wall detection skeleton (RFC-001 v3 §10b). Conservative DOM heuristics over a
// structure-only snapshot. The agent DETECTS these walls and hands off to the
// human in the same headed session; it must never solve, bypass, outsource, or
// obscure them. When in doubt, stop and ask the human.

import type { PageSnapshot, WallDetection } from "../types.js";

const CAPTCHA_IFRAME_RE = /recaptcha|hcaptcha|challenges\.cloudflare\.com|arkoselabs|funcaptcha/i;
const CAPTCHA_TEXT_RE = /私はロボットではありません|I'm not a robot/i;
const OTP_ATTR_RE = /(^|[-_])otp([-_]|$)|one_?time/i;
const OTP_LABEL_RE =
  /認証コード|ワンタイムパスワード|ワンタイム|確認コード|verification code|2段階認証|二段階認証|SMSで送信|SMS認証|ショートメッセージ/i;
const EMAIL_VERIFY_RE = /確認メールを送信|認証メールを送信|メール内の(確認|認証)リンク|確認コードを送信しました/;
// Identity / age verification (eKYC, ID upload). Detect only — hand off; never automate.
const IDENTITY_VERIFY_RE = /本人確認|身分証|運転免許証|マイナンバーカード|eKYC|顔写真の?(撮影|アップロード)|年齢確認(書類|のため)/;

export function detectWall(snapshot: PageSnapshot): WallDetection | undefined {
  if (snapshot.wallMarkers.length > 0) {
    return { kind: "captcha", evidence: `widget marker: ${snapshot.wallMarkers.join(", ")}` };
  }
  const captchaFrame = snapshot.iframeSrcs.find((src) => CAPTCHA_IFRAME_RE.test(src));
  if (captchaFrame) return { kind: "captcha", evidence: `iframe: ${captchaFrame}` };
  if (CAPTCHA_TEXT_RE.test(snapshot.visibleText)) {
    return { kind: "captcha", evidence: "visible captcha wording" };
  }

  for (const field of snapshot.fields) {
    const labelish = [...field.labels, field.placeholder, field.nearbyText].join(" ");
    if (
      field.autocomplete === "one-time-code" ||
      OTP_ATTR_RE.test(`${field.name} ${field.id}`) ||
      OTP_LABEL_RE.test(labelish)
    ) {
      return { kind: "mfa", evidence: `otp field: ${field.name || field.id || field.fieldId}` };
    }
  }

  if (EMAIL_VERIFY_RE.test(snapshot.visibleText)) {
    return { kind: "email-verification", evidence: "verification-mail wording" };
  }
  if (IDENTITY_VERIFY_RE.test(snapshot.visibleText)) {
    return { kind: "identity-verification", evidence: "identity-verification wording" };
  }
  return undefined;
}

/**
 * Pause-resume hook: the run loop awaits this when a wall is detected. In the
 * real app this fronts the headed-browser overlay + 「続行」 button; the PoC
 * runner injects a callback (no walls exist on the local test sites).
 *
 * Returns "resolved" to resume automation from the paused step, or "abort" to
 * end the run (the caller records RegistrationStatus = manualHandoff).
 */
export type HumanHandoff = (wall: WallDetection, instruction: string) => Promise<"resolved" | "abort">;

const HANDOFF_INSTRUCTIONS: Record<WallDetection["kind"], string> = {
  captcha: "CAPTCHAが表示されています。あなた自身で認証を完了してください。完了後に続行します。",
  mfa: "ワンタイムコード（MFA/SMS等）の入力が必要です。あなた自身でコードを入力してください。完了後に続行します。",
  "email-verification":
    "メール／SMSの確認が必要です。届いた確認リンクまたはコードをあなた自身で処理してください。完了後に続行します。",
  "identity-verification":
    "本人確認（身分証の提出など）が必要です。あなた自身で手続きを進めてください。完了後に続行します。",
};

/**
 * User-facing handoff message for a detected wall. The copy never explains how
 * to solve, bypass, or outsource the wall — it only asks the human to resolve
 * it themselves so the agent can resume (SEC-002 / #23).
 */
export function handoffInstruction(wall: WallDetection): string {
  return HANDOFF_INSTRUCTIONS[wall.kind];
}
