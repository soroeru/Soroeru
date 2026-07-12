import type { DomainService } from "../domain/domain-service.js";
import type { Credential, SiteAccount } from "../domain/entities.js";
import type { PageSnapshot } from "../types.js";
import { collectDuringExploration } from "./disclosure-collector.js";
import { DecisionEngine, type AiEngine } from "./decision-engine.js";
import {
  findLoginField,
  findLoginLink,
  findLoginSubmitButton,
  findSsoLoginOptions,
  hasLoginFields,
  type SsoLoginOption,
} from "./login-handler.js";
import { noopLogger, type Logger } from "../logging/logger.js";
import { PageExplorer } from "./page-explorer.js";
import { RuleEngine } from "./rule-engine.js";
import type { SiteSession } from "./page-driver.js";
import { WallDetectionService } from "./wall-detection.js";

export type VisibilityHandoff = (input: {
  siteAccount: SiteAccount;
  instruction: string;
  evidence: string;
  credential?: Credential;
}) => Promise<"resolved" | "abort">;

export interface VisibilityRunnerOptions {
  domain: DomainService;
  openSession: (siteAccount: SiteAccount) => Promise<SiteSession>;
  handoff?: VisibilityHandoff;
  isCanceled?: () => boolean;
  maxHandoffs?: number;
  now?: () => number;
  /** Optional AI fallback for DecisionEngine (Issue #310); absent = rules-only, today's behavior. */
  aiEngine?: AiEngine;
  /** Plain-text diagnostics sink for run outcomes / failure reasons (Issue #314); defaults to a no-op. */
  logger?: Logger;
}

export interface VisibilityRunResult {
  siteAccountId: string;
  status:
    | "collected"
    | "handoff"
    | "failed"
    | "unreachable"
    | "skipped"
    | "login-failed"
    | "no-data"
    | "canceled";
  disclosures: number;
  relationships: number;
  constraints: number;
}

export class VisibilityRunner {
  private readonly wallDetection = new WallDetectionService();
  private readonly now: () => number;
  private readonly logger: Logger;

  constructor(private readonly options: VisibilityRunnerOptions) {
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? noopLogger;
  }

