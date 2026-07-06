// VisibilityService: the trusted main-process orchestrator for a Visibility run
// (RFC-002 §5.1 / §5.2). It owns the single active run over the VisibilityRunner
// and brokers the wall hand-off between the headed browser and the renderer:
// when the runner pauses at a CAPTCHA/MFA/verification wall, this service emits
// a `handoff` event and waits for the renderer to call `resume`/`abort` (the
// user clears the wall in the same visible session). It never solves or bypasses
// a wall, and never logs or forwards a raw collected value.
//
// Framework-free (no electron import) so it is unit-testable with a fake
// `openSession` and a captured `emit`.

import type { AiEngine } from "../src/automation/decision-engine.js";
import { VisibilityRunner, type VisibilityRunResult } from "../src/automation/visibility-runner.js";
import type { SiteSession } from "../src/automation/page-driver.js";
import type { DomainService } from "../src/domain/domain-service.js";
import type { Credential, SiteAccount } from "../src/domain/entities.js";
import { noopLogger, type Logger } from "../src/logging/logger.js";
import type {
  VisibilityEvent,
  VisibilityHandoffCredentialView,
  VisibilityRunResultView,
  VisibilityStatusView,
} from "./ipc/contract.js";

export interface VisibilityServiceOptions {
  /** Opens a fresh ephemeral browser session for a site (the real BrowserEngine in production). */
  openSession: (site: SiteAccount) => Promise<SiteSession>;
  /** Optional sink for run progress / hand-off events pushed to the renderer. */
  emit?: (event: VisibilityEvent) => void;
  /** Max chained wall hand-offs before giving up (passed through to the runner). */
  maxHandoffs?: number;
  /** Optional AI fallback for DecisionEngine (Issue #310); absent = rules-only, today's behavior. */
  aiEngine?: AiEngine;
  /** Plain-text diagnostics sink passed through to the runner (Issue #314); defaults to a no-op. */
  logger?: Logger;
}

interface PendingHandoff {
  siteAccountId: string;
  instruction: string;
  resolve: (outcome: "resolved" | "abort") => void;
}

export class VisibilityService {
  private domain: DomainService | undefined;
  private running = false;
  private activeSiteId: string | undefined;
  private activeSession: SiteSession | undefined;
  private cancelRequested = false;
  private pendingHandoff: PendingHandoff | undefined;
  /** The in-flight `close()` triggered by `abortRun()`, if any (Issue #294 app-quit race). */
  private pendingSessionClose: Promise<void> | undefined;
  /** Optional AI fallback for DecisionEngine (Issue #310); mutable so the caller can rebuild it per vault-unlock session. */
  private aiEngine: AiEngine | undefined;
  private readonly logger: Logger;

  constructor(private readonly options: VisibilityServiceOptions) {
    this.aiEngine = options.aiEngine;
    this.logger = options.logger ?? noopLogger;
  }

  /** Bind the unlocked vault's DomainService (called on unlock). */
  setDomain(domain: DomainService): void {
    this.domain = domain;
  }

  /** Unbind on lock; abort any active run so an in-flight task can unwind. */
  clearDomain(): void {
    this.abortRun();
    this.domain = undefined;
  }

  /** Replace the AI fallback (Issue #310): rebuilt per vault-unlock session, cleared on lock. */
  setAiEngine(aiEngine: AiEngine | undefined): void {
    this.aiEngine = aiEngine;
  }

