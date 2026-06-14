// Phase-timing instrumentation (PERF-001 / #18).
//
// `AgentDeps.onPhase` (agent.ts) reports one (phase, durationMs) pair per
// phase per run. This module defines the phase names and the slow-path
// progress/timeout note shown via `deps.log` when a phase runs long.
//
// Privacy (PRIV-001/PRIV-002, Claude review follow-up on #18): a phase name
// and a number are the only things ever reported here — no profile values,
// page content, AI request payloads, or provider API keys.

/** Phases an agent run is broken into, in the order they normally occur. */
export const PHASES = ["discover", "scan", "map", "terms", "gate", "fill", "submit", "record"] as const;

export type Phase = (typeof PHASES)[number];

export type PhaseTimings = Record<Phase, number>;

export function emptyPhaseTimings(): PhaseTimings {
  return { discover: 0, scan: 0, map: 0, terms: 0, gate: 0, fill: 0, submit: 0, record: 0 };
}

/**
 * Slow-path threshold in milliseconds: a phase taking longer than this emits
 * a user-visible progress/timeout note via `deps.log` instead of leaving the
 * user wondering whether the agent is stuck. Override with `AF_POC_SLOW_PHASE_MS`.
 */
export const SLOW_PHASE_THRESHOLD_MS = Number(process.env["AF_POC_SLOW_PHASE_MS"] ?? 5000);

const PHASE_LABELS: Record<Phase, string> = {
  discover: "登録ページの発見",
  scan: "フォームのスキャン",
  map: "項目のマッピング",
  terms: "規約の分析",
  gate: "確認ゲートの表示準備",
  fill: "入力",
  submit: "送信",
  record: "記録の保存",
};

/**
 * A user-visible progress/timeout note for a phase that exceeded `thresholdMs`,
 * or `undefined` if it did not. The note names the phase and elapsed seconds
 * only — never page content or profile values.
 */
export function slowPhaseNote(phase: Phase, durationMs: number, thresholdMs: number = SLOW_PHASE_THRESHOLD_MS): string | undefined {
  if (durationMs <= thresholdMs) return undefined;
  return `処理に時間がかかっています（${PHASE_LABELS[phase]}: ${(durationMs / 1000).toFixed(1)}秒）。このまま自動で続行します…`;
}