  async runSite(siteAccountId: string): Promise<VisibilityRunResult> {
    const siteAccount = this.requireSite(siteAccountId);
    const credential = this.options.domain.listCredentialsForSite(siteAccountId)[0];

    // Soroeru drives a web browser; a non-web credential (e.g. an Android app
    // imported as `android://...`) has nothing to collect and must not be
    // mislabelled as a transient network failure.
    // egress: target-site — resolve the navigation target to the imported site only (no network call here).
    const targetUrl = siteAccount.url ?? `https://${siteAccount.domain}/`;
    if (!isHttpUrl(targetUrl)) {
      this.recordNonWeb(siteAccount, targetUrl);
      return { siteAccountId, status: "skipped", disclosures: 0, relationships: 0, constraints: 1 };
    }

    this.options.domain.saveCheckpoint({
      workflow: "visibility",
      siteAccountId,
      step: "open-session",
      status: "in-progress",
    });

    let session: SiteSession | undefined;
    try {
      if (this.isCanceled()) return this.canceledResult(siteAccountId);
      session = await this.options.openSession(siteAccount);
      if (this.isCanceled()) return this.canceledResult(siteAccountId);
      // egress: target-site — navigate only to the site account the user imported/selected.
      await session.page.goto(targetUrl);
      if (this.isCanceled()) return this.canceledResult(siteAccountId);
      await session.page.waitForReady();
      if (this.isCanceled()) return this.canceledResult(siteAccountId);
      let snapshot = await this.clearOrPause(
        siteAccount,
        session,
        await session.page.snapshot(),
        "initial",
        credential,
      );
      if (this.isCanceled()) return this.canceledResult(siteAccountId);
      if (!snapshot) return this.handoffResult(siteAccountId);

      if (credential) {
        snapshot = await this.ensureLoginPage(siteAccount, session, snapshot);
        if (this.isCanceled()) return this.canceledResult(siteAccountId);
        snapshot = await this.clearOrPause(siteAccount, session, snapshot, "login-page", credential);
        if (this.isCanceled()) return this.canceledResult(siteAccountId);
        if (!snapshot) return this.handoffResult(siteAccountId);

        // Issue #351: SSO hand-off is single-shot per site run (independent of wall maxHandoffs).
        let ssoHandoffOffered = false;
        const loginPageSnapshot = snapshot;
        const attemptedPasswordLogin = hasLoginFields(snapshot);

        // Problem 1: no ID/PW fields, SSO buttons only → ask the user to complete SSO.
        if (!attemptedPasswordLogin) {
          const ssoOptions = findSsoLoginOptions(snapshot);
          if (ssoOptions.length > 0) {
            ssoHandoffOffered = true;
            const ssoOutcome = await this.offerSsoLoginHandoff({
              siteAccount,
              snapshot,
              step: "login-page",
              detailPrefix: "sso-login-required",
              options: ssoOptions,
              // Problem 1: no site password to re-try; do not offer the imported credential.
              credential: undefined,
              instruction: ssoLoginRequiredInstruction(ssoOptions),
            });
            if (ssoOutcome !== "resolved") return this.handoffResult(siteAccountId);
            if (this.isCanceled()) return this.canceledResult(siteAccountId);
            snapshot = await session.page.snapshot();
          }
        }

        // Only attempt ID/PW fill when the pre-SSO login page actually had those fields.
        // After an SSO-only hand-off the page may already be the account UI; do not
        // re-fill or re-submit a login form on that page.
        if (attemptedPasswordLogin) {
          await this.login(session, credential, snapshot);
          if (this.isCanceled()) return this.canceledResult(siteAccountId);
        }
        await session.page.waitForReady();
        if (this.isCanceled()) return this.canceledResult(siteAccountId);
        snapshot = await this.clearOrPause(
          siteAccount,
          session,
          await session.page.snapshot(),
          "after-login",
          credential,
        );
        if (this.isCanceled()) return this.canceledResult(siteAccountId);
        if (!snapshot) return this.handoffResult(siteAccountId);

        // Problem 2: ID/PW was submitted but we are still on a login page and SSO exists.
        if (attemptedPasswordLogin && hasLoginFields(snapshot) && !ssoHandoffOffered) {
          const afterLoginSso = findSsoLoginOptions(snapshot);
          const ssoOptions =
            afterLoginSso.length > 0 ? afterLoginSso : findSsoLoginOptions(loginPageSnapshot);
          if (ssoOptions.length > 0) {
            ssoHandoffOffered = true;
            const ssoOutcome = await this.offerSsoLoginHandoff({
              siteAccount,
              snapshot,
              step: "after-login",
              detailPrefix: "sso-fallback-suggested",
              options: ssoOptions,
              // Same spirit as wall hand-off on login: user may re-try ID/PW manually.
              credential,
              instruction: ssoFallbackInstruction(ssoOptions),
            });
            if (ssoOutcome !== "resolved") {
              this.recordLoginFailed(siteAccount, snapshot);
              const constraints = this.options.domain
                .listConstraints()
                .filter((c) => c.siteAccountId === siteAccountId).length;
              return {
                siteAccountId,
                status: "login-failed",
                disclosures: 0,
                relationships: 0,
                constraints,
              };
            }
            if (this.isCanceled()) return this.canceledResult(siteAccountId);
            snapshot = await session.page.snapshot();
          }
        }
      }

      const constraints = this.recordTosConstraint(siteAccount, snapshot);
      if (this.isCanceled()) return this.canceledResult(siteAccountId);
      const explorer = new PageExplorer(
        new DecisionEngine(new RuleEngine(), this.options.aiEngine),
        this.wallDetection,
      );
      const collection = await this.collectFromExploration(siteAccount, session, explorer, snapshot);
      if (collection.interruptedByWall) return this.handoffResult(siteAccountId);
      const relationships = this.recordRelationships(siteAccount, snapshot);
      if (this.isCanceled()) return this.canceledResult(siteAccountId);

      // Honest completion (review #177 P1): zero disclosures is never reported as
      // "collected" — that would be a false-positive completion the Product Owner
      // cannot trust. We distinguish two zero-collection outcomes:
      //   - a password field still on the final page → the login did not take
      //     (rotated password, an extra step, or a silent failure);
      //   - otherwise → we reached a page but found nothing to collect (the page
      //     may show values as plain text, or it was an unexpected landing page).
      // A page whose only content is a required field the classifier can't map yet
      // still recorded a dynamic-attribute candidate (review #225) — that is real
      // progress, not an empty collection, so it must not be misreported as no-data.
      // A still-present password field, however, means login itself did not take,
      // and an unrelated dynamic candidate on that same login page (e.g. a promo or
      // locale field) must never mask that failure — so this check always takes
      // precedence over the dynamic-candidate rescue below.
      if (collection.disclosures === 0) {
        if (credential && findLoginField(snapshot.fields, "password")) {
          const loginConstraints = this.recordLoginFailed(siteAccount, snapshot);
          return {
            siteAccountId,
            status: "login-failed",
            disclosures: 0,
            relationships,
            constraints: constraints + loginConstraints,
          };
        }
        if (collection.dynamicCandidates === 0) {
          const noDataConstraints = this.recordNoData(siteAccount, snapshot);
          return {
            siteAccountId,
            status: "no-data",
            disclosures: 0,
            relationships,
            constraints: constraints + noDataConstraints,
          };
        }
      }

      this.options.domain.saveCheckpoint({
        workflow: "visibility",
        siteAccountId,
        step: "collected",
        status: "done",
        resumeData: {
          url: session.page.currentUrl(),
          disclosures: collection.disclosures,
          relationships,
          constraints,
        },
      });

      this.logger.info("visibility", "collection completed", {
        domain: siteAccount.domain,
        disclosures: collection.disclosures,
        relationships,
        constraints,
      });
      return {
        siteAccountId,
        status: "collected",
        disclosures: collection.disclosures,
        relationships,
        constraints,
      };
    } catch (err) {
      if (this.isCanceled()) return this.canceledResult(siteAccountId);
      const unreachableReason = unreachableReasonFor(err);
      this.options.domain.saveCheckpoint({
        workflow: "visibility",
        siteAccountId,
        step: unreachableReason ? "unreachable" : "failed",
        status: "failed",
        resumeData: unreachableReason
          ? { reason: unreachableReason, url: siteAccount.url ?? siteAccount.domain }
          : { message: err instanceof Error ? err.message : String(err) },
      });
      if (unreachableReason) {
        this.recordUnreachable(siteAccount, unreachableReason);
        return { siteAccountId, status: "unreachable", disclosures: 0, relationships: 0, constraints: 1 };
      }
      // Field named `error`, not `message`: the FileLogger envelope's own
      // `message` key is spread last and would clobber a caller field of the
      // same name, silently dropping the failure detail (Issue #317).
      this.logger.error("visibility", "run failed", {
        domain: siteAccount.domain,
        error: err instanceof Error ? err.message : String(err),
      });
      return { siteAccountId, status: "failed", disclosures: 0, relationships: 0, constraints: 0 };
    } finally {
      await session?.close();
    }
  }

