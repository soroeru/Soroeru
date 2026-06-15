// Session-based bridge between `AppRunner.register()`'s hook-driven flow and
// the web UI's stateless HTTP request/response model (#81).
//
// `AppRunner.register()` runs to completion in one call, pausing on the
// `gate.decide`, `promptUser`, and `handoff` hooks that the legacy terminal UI
// (`src/app/ui.ts`) resolves with blocking `readline` prompts. The web UI
// instead starts the run in the background and exposes its current pause
// point via `getState()`; each pause point is resolved by a follow-up POST
// that calls `provideData` / `decideGate` / `resolveHandoff`.

import type { Page } from "playwright";
import type { RegistrationResult } from "../agent/agent.js";
import type { GateDecision, GateRequest, WallDetection } from "../types.js";
import type { AppRunner, AppRunnerHooks } from "./runner.js";

export type RegistrationSessionState =
  | { kind: "running" }
  | { kind: "awaiting-data"; label: string }
  | { kind: "awaiting-gate"; request: GateRequest }
  | { kind: "awaiting-handoff"; wall: WallDetection; instruction: string }
  | { kind: "done"; result: RegistrationResult }
  | { kind: "error"; message: string };

/** One in-flight `AppRunner.register()` run, paused/resumed across HTTP requests. */
export class RegistrationSession {
  private state: RegistrationSessionState = { kind: "running" };
  private pendingData: ((value: string | undefined) => void) | undefined;
  private pendingGate: ((decision: GateDecision) => void) | undefined;
  private pendingHandoff: ((result: "resolved" | "abort") => void) | undefined;
  readonly notes: string[] = [];

  constructor(
    private readonly runner: AppRunner,
    readonly page: Page,
    readonly url: string,
  ) {}

  getState(): RegistrationSessionState {
    return this.state;
  }

  /** Start the registration run in the background. Call once. */
  start(): void {
    const hooks: AppRunnerHooks = {
      gate: {
        decide: (request) =>
          new Promise<GateDecision>((resolve) => {
            this.state = { kind: "awaiting-gate", request };
            this.pendingGate = resolve;
          }),
      },
      promptUser: (label) =>
        new Promise<string | undefined>((resolve) => {
          this.state = { kind: "awaiting-data", label };
          this.pendingData = resolve;
        }),
      handoff: (wall, instruction) =>
        new Promise<"resolved" | "abort">((resolve) => {
          this.state = { kind: "awaiting-handoff", wall, instruction };
          this.pendingHandoff = resolve;
        }),
      log: (message) => this.notes.push(message),
    };
    this.runner
      .register(this.page, this.url, hooks)
      .then((result) => {
        this.state = { kind: "done", result };
      })
      .catch((err: unknown) => {
        this.state = { kind: "error", message: err instanceof Error ? err.message : String(err) };
      });
  }

  /** Resolve a missing-data prompt. An empty/undefined value skips the field. */
  provideData(value: string | undefined): boolean {
    if (!this.pendingData) return false;
    const resolve = this.pendingData;
    this.pendingData = undefined;
    this.state = { kind: "running" };
    resolve(value);
    return true;
  }

  /** Resolve the review-and-confirm gate. */
  decideGate(decision: GateDecision): boolean {
    if (!this.pendingGate) return false;
    const resolve = this.pendingGate;
    this.pendingGate = undefined;
    this.state = { kind: "running" };
    resolve(decision);
    return true;
  }

  /** Resolve a wall hand-off after the user resolves it (or gives up) in the same browser session. */
  resolveHandoff(result: "resolved" | "abort"): boolean {
    if (!this.pendingHandoff) return false;
    const resolve = this.pendingHandoff;
    this.pendingHandoff = undefined;
    this.state = { kind: "running" };
    resolve(result);
    return true;
  }
}
