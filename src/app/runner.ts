// UI <-> automation runner boundary (APP-001 / #43).
//
// `AppRunner` is the only thing a UI needs to drive registration / bulk
// update: it owns the mapper choice and reads the store + browser lifecycle
// from `SoroeruApp`. The UI supplies `AppRunnerHooks` — the review-and-
// confirm gate, the missing-data prompt, wall hand-off, and (on
// auto-creation-prohibited sites) the final-submit hand-off — and never
// touches `AgentDeps` or the store directly.

import type { Page } from "playwright";
import {
  runRegistration,
  runUpdate,
  runWithdrawal,
  type AgentDeps,
  type RegistrationResult,
  type UpdateOptions,
  type UpdateResult,
  type WithdrawalResult,
} from "../agent/agent.js";
import type { Gate } from "../agent/gate.js";
import { runExistingAccountImport, type ImportResult } from "../agent/importer.js";
import type { Mapper } from "../agent/mapper.js";
import type { HumanHandoff } from "../agent/walls.js";
import type { SoroeruApp } from "./app.js";

/** UI-provided callbacks. Mirrors `AgentDeps` minus the store and mapper, which `AppRunner` owns. */
export interface AppRunnerHooks {
  gate: Gate;
  promptUser: AgentDeps["promptUser"];
  handoff?: HumanHandoff;
  humanFinalSubmit?: AgentDeps["humanFinalSubmit"];
  log: (message: string) => void;
}

/** Thin orchestration seam between the UI and the agent/automation layers. */
export class AppRunner {
  constructor(
    private readonly app: SoroeruApp,
    private readonly mapper: Mapper,
  ) {}

  /** Run a new-site registration (RFC-001 v3 §4-5). */
  register(page: Page, siteTopUrl: string, hooks: AppRunnerHooks): Promise<RegistrationResult> {
    this.app.touch();
    return runRegistration(page, siteTopUrl, this.deps(hooks));
  }

  /** Run a single-site update as part of the bulk-update flow (RFC-001 v3 §5/§7). */
  update(page: Page, siteTopUrl: string, siteId: string, hooks: AppRunnerHooks, options: UpdateOptions = {}): Promise<UpdateResult> {
    this.app.touch();
    return runUpdate(page, siteTopUrl, siteId, this.deps(hooks), options);
  }

  /** Prepare a withdrawal flow while leaving the irreversible final action to the user (#129). */
  withdraw(page: Page, siteTopUrl: string, siteId: string, hooks: AppRunnerHooks): Promise<WithdrawalResult> {
    this.app.touch();
    return runWithdrawal(page, siteTopUrl, siteId, this.deps(hooks));
  }

  /** Read import candidates from an existing account/profile page (#84). */
  importExistingAccount(page: Page, profileUrl: string): Promise<ImportResult> {
    this.app.touch();
    return runExistingAccountImport(page, profileUrl, this.mapper, this.app.store);
  }

  private deps(hooks: AppRunnerHooks): AgentDeps {
    // `this.app.store` throws SoroeruAppError if the shell is not unlocked,
    // enforcing the boundary before any browser side effects happen.
    const deps: AgentDeps = {
      store: this.app.store,
      mapper: this.mapper,
      gate: hooks.gate,
      promptUser: hooks.promptUser,
      log: hooks.log,
    };
    // `exactOptionalPropertyTypes` forbids assigning `undefined` to an
    // optional property, so omit unset hooks rather than spreading them.
    if (hooks.handoff) deps.handoff = hooks.handoff;
    if (hooks.humanFinalSubmit) deps.humanFinalSubmit = hooks.humanFinalSubmit;
    return deps;
  }
}