  private isCanceled(): boolean {
    return this.options.isCanceled?.() ?? false;
  }

  private canceledResult(siteAccountId: string): VisibilityRunResult {
    this.options.domain.saveCheckpoint({
      workflow: "visibility",
      siteAccountId,
      step: "canceled",
      status: "failed",
      resumeData: { reason: "user-canceled" },
    });
    // Include the domain (when the id resolves) for the same log-analysis
    // domain join as handoffResult — a cancel logged only by siteAccountId
    // would count as a second site in the per-domain outcome reduction.
    const domain = this.options.domain.getSiteAccount(siteAccountId)?.domain;
    this.logger.info("visibility", "run canceled", {
      siteAccountId,
      ...(domain !== undefined ? { domain } : {}),
    });
    return { siteAccountId, status: "canceled", disclosures: 0, relationships: 0, constraints: 0 };
  }

  private async ensureLoginPage(
    siteAccount: SiteAccount,
    session: SiteSession,
    snapshot: PageSnapshot,
  ): Promise<PageSnapshot> {
    if (hasLoginFields(snapshot)) return snapshot;

    const loginLink = findLoginLink(snapshot, siteAccount.domain);
    if (!loginLink) return snapshot;

    this.options.domain.upsertSiteAccount({
      id: siteAccount.id,
      domain: siteAccount.domain,
      url: loginLink,
      displayName: siteAccount.displayName,
      ...(siteAccount.relationshipSummary !== undefined
        ? { relationshipSummary: siteAccount.relationshipSummary }
        : {}),
    });
    this.options.domain.saveCheckpoint({
      workflow: "visibility",
      siteAccountId: siteAccount.id,
      step: "login-discovered",
      status: "in-progress",
      resumeData: { url: loginLink },
    });
    await session.page.goto(loginLink);
    await session.page.waitForReady();
    return session.page.snapshot();
  }

