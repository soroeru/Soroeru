// Session bridge for Web UI bulk updates (#88).
//
// A bulk update runs selected stale sites one by one while reusing the same
// gate / handoff hook pattern as registration. Each site remains independently
// recoverable: a failure, decline, or unresolved wall is recorded for that site
// and the session continues to the next selected site.

import type { Browser, Page } from "playwright";
import type { UpdateResult } from "../agent/agent.js";
import type { GateDecision, GateRequest, ProfileKey, WallDetection } from "../types.js";
import type { AppRunner, AppRunnerHooks } from "./runner.js";

export interface BulkUpdateTarget {
  siteId: string;
  siteTopUrl: string;
  profileKeys: ProfileKey[];
}

export type BulkUpdateSessionState =
  | { kind: "running"; currentSiteId?: string }
  | { kind: "awaiting-gate"; siteId: string; request: GateRequest }
  | { kind: "awaiting-handoff"; siteId: string; wall: WallDetection; instruction: string }
  | { kind: "done"; results: UpdateResult[] }
  | { kind: "error"; message: string; results: UpdateResult[] };

export class BulkUpdateSession {
  private state: BulkUpdateSessionState = { kind: "running" };
  private pendingGate: ((decision: GateDecision) => void) | undefined;
  private pendingHandoff: ((result: "resolved" | "abort") => void) | undefined;
  private readonly results: UpdateResult[] = [];
  readonly notes: string[] = [];

  constructor(
    private readonly runner: AppRunner,
    readonly browser: Browser,
    private readonly targets: BulkUpdateTarget[],
  ) {}

  getState(): BulkUpdateSessionState {
    return this.state;
  }

  start(): void {
    void this.run().catch((err: unknown) => {
      this.state = { kind: "error", message: err instanceof Error ? err.message : String(err), results: [...this.results] };
    });
  }

  decideGate(decision: GateDecision): boolean {
    if (!this.pendingGate) return false;
    const resolve = this.pendingGate;
    this.pendingGate = undefined;
    this.state = { kind: "running" };
    resolve(decision);
    return true;
  }

  resolveHandoff(result: "resolved" | "abort"): boolean {
    if (!this.pendingHandoff) return false;
    const resolve = this.pendingHandoff;
    this.pendingHandoff = undefined;
    this.state = { kind: "running" };
    resolve(result);
    return true;
  }

  private async run(): Promise<void> {
    for (const target of this.targets) {
      this.state = { kind: "running", currentSiteId: target.siteId };
      let page: Page | undefined;
      try {
        page = await this.browser.newPage();
        const hooks = this.hooksFor(target.siteId);
        const result = await this.runner.update(page, target.siteTopUrl, target.siteId, hooks, { profileKeys: target.profileKeys });
        this.results.push(result);
      } catch (err: unknown) {
        this.results.push({
          siteId: target.siteId,
          status: "failed",
          changedKeys: target.profileKeys,
          planned: [],
          notes: [err instanceof Error ? err.message : String(err)],
        });
      } finally {
        await page?.close().catch(() => {});
      }
    }
    this.state = { kind: "done", results: [...this.results] };
  }

  private hooksFor(siteId: string): AppRunnerHooks {
    return {
      gate: {
        decide: (request) =>
          new Promise<GateDecision>((resolve) => {
            this.state = { kind: "awaiting-gate", siteId, request };
            this.pendingGate = resolve;
          }),
      },
      promptUser: async () => undefined,
      handoff: (wall, instruction) =>
        new Promise<"resolved" | "abort">((resolve) => {
          this.state = { kind: "awaiting-handoff", siteId, wall, instruction };
          this.pendingHandoff = resolve;
        }),
      log: (message) => this.notes.push(message),
    };
  }
}
