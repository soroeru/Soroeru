// WallDetectionService (RFC-002 §5.1): wall detection kept strictly separate
// from field classification. It DETECTS CAPTCHA / MFA / verification walls and
// automation-prohibiting wording so the runner can hand off to the human in the
// same session — it must never solve, bypass, outsource, or obscure them.
//
// The conservative DOM heuristics are reused from the existing detector; this
// service is the seam the Visibility runner depends on.

import { detectWall, handoffInstruction } from "../agent/walls.js";
import type { PageSnapshot, WallDetection } from "../types.js";

/** Wording that indicates a site's terms prohibit automated access/registration. */
const TOS_AUTOMATION_PROHIBITION_RE =
  /自動(化|的)(な|に)?(アクセス|操作|登録|取得)(を|は)?(禁止|お断り|認め(られ|ま)せん)|スクレイピング(を|は)?禁止|bot(に|による)?アクセス(を|は)?禁止|automated\s+(access|use|registration)\s+is\s+prohibited|no\s+automated\s+access/i;

export interface TosProhibitionFinding {
  detail: string;
  evidence: string;
}

export class WallDetectionService {
  /**
   * Detect a CAPTCHA / MFA / verification wall on the page, or undefined if
   * none. Detection only — the caller hands off; nothing here circumvents.
   */
  detect(snapshot: PageSnapshot): WallDetection | undefined {
    return detectWall(snapshot);
  }

  /** Human-facing instruction for resolving a detected wall (no bypass). */
  instructionFor(wall: WallDetection): string {
    return handoffInstruction(wall);
  }

  /**
   * Detect terms wording that prohibits automation. Surfaced as a Constraint
   * for the user to decide (never a silent block, never a unilateral proceed).
   */
  detectTosProhibition(snapshot: PageSnapshot): TosProhibitionFinding | undefined {
    const match = TOS_AUTOMATION_PROHIBITION_RE.exec(snapshot.visibleText);
    if (!match) return undefined;
    return {
      detail: "利用規約に自動化禁止条項の可能性があります。続行するかはユーザーが判断します。",
      evidence: `wording: ${match[0]}`,
    };
  }
}