  private requireSite(siteAccountId: string): SiteAccount {
    const siteAccount = this.options.domain.getSiteAccount(siteAccountId);
    if (!siteAccount) throw new Error(`unknown site account: ${siteAccountId}`);
    return siteAccount;
  }

  private async clearOrPause(
    siteAccount: SiteAccount,
    session: SiteSession,
    snapshot: PageSnapshot,
    step: string,
    credential: Credential | undefined,
  ): Promise<PageSnapshot | undefined> {
    const maxHandoffs = this.options.maxHandoffs ?? 3;
    let current = snapshot;
    for (let handoffs = 0; handoffs <= maxHandoffs; handoffs++) {
      const wall = this.wallDetection.detect(current);
      if (!wall) return current;

      const evidence = this.options.domain.addEvidence({
        siteAccountId: siteAccount.id,
        pageUrl: current.url,
        observedAt: this.now(),
        maskedSnippet: wall.evidence,
      });
      this.options.domain.addConstraint({
        siteAccountId: siteAccount.id,
        kind: "wall",
        detail: `${wall.kind}: ${wall.evidence}`,
        evidenceIds: [evidence.id],
        observedAt: this.now(),
      });
      this.options.domain.saveCheckpoint({
        workflow: "visibility",
        siteAccountId: siteAccount.id,
        step,
        status: "handoff",
        resumeData: { wall: wall.kind, url: current.url },
      });
      this.logger.warn("visibility", "wall detected", {
        domain: siteAccount.domain,
        wall: wall.kind,
        step,
      });

      if (!this.options.handoff || handoffs === maxHandoffs) return undefined;
      const outcome = await this.options.handoff({
        siteAccount,
        instruction: this.wallDetection.instructionFor(wall),
        evidence: wall.evidence,
        ...(credential && shouldOfferHandoffCredential(step, current, wall.kind) ? { credential } : {}),
      });
      if (outcome !== "resolved") return undefined;
      this.options.domain.saveCheckpoint({
        workflow: "visibility",
        siteAccountId: siteAccount.id,
        step: `${step}:resume`,
        status: "in-progress",
        resumeData: { url: session.page.currentUrl() },
      });
      current = await session.page.snapshot();
    }
    return undefined;
  }

