// Wall detection skeleton (RFC-001 v3 §10b). Conservative DOM heuristics over a
// structure-only snapshot. The agent DETECTS these walls and hands off to the
// human in the same headed session; it must never solve, bypass, outsource, or
// obscure them. When in doubt, stop and ask the human.

import type { PageSnapshot, WallDetection } from "../types.js";

const CAPTCHA_IFRAME_RE = /recaptcha|hcaptcha|challenges\.cloudflare\.com|arkoselabs|funcaptcha/i;
const CAPTCHA_TEXT_RE = /私はロボットではありません|I'm not a robot/i;
const OTP_ATTR_RE = /(^|[-_])otp([-_]|$)|one_?time/i;
const OTP_LABEL_RE = /認証コード|ワンタイムパスワード|ワンタイム|確認コード|verification code|2段階認証|二段階認証/i;
const EMAIL_VERIFY_RE = /確認メールを送信|認証メールを送信|メール内の(確認|認証)リンク|確認コードを送信しました/;

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
  return undefined;
}

/**
 * Pause-resume hook skeleton: the run loop awaits this when a wall is detected.
 * In the real app this fronts the headed-browser overlay + 「続行」 button; the
 * PoC runner injects a callback (no walls exist on the local test sites).
 */
export type HumanHandoff = (wall: WallDetection, instruction: string) => Promise<"resolved" | "abort">;