  status(): VisibilityStatusView {
    const view: VisibilityStatusView = {
      running: this.running,
      awaitingHandoff: this.pendingHandoff !== undefined,
    };
    if (this.activeSiteId !== undefined) view.siteAccountId = this.activeSiteId;
    if (this.pendingHandoff !== undefined) view.instruction = this.pendingHandoff.instruction;
    return view;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Run Visibility collection for one site. Rejects a concurrent run (one headed
   * session at a time) and returns a sanitized, counts-only result.
   */
  async runSite(siteAccountId: string): Promise<VisibilityRunResultView> {
    if (!this.domain) {
      return { siteAccountId, status: "locked", disclosures: 0, relationships: 0, constraints: 0 };
    }
    if (this.running) {
      return { siteAccountId, status: "busy", disclosures: 0, relationships: 0, constraints: 0 };
    }
    this.running = true;
    this.activeSiteId = siteAccountId;
    try {
      const runner = new VisibilityRunner({
        domain: this.domain,
        openSession: (site) => this.openTrackedSession(site),
        handoff: (input) => this.onHandoff(input),
        isCanceled: () => this.cancelRequested,
        logger: this.logger,
        ...(this.options.maxHandoffs !== undefined ? { maxHandoffs: this.options.maxHandoffs } : {}),
        ...(this.aiEngine !== undefined ? { aiEngine: this.aiEngine } : {}),
      });
      this.emit({ type: "run-started", siteAccountId });
      const view = toView(await runner.runSite(siteAccountId));
      this.emit({ type: "run-finished", result: view });
      return view;
    } finally {
      this.running = false;
      this.activeSiteId = undefined;
      this.activeSession = undefined;
      this.cancelRequested = false;
      this.pendingHandoff = undefined;
    }
  }

  /** Resolve the active wall hand-off as cleared; the run re-observes and resumes. */
  resumeHandoff(): boolean {
    const pending = this.pendingHandoff;
    if (!pending) return false;
    this.pendingHandoff = undefined;
    this.emit({ type: "resumed", siteAccountId: pending.siteAccountId });
    pending.resolve("resolved");
    return true;
  }

  /** Resolve the active wall hand-off as abandoned; the run stops (never bypasses). */
  abortHandoff(): boolean {
    const pending = this.pendingHandoff;
    if (!pending) return false;
    this.pendingHandoff = undefined;
    pending.resolve("abort");
    return true;
  }

  /** Request cancellation of the active Visibility run, including non-handoff browser work. */
  abortRun(): boolean {
    if (!this.running) return false;
    this.cancelRequested = true;
    this.abortHandoff();
    if (this.activeSession) this.pendingSessionClose = this.activeSession.close().catch(() => {});
    return true;
  }

  /**
   * Await the session `close()` (and its persistence export, if opted-in)
   * kicked off by the most recent `abortRun()`. Callers that tear down the
   * browser engine right after aborting (app quit) must await this first, or
   * the engine can be closed out from under an in-flight `storageState` export
   * (Issue #294).
   */
  async waitForActiveSessionClose(): Promise<void> {
    await this.pendingSessionClose;
  }

  private async openTrackedSession(site: SiteAccount): Promise<SiteSession> {
    if (this.cancelRequested) throw new Error("visibility run canceled");
    const session = await this.options.openSession(site);
    this.activeSession = session;
    if (this.cancelRequested) {
      await session.close();
      throw new Error("visibility run canceled");
    }
    return session;
  }

  private onHandoff(input: {
    siteAccount: SiteAccount;
    instruction: string;
    evidence: string;
    credential?: Credential;
  }): Promise<"resolved" | "abort"> {
    const credential = input.credential ? toHandoffCredentialView(input.credential) : undefined;
    this.emit({
      type: "handoff",
      siteAccountId: input.siteAccount.id,
      instruction: input.instruction,
      evidence: input.evidence,
      ...(credential ? { credential } : {}),
    });
    return new Promise<"resolved" | "abort">((resolve) => {
      this.pendingHandoff = {
        siteAccountId: input.siteAccount.id,
        instruction: input.instruction,
        resolve,
      };
    });
  }

  private emit(event: VisibilityEvent): void {
    this.options.emit?.(event);
  }
}

function toHandoffCredentialView(credential: Credential): VisibilityHandoffCredentialView {
  return {
    username: credential.username,
    password: credential.password,
  };
}

function toView(result: VisibilityRunResult): VisibilityRunResultView {
  return {
    siteAccountId: result.siteAccountId,
    status: result.status,
    disclosures: result.disclosures,
    relationships: result.relationships,
    constraints: result.constraints,
  };
}