  private async collectFromExploration(
    siteAccount: SiteAccount,
    session: SiteSession,
    explorer: PageExplorer,
    startSnapshot: PageSnapshot,
  ): Promise<{ disclosures: number; dynamicCandidates: number; interruptedByWall: boolean }> {
    const maxHandoffs = this.options.maxHandoffs ?? 3;
    let handoffs = 0;
    let collected = await collectDuringExploration(
      explorer.explore(session.page, startSnapshot.url, siteAccount, startSnapshot),
      {
        domain: this.options.domain,
        siteAccount,
        pageDriver: session.page,
        now: this.now,
        isCanceled: () => this.isCanceled(),
      },
    );

    while (collected.wall) {
      const wall = collected.wall;
      const evidence = this.options.domain.addEvidence({
        siteAccountId: siteAccount.id,
        pageUrl: wall.url,
        observedAt: this.now(),
        maskedSnippet: wall.wall.evidence,
      });
      this.options.domain.addConstraint({
        siteAccountId: siteAccount.id,
        kind: "wall",
        detail: `${wall.wall.kind}: ${wall.wall.evidence}`,
        evidenceIds: [evidence.id],
        observedAt: this.now(),
      });
      this.options.domain.saveCheckpoint({
        workflow: "visibility",
        siteAccountId: siteAccount.id,
        step: "exploration",
        status: "handoff",
        resumeData: { wall: wall.wall.kind, url: wall.url },
      });
      this.logger.warn("visibility", "wall detected", {
        domain: siteAccount.domain,
        wall: wall.wall.kind,
        step: "exploration",
      });

      if (!this.options.handoff || handoffs >= maxHandoffs) {
        return {
          disclosures: collected.disclosures,
          dynamicCandidates: collected.dynamicCandidates,
          interruptedByWall: true,
        };
      }
      handoffs++;
      const outcome = await this.options.handoff({
        siteAccount,
        instruction: this.wallDetection.instructionFor(wall.wall),
        evidence: wall.wall.evidence,
      });
      if (outcome !== "resolved") {
        return {
          disclosures: collected.disclosures,
          dynamicCandidates: collected.dynamicCandidates,
          interruptedByWall: true,
        };
      }

      this.options.domain.saveCheckpoint({
        workflow: "visibility",
        siteAccountId: siteAccount.id,
        step: "exploration:resume",
        status: "in-progress",
        resumeData: { url: session.page.currentUrl() },
      });
      collected = await collectDuringExploration(explorer.resume(), {
        domain: this.options.domain,
        siteAccount,
        pageDriver: session.page,
        now: this.now,
        isCanceled: () => this.isCanceled(),
      });
    }
    return {
      disclosures: collected.disclosures,
      dynamicCandidates: collected.dynamicCandidates,
      interruptedByWall: false,
    };
  }

  private async login(session: SiteSession, credential: Credential, snapshot: PageSnapshot): Promise<void> {
    const username = findLoginField(snapshot.fields, "username");
    const password = findLoginField(snapshot.fields, "password");
    if (!username && !password) return;
    if (username) await session.page.fillField(username.fieldId, credential.username);
    if (password) await session.page.fillField(password.fieldId, credential.password);
    const submit = findLoginSubmitButton(snapshot.buttons);
    if (submit) await session.page.click(submit.selector);
  }

  /**
   * Issue #351: pause for the user to complete SSO in the same headed session.
   * Never clicks SSO buttons, never navigates to IdPs, never selects accounts.
   * Returns "resolved" only when the hand-off callback says so; missing handoff
   * is treated like abort (caller decides terminal status).
   */
  private async offerSsoLoginHandoff(input: {
    siteAccount: SiteAccount;
    snapshot: PageSnapshot;
    step: "login-page" | "after-login";
    detailPrefix: "sso-login-required" | "sso-fallback-suggested";
    options: SsoLoginOption[];
    credential: Credential | undefined;
    instruction: string;
  }): Promise<"resolved" | "abort"> {
    const providers = input.options.map((o) => o.provider);
    const labels = input.options.map((o) => o.label).join(", ");
    const evidence = this.options.domain.addEvidence({
      siteAccountId: input.siteAccount.id,
      pageUrl: input.snapshot.url,
      observedAt: this.now(),
      // Structure only: detected control labels, never account ids or secrets.
      maskedSnippet: `sso login options: ${labels}`,
    });
    this.options.domain.addConstraint({
      siteAccountId: input.siteAccount.id,
      kind: "unknown-state",
      detail: `${input.detailPrefix}: ${providers.join(",")}`,
      evidenceIds: [evidence.id],
      observedAt: this.now(),
    });
    this.options.domain.saveCheckpoint({
      workflow: "visibility",
      siteAccountId: input.siteAccount.id,
      step: input.step,
      status: "handoff",
      resumeData: {
        handoff: "sso-login",
        providers: providers.join(","),
        url: input.snapshot.url,
      },
    });
    this.logger.warn("visibility", "sso login required", {
      domain: input.siteAccount.domain,
      providers: providers.join(","),
      step: input.step,
    });

    if (!this.options.handoff) return "abort";
    const outcome = await this.options.handoff({
      siteAccount: input.siteAccount,
      instruction: input.instruction,
      evidence: labels,
      ...(input.credential ? { credential: input.credential } : {}),
    });
    if (outcome !== "resolved") return "abort";
    this.options.domain.saveCheckpoint({
      workflow: "visibility",
      siteAccountId: input.siteAccount.id,
      step: `${input.step}:resume`,
      status: "in-progress",
      resumeData: { handoff: "sso-login", url: input.snapshot.url },
    });
    return "resolved";
  }

