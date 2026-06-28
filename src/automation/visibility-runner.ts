import { classifyFieldsWithEvidence } from "../agent/classifier.js";
import type { DomainService } from "../domain/domain-service.js";
import type { Credential, SiteAccount } from "../domain/entities.js";
import type { DisplayValueCandidate, FormField, MappingEntry, PageSnapshot } from "../types.js";
import { redactedEvidence } from "./evidence.js";
import type { SiteSession } from "./page-driver.js";
import { WallDetectionService } from "./wall-detection.js";

export type VisibilityHandoff = (input: { siteAccount: SiteAccount; instruction: string; evidence: string }) => Promise<"resolved" | "abort">;

export interface VisibilityRunnerOptions {
  domain: DomainService;
  openSession: (siteAccount: SiteAccount) => Promise<SiteSession>;
  handoff?: VisibilityHandoff;
  maxHandoffs?: number;
  now?: () => number;
}

export interface VisibilityRunResult {
  siteAccountId: string;
  status: "collected" | "handoff" | "failed" | "unreachable" | "skipped" | "login-failed" | "no-data";
  disclosures: number;
  relationships: number;
  constraints: number;
}

export class VisibilityRunner {
  private readonly wallDetection = new WallDetectionService();
  private readonly now: () => number;

  constructor(private readonly options: VisibilityRunnerOptions) {
    this.now = options.now ?? Date.now;
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
      session = await this.options.openSession(siteAccount);
      // egress: target-site — navigate only to the site account the user imported/selected.
      await session.page.goto(targetUrl);
      await session.page.waitForReady();
      let snapshot = await this.clearOrPause(siteAccount, session, await session.page.snapshot(), "initial");
      if (!snapshot) return this.handoffResult(siteAccountId);

      if (credential) {
        snapshot = await this.ensureLoginPage(siteAccount, session, snapshot);
        snapshot = await this.clearOrPause(siteAccount, session, snapshot, "login-page");
        if (!snapshot) return this.handoffResult(siteAccountId);
        await this.login(session, credential, snapshot);
        await session.page.waitForReady();
        snapshot = await this.clearOrPause(siteAccount, session, await session.page.snapshot(), "after-login");
        if (!snapshot) return this.handoffResult(siteAccountId);
      }

      const constraints = this.recordTosConstraint(siteAccount, snapshot);
      const values = await session.page.readValues();
      // Also collect read-only display values (account pages that render registered
      // info as text, not editable fields). Synthetic fields run through the same
      // deterministic classifier; the raw values stay local and are redacted/hashed.
      const displayValues = (await session.page.readDisplayValues?.()) ?? {};
      const displayFields = (snapshot.displayValues ?? []).map(toSyntheticField);
      const combinedFields = [...snapshot.fields, ...displayFields];
      const combinedValues = { ...values, ...displayValues };
      const collection = this.collectFields(siteAccount, snapshot, combinedFields, combinedValues);
      const relationships = this.recordRelationships(siteAccount, snapshot);

      // Honest completion (review #177 P1): zero disclosures is never reported as
      // "collected" — that would be a false-positive completion the Product Owner
      // cannot trust. We distinguish two zero-collection outcomes:
      //   - a password field still on the final page → the login did not take
      //     (rotated password, an extra step, or a silent failure);
      //   - otherwise → we reached a page but found nothing to collect (the page
      //     may show values as plain text, or it was an unexpected landing page).
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
        const noDataConstraints = this.recordNoData(siteAccount, snapshot);
        return {
          siteAccountId,
          status: "no-data",
          disclosures: 0,
          relationships,
          constraints: constraints + noDataConstraints,
        };
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

      return {
        siteAccountId,
        status: "collected",
        disclosures: collection.disclosures,
        relationships,
        constraints,
      };
    } catch (err) {
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
      return { siteAccountId, status: "failed", disclosures: 0, relationships: 0, constraints: 0 };
    } finally {
      await session?.close();
    }
  }

  private async ensureLoginPage(
    siteAccount: SiteAccount,
    session: SiteSession,
    snapshot: PageSnapshot,
  ): Promise<PageSnapshot> {
    if (hasLoginFields(snapshot)) return snapshot;

    const loginLink = findLoginLink(snapshot, siteAccount);
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

      if (!this.options.handoff || handoffs === maxHandoffs) return undefined;
      const outcome = await this.options.handoff({
        siteAccount,
        instruction: this.wallDetection.instructionFor(wall),
        evidence: wall.evidence,
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

  private async login(session: SiteSession, credential: Credential, snapshot: PageSnapshot): Promise<void> {
    const username = findLoginField(snapshot.fields, "username");
    const password = findLoginField(snapshot.fields, "password");
    if (!username && !password) return;
    if (username) await session.page.fillField(username.fieldId, credential.username);
    if (password) await session.page.fillField(password.fieldId, credential.password);
    const submit = snapshot.buttons.find((b) => /ログイン|login|sign in/i.test(b.text));
    if (submit) await session.page.click(submit.selector);
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

  private collectFields(
    siteAccount: SiteAccount,
    snapshot: PageSnapshot,
    fields: FormField[],
    values: Record<string, string>,
  ): { disclosures: number } {
    const classification = classifyFieldsWithEvidence(fields, []);
    let disclosures = 0;
    for (const entry of classification.plan.entries) {
      const field = fields.find((candidate) => candidate.fieldId === entry.fieldId);
      const value = values[entry.fieldId];
      if (!field || value === undefined || value === "") continue;
      this.recordDisclosure(siteAccount, snapshot, field, entry, value);
      disclosures++;
    }

    for (const fieldId of classification.plan.unmappedRequired) {
      const field = fields.find((candidate) => candidate.fieldId === fieldId);
      if (!field) continue;
      this.options.domain.addDisclosure({
        siteAccountId: siteAccount.id,
        attributeKey: `custom.unknown.${field.fieldId}`,
        observedAt: this.now(),
        sourcePageUrl: snapshot.url,
        sourceKind: "form-field",
        confidence: 0,
      });
      disclosures++;
    }
    return { disclosures };
  }

  private recordDisclosure(
    siteAccount: SiteAccount,
    snapshot: PageSnapshot,
    field: FormField,
    entry: MappingEntry,
    value: string,
  ): void {
    const label = field.labels[0] ?? field.placeholder ?? field.nearbyText ?? field.name ?? field.id;
    const evidence = this.options.domain.addEvidence(
      redactedEvidence({
        siteAccountId: siteAccount.id,
        pageUrl: snapshot.url,
        fieldLabel: label,
        fieldType: field.type,
        attributeKey: entry.profileKey,
        value,
        observedAt: this.now(),
      }),
    );
    const normalizedValueHash = evidence.normalizedHash;
    if (!normalizedValueHash) return;
    this.options.domain.addDisclosure({
      siteAccountId: siteAccount.id,
      attributeKey: entry.profileKey,
      normalizedValueHash,
      observedAt: this.now(),
      sourcePageUrl: snapshot.url,
      sourceKind: sourceKindForField(field),
      confidence: 1,
      evidenceIds: [evidence.id],
    });
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
    const constraints = this.options.domain.listConstraints().filter((constraint) => constraint.siteAccountId === siteAccountId).length;
    return { siteAccountId, status: "handoff", disclosures: 0, relationships: 0, constraints };
  }
}

function findLoginField(fields: FormField[], kind: "username" | "password"): FormField | undefined {
  if (kind === "password") return fields.find((field) => field.type === "password" || field.autocomplete === "current-password");
  return fields.find((field) => field.autocomplete === "username" || field.type === "email" || /mail|email|user|login/i.test(`${field.name} ${field.id}`));
}

function hasLoginFields(snapshot: PageSnapshot): boolean {
  return (
    findLoginField(snapshot.fields, "password") !== undefined &&
    findLoginField(snapshot.fields, "username") !== undefined
  );
}

function findLoginLink(snapshot: PageSnapshot, siteAccount: SiteAccount): string | undefined {
  const origin = originFor(snapshot.url);
  const candidates = snapshot.links
    .filter((link) => isSameSite(link.href, siteAccount.domain))
    .map((link) => ({
      href: absoluteHref(link.href, origin),
      score: loginLinkScore(link.text, link.href),
    }))
    .filter((candidate) => candidate.href && candidate.score > 0)
    .sort((a, b) => b.score - a.score);
  return candidates[0]?.href;
}

function loginLinkScore(text: string, href: string): number {
  const haystack = `${text} ${href}`;
  let score = 0;
  if (/ログイン|login|sign[\s_-]?in|サインイン|会員ログイン|マイページ/i.test(haystack)) score += 3;
  if (/account|member|auth|session|mypage/i.test(href)) score += 1;
  if (/logout|sign[\s_-]?out|登録|register|signup|sign[\s_-]?up/i.test(haystack)) score -= 5;
  return score;
}

function isSameSite(href: string, domain: string): boolean {
  try {
    const host = new URL(href).hostname.toLowerCase().replace(/^www\./, "");
    return host === domain || host.endsWith(`.${domain}`);
  } catch {
    return href.startsWith("/") || href.startsWith("./") || href.startsWith("../");
  }
}

function absoluteHref(href: string, origin: string | undefined): string | undefined {
  try {
    return origin ? new URL(href, origin).href : new URL(href).href;
  } catch {
    return undefined;
  }
}

function originFor(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/** A read-only display value as a synthetic FormField, so it flows through the
 * same deterministic classifier and redaction path as a real form field. */
function toSyntheticField(candidate: DisplayValueCandidate): FormField {
  return {
    fieldId: candidate.valueId,
    tag: "input",
    type: "text",
    name: "",
    id: "",
    autocomplete: "",
    required: false,
    placeholder: "",
    labels: candidate.labelText ? [candidate.labelText] : [],
    nearbyText: candidate.nearbyText,
  };
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

function sourceKindForField(field: FormField): "form-field" | "billing-page" | "newsletter-setting" {
  const text = `${field.name} ${field.id} ${field.labels.join(" ")} ${field.nearbyText}`;
  if (/card|billing|請求|支払/.test(text)) return "billing-page";
  if (/newsletter|mailmagazine|メールマガジン|ニュースレター/.test(text)) return "newsletter-setting";
  return "form-field";
}
