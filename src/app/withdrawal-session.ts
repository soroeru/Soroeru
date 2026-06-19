// Session bridge for Web UI withdrawal preparation (#129).
//
// Withdrawal automation prepares the headed browser and pauses at walls, but
// intentionally stops before irreversible account deletion / final withdrawal.

import type { Page } from "playwright";
import type { WithdrawalResult } from "../agent/agent.js";
import type { WallDetection } from "../types.js";
import type { AppRunner, AppRunnerHooks } from "./runner.js";

export type WithdrawalSessionState =
  | { kind: "running"; currentNote?: string }
  | { kind: "awaiting-handoff"; wall: WallDetection; instruction: string }
  | { kind: "done"; result: WithdrawalResult }
  | { kind: "cancelled" }
  | { kind: "error"; message: string };

/** One in-flight `AppRunner.withdraw()` run, paused/resumed across HTTP requests. */
export class WithdrawalSession {
  private state: WithdrawalSessionState = { kind: "running" };
  private pendingHandoff: ((result: "resolved" | "abort") => void) | undefined;
  private cancelRequested = false;
  readonly notes: string[] = [];

  constructor(
    private readonly runner: AppRunner,
    readonly page: Page,
    readonly siteTopUrl: string,
    readonly siteId: string,
  ) {}

  getState(): WithdrawalSessionState {
    return this.state;
  }

  start(): void {
    const hooks: AppRunnerHooks = {
      gate: {
        decide: async () => ({ approved: false, attestationApprovals: {}, cardApproved: false }),
      },
      promptUser: async () => undefined,
      handoff: (wall, instruction) =>
        new Promise<"resolved" | "abort">((resolve) => {
          this.state = { kind: "awaiting-handoff", wall, instruction };
          this.pendingHandoff = resolve;
        }),
      log: (message) => {
        this.notes.push(message);
        if (this.state.kind === "running") {
          this.state = { kind: "running", currentNote: message };
        }
      },
    };
    this.runner
      .withdraw(this.page, this.siteTopUrl, this.siteId, hooks)
      .then((result) => {
        if (!this.cancelRequested) this.state = { kind: "done", result };
      })
      .catch((err: unknown) => {
        if (this.cancelRequested) return;
        this.state = { kind: "error", message: err instanceof Error ? err.message : String(err) };
      });
  }

  resolveHandoff(result: "resolved" | "abort"): boolean {
    if (!this.pendingHandoff) return false;
    const resolve = this.pendingHandoff;
    this.pendingHandoff = undefined;
    this.state = { kind: "running" };
    resolve(result);
    return true;
  }

  cancel(): void {
    if (this.state.kind === "done" || this.state.kind === "error" || this.state.kind === "cancelled") return;
    this.cancelRequested = true;
    this.state = { kind: "cancelled" };
    this.pendingHandoff?.("abort");
    this.pendingHandoff = undefined;
  }
}