  private recordUnreachable(siteAccount: SiteAccount, reason: string): void {
    const evidenceInput: Parameters<DomainService["addEvidence"]>[0] = {
      siteAccountId: siteAccount.id,
      observedAt: this.now(),
      maskedSnippet: "site was unreachable during Visibility collection",
    };
    if (siteAccount.url !== undefined) evidenceInput.pageUrl = siteAccount.url;
    const evidence = this.options.domain.addEvidence(evidenceInput);
    this.options.domain.addConstraint({
      siteAccountId: siteAccount.id,
      kind: "unknown-state",
      detail: `access-unreachable: ${reason}`,
      evidenceIds: [evidence.id],
      observedAt: this.now(),
    });
    this.logger.warn("visibility", "site unreachable", { domain: siteAccount.domain, reason });
  }

  private recordNonWeb(siteAccount: SiteAccount, targetUrl: string): void {
    const evidence = this.options.domain.addEvidence({
      siteAccountId: siteAccount.id,
      observedAt: this.now(),
      maskedSnippet: "non-web credential skipped during Visibility collection",
    });
    this.options.domain.saveCheckpoint({
      workflow: "visibility",
      siteAccountId: siteAccount.id,
      step: "skipped",
      status: "failed",
      resumeData: { reason: "non-web-credential", scheme: schemeOf(targetUrl) },
    });
    this.options.domain.addConstraint({
      siteAccountId: siteAccount.id,
      kind: "unknown-state",
      detail: `non-web-credential: ${schemeOf(targetUrl)}`,
      evidenceIds: [evidence.id],
      observedAt: this.now(),
    });
    this.logger.info("visibility", "skipped non-web credential", {
      domain: siteAccount.domain,
      scheme: schemeOf(targetUrl),
    });
  }

  private recordLoginFailed(siteAccount: SiteAccount, snapshot: PageSnapshot): number {
    const evidence = this.options.domain.addEvidence({
      siteAccountId: siteAccount.id,
      pageUrl: snapshot.url,
      observedAt: this.now(),
      maskedSnippet: "still on a login page after submitting credentials",
    });
    this.options.domain.saveCheckpoint({
      workflow: "visibility",
      siteAccountId: siteAccount.id,
      step: "login-incomplete",
      status: "failed",
      resumeData: { url: snapshot.url },
    });
    this.options.domain.addConstraint({
      siteAccountId: siteAccount.id,
      kind: "unknown-state",
      detail: "login-incomplete: still on a login page after submitting credentials",
      evidenceIds: [evidence.id],
      observedAt: this.now(),
    });
    this.logger.warn("visibility", "login failed: still on a login page after submitting credentials", {
      domain: siteAccount.domain,
    });
    return 1;
  }

  private recordNoData(siteAccount: SiteAccount, snapshot: PageSnapshot): number {
    const evidence = this.options.domain.addEvidence({
      siteAccountId: siteAccount.id,
      pageUrl: snapshot.url,
      observedAt: this.now(),
      maskedSnippet: "reached the page but found no collectable form values",
    });
    this.options.domain.saveCheckpoint({
      workflow: "visibility",
      siteAccountId: siteAccount.id,
      step: "no-data",
      status: "failed",
      resumeData: { url: snapshot.url },
    });
    this.options.domain.addConstraint({
      siteAccountId: siteAccount.id,
      kind: "unknown-state",
      detail: "no-collectable-data: reached the page but found no collectable form values",
      evidenceIds: [evidence.id],
      observedAt: this.now(),
    });
    this.logger.info("visibility", "no collectable data found", { domain: siteAccount.domain });
    return 1;
  }

  private recordTosConstraint(siteAccount: SiteAccount, snapshot: PageSnapshot): number {
    const finding = this.wallDetection.detectTosProhibition(snapshot);
    if (!finding) return 0;
    const evidence = this.options.domain.addEvidence({
      siteAccountId: siteAccount.id,
      pageUrl: snapshot.url,
      observedAt: this.now(),
      maskedSnippet: finding.evidence,
    });
    this.options.domain.addConstraint({
      siteAccountId: siteAccount.id,
      kind: "tos-automation-prohibition",
      detail: finding.detail,
      evidenceIds: [evidence.id],
      observedAt: this.now(),
    });
    return 1;
  }

