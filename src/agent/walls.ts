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
const AMBIGUOUS_WALL_RE =
  /不正なアクセス|通常と異なるアクセス|自動化されたアクセス|アクセスを一時的に制限|しばらくしてから再度|security check|suspicious activity|unusual traffic/i;
// Site-forced password reset gate (Issue #372, seen on account.nicovideo.jp):
// login "succeeds" but the site routes the session to a mandatory reset page.
// Wording must be required/imperative ("〜が必要", "〜してください") so an
// ordinary login page that merely links "パスワードの再設定はこちら" stays clear.
const PASSWORD_RESET_REQUIRED_RE =
  /パスワードの?再設定が必要|パスワードを再設定して\s*ください|password\s+reset\s+(is\s+)?required|(please|need\s+to|must)\s+reset\s+your\s+password/i;

export function detectWall(snapshot: PageSnapshot): WallDetection | undefined {
  // Checked before the CAPTCHA signals: the forced-reset page often embeds a
  // Cloudflare Turnstile iframe, and classifying it as "captcha" would give
  // the human an inaccurate hand-off instruction (Issue #372). Either way the
  // response is the same — detect and hand off; never solve or bypass.
  const passwordResetWording = PASSWORD_RESET_REQUIRED_RE.exec(snapshot.visibleText);
  if (passwordResetWording) {
    return { kind: "password-reset", evidence: `wording: ${passwordResetWording[0]}` };
  }
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
  if (AMBIGUOUS_WALL_RE.test(snapshot.visibleText)) {
    return { kind: "ambiguous", evidence: "ambiguous access-control wording" };
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
  "password-reset":
    "サイトがパスワードの再設定を要求しています。この一時停止中のブラウザ内で、あなた自身で再設定またはログインを完了してください（メールのリンクを別のブラウザで開いて完了しても、このセッションには反映されません）。完了後に続行します。",
  ambiguous:
    "通常のフォーム操作ではない確認画面が表示されています。内容を確認し、あなた自身で必要な操作を完了してください。完了後に続行します。",
};

/**
 * User-facing handoff message for a detected wall. The copy never explains how
 * to solve, bypass, or outsource the wall — it only asks the human to resolve
 * it themselves so the agent can resume (SEC-002 / #23).
 */
export function handoffInstruction(wall: WallDetection): string {
  return HANDOFF_INSTRUCTIONS[wall.kind];
}

/**
 * Pause/resume contract (REQ-009 sub-task tracked informally as "REQ-009b"; the
 * formal requirement is REQ-009). Given a freshly observed snapshot:
 *
 *   - no wall                  -> "clear", resume on the same snapshot;
 *   - wall, no handoff wired   -> "abort" (caller records manualHandoff);
 *   - wall, handoff "abort"    -> "abort";
 *   - wall, handoff "resolved" -> re-observe the page the human advanced to and
 *     loop, so a chained wall (e.g. CAPTCHA then OTP) is caught and the caller's
 *     mapper / three guards / review-and-confirm gate / fill all re-run against
 *     the *resumed* page, never the pre-handoff one.
 *
 * The re-observation count is bounded by `maxHandoffs` (default 3): the agent
 * never loops forever and never does anything that resembles retrying past or
 * evading a wall. It detects and hands off — it never solves or bypasses.
 */
export async function clearWalls(
  initial: PageSnapshot,
  opts: {
    handoff?: HumanHandoff;
    reobserve: () => Promise<PageSnapshot>;
    log: (message: string) => void;
    maxHandoffs?: number;
  },
): Promise<{ snapshot: PageSnapshot; status: "clear" | "abort" }> {
  const maxHandoffs = opts.maxHandoffs ?? 3;
  let snapshot = initial;
  for (let handoffs = 0; handoffs <= maxHandoffs; handoffs++) {
    const wall = detectWall(snapshot);
    if (!wall) return { snapshot, status: "clear" };
    opts.log(`壁を検知: ${wall.kind} (${wall.evidence}) — 解決はせずユーザーへハンドオフします`);
    if (!opts.handoff) return { snapshot, status: "abort" };
    if (handoffs === maxHandoffs) {
      opts.log("壁が連続したため自動進行を停止します（壁の解決・回避は行いません）");
      return { snapshot, status: "abort" };
    }
    const outcome = await opts.handoff(wall, handoffInstruction(wall));
    if (outcome !== "resolved") return { snapshot, status: "abort" };
    opts.log("壁の解決を確認しました。再開ページを再観測してから続行します。");
    snapshot = await opts.reobserve();
  }
  return { snapshot, status: "abort" };
}
