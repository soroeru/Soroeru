import { classifyFieldsWithEvidence } from "../agent/classifier.js";
import type { DomainService } from "../domain/domain-service.js";
import type { Credential, SiteAccount } from "../domain/entities.js";
import type { FormField, MappingEntry, PageSnapshot } from "../types.js";
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
  status: "collected" | "handoff" | "failed";
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
      await session.page.goto(siteAccount.url ?? `https://${siteAccount.domain}/`);
      let snapshot = await this.clearOrPause(siteAccount, session, await session.page.snapshot(), "initial");
      if (!snapshot) return this.handoffResult(siteAccountId);

      if (credential) {
        await this.login(session, credential, snapshot);
        snapshot = await this.clearOrPause(siteAccount, session, await session.page.snapshot(), "after-login");
        if (!snapshot) return this.handoffResult(siteAccountId);
      }

      const constraints = this.recordTosConstraint(siteAccount, snapshot);
      const values = await session.page.readValues();
      const collection = this.collectFields(siteAccount, snapshot, values);
      const relationships = this.recordRelationships(siteAccount, snapshot);

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
      this.options.domain.saveCheckpoint({
        workflow: "visibility",
        siteAccountId,
        step: "failed",
        status: "failed",
        resumeData: { message: err instanceof Error ? err.message : String(err) },
      });
      return { siteAccountId, status: "failed", disclosures: 0, relationships: 0, constraints: 0 };
    } finally {
      await session?.close();
    }
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

  private collectFields(siteAccount: SiteAccount, snapshot: PageSnapshot, values: Record<string, string>): { disclosures: number } {
    const classification = classifyFieldsWithEvidence(snapshot.fields, []);
    let disclosures = 0;
    for (const entry of classification.plan.entries) {
      const field = snapshot.fields.find((candidate) => candidate.fieldId === entry.fieldId);
      const value = values[entry.fieldId];
      if (!field || value === undefined || value === "") continue;
      this.recordDisclosure(siteAccount, snapshot, field, entry, value);
      disclosures++;
    }

    for (const fieldId of classification.plan.unmappedRequired) {
      const field = snapshot.fields.find((candidate) => candidate.fieldId === fieldId);
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

function sourceKindForField(field: FormField): "form-field" | "billing-page" | "newsletter-setting" {
  const text = `${field.name} ${field.id} ${field.labels.join(" ")} ${field.nearbyText}`;
  if (/card|billing|請求|支払/.test(text)) return "billing-page";
  if (/newsletter|mailmagazine|メールマガジン|ニュースレター/.test(text)) return "newsletter-setting";
  return "form-field";
}