  private recordRelationships(siteAccount: SiteAccount, snapshot: PageSnapshot): number {
    const findings: Array<{ kind: "newsletter" | "recurring-billing" | "free-trial"; detail: string }> = [];
    if (/メールマガジン|ニュースレター|newsletter/i.test(snapshot.visibleText)) {
      findings.push({ kind: "newsletter", detail: "newsletter wording detected" });
    }
    if (/継続課金|定期購入|recurring|subscription/i.test(snapshot.visibleText)) {
      findings.push({ kind: "recurring-billing", detail: "recurring billing wording detected" });
    }
    if (/無料トライアル|free trial/i.test(snapshot.visibleText)) {
      findings.push({ kind: "free-trial", detail: "free-trial wording detected" });
    }
    for (const finding of findings) {
      this.options.domain.addAccountRelationship({
        siteAccountId: siteAccount.id,
        kind: finding.kind,
        state: "active",
        confidence: 0.7,
        observedAt: this.now(),
        detail: finding.detail,
      });
    }
    return findings.length;
  }

  private handoffResult(siteAccountId: string): VisibilityRunResult {
    const constraints = this.options.domain
      .listConstraints()
      .filter((constraint) => constraint.siteAccountId === siteAccountId).length;
    // Include the domain so the log analysis (Issue #317) can join this pause
    // with the site's preceding "wall detected" entry, which is keyed by domain.
    const domain = this.options.domain.getSiteAccount(siteAccountId)?.domain;
    this.logger.info("visibility", "run paused for wall hand-off", {
      siteAccountId,
      ...(domain !== undefined ? { domain } : {}),
    });
    return { siteAccountId, status: "handoff", disclosures: 0, relationships: 0, constraints };
  }
}

function shouldOfferHandoffCredential(step: string, snapshot: PageSnapshot, wallKind: string): boolean {
  return step === "login-page" || hasLoginFields(snapshot) || wallKind === "mfa";
}

function formatSsoProviderList(options: SsoLoginOption[]): string {
  const names = options.map((o) => {
    switch (o.provider) {
      case "google":
        return "Google";
      case "apple":
        return "Apple";
      case "facebook":
        return "Facebook";
      case "x":
        return "X";
      case "line":
        return "LINE";
      case "yahoo":
        return "Yahoo";
      case "other":
        return "その他のSSO";
    }
  });
  return names.join("、");
}

function ssoLoginRequiredInstruction(options: SsoLoginOption[]): string {
  const providers = formatSsoProviderList(options);
  return (
    `このサイトにはIDとパスワードの入力欄が見つかりませんでした。${providers}でのログインが利用できます。` +
    "開いているブラウザ画面で、あなた自身でSSOログインを行い、使用するアカウントを選択してください。" +
    "ログイン完了後に続行すると、Soroeruが残りの収集を引き継ぎます。"
  );
}

function ssoFallbackInstruction(options: SsoLoginOption[]): string {
  const providers = formatSsoProviderList(options);
  return (
    `IDとパスワードでのログインができませんでした。${providers}でのSSOログインをお試しください。` +
    "開いているブラウザ画面で、あなた自身でログインし、使用するアカウントを選択してください。" +
    "完了後に続行すると、Soroeruが残りの収集を引き継ぎます。"
  );
}

function isHttpUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function schemeOf(url: string): string {
  try {
    return new URL(url).protocol.replace(/:$/, "");
  } catch {
    return "unknown";
  }
}

function unreachableReasonFor(err: unknown): string | undefined {
  const message = err instanceof Error ? err.message : String(err);
  if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND/i.test(message)) return "dns-not-found";
  if (/ERR_CONNECTION_REFUSED|ECONNREFUSED/i.test(message)) return "connection-refused";
  if (/ERR_TIMED_OUT|timeout/i.test(message)) return "timeout";
  if (/ERR_CERT|certificate/i.test(message)) return "certificate-error";
  if (/net::ERR_|Navigation|goto/i.test(message)) return "navigation-failed";
  return undefined;
}
