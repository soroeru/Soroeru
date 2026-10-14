// Vault-backed ledger, import, and reveal handlers shared by the Electron main
// process and the extension Side Panel (Issue #569). Browser-safe: no Node
// built-ins, no Playwright. Each surface supplies the unlocked vault/domain
// context, a collection lock, and (for saved pages) a page renderer; this
// module owns the sanitized views and the persistence order.

import { importPasswordCsv, CsvImportError } from "../domain/csv-import.js";
import { computeLedgerInsights } from "../domain/ledger-insights.js";
import type { DomainService } from "../domain/domain-service.js";
import { FIXED_ATTRIBUTE_LABELS, displayLabelWithAttributeKey } from "../domain/attribute-labels.js";
import {
  isSensitiveAttributeKey,
  MOST_SENSITIVE_ATTRIBUTE_KEY,
  type Credential,
  type SiteAccount,
  type Sensitivity,
} from "../domain/entities.js";
import { importSavedPageWith, MAX_SAVED_PAGE_BYTES, type SavedPageRenderer } from "../automation/saved-page-core.js";
import { noopLogger, type Logger } from "../logging/logger.js";
import type { VaultV2 } from "../store/vault-v2.js";
import type {
  AttributeSummary,
  ConfirmDynamicAttributeCandidateRequest,
  ConfirmDynamicAttributeCandidateResult,
  CsvImportResult,
  DeleteSiteAccountRequest,
  DeleteSiteAccountResultView,
  DisclosureView,
  DomainSummary,
  LedgerInsights,
  PendingAttributeCandidateView,
  RevealResult,
  SavedPageImportRequest,
  SavedPageImportResult,
  SessionPersistenceMutationResult,
  SessionPersistenceView,
  SetSessionPersistenceRequest,
  SiteCredentialView,
  SiteLedgerDetail,
  SiteLedgerSummary,
  StaleTally,
  UpdateSiteCredentialRequest,
  UpdateSiteCredentialResultView,
} from "../../electron/ipc/contract.js";

/** The unlocked vault and its domain view; absent while locked. */
export interface LedgerContext {
  vault: VaultV2;
  domain: DomainService;
}

export interface LedgerAppServiceOptions {
  /** Current unlocked context, read on every call so lock state is always reflected. */
  context: () => LedgerContext | undefined;
  /**
   * Take the surface-wide collection lock shared with Visibility runs. Returns a
   * release function, or undefined when a collection is already running.
   */
  acquireCollection: () => (() => void) | undefined;
  /** True while a Visibility run or import holds the collection lock. */
  collectionBusy: () => boolean;
  /** Renders a saved page offline for structure scanning (Playwright or a sandboxed iframe). */
  savedPageRenderer?: SavedPageRenderer;
  logger?: Logger;
}

/** Mask a value to a fixed-width bullet preview that reveals at most its length. */
export function maskPreview(value: string): string {
  if (value.length === 0) return "";
  return "•".repeat(Math.min(value.length, 8));
}

/**
 * Only "sensitive"/"most-sensitive" disclosures (card data, the site password)
 * stay masked behind passphrase re-authentication (Issue #300). "normal"
 * disclosures (name, address, phone, account id, etc.) are already-imported,
 * already-known information the user wants to confirm immediately, so they
 * are shown as-is with no reveal gate.
 */
function previewFor(raw: string | undefined, sensitivity: Sensitivity): string {
  if (raw === undefined) return "";
  return sensitivity === "normal" ? raw : maskPreview(raw);
}

/** Sensitivity classification mirrors DomainService's; drives masking and reveal refusal. */
function sensitivityFor(attributeKey: string): Sensitivity {
  if (attributeKey === MOST_SENSITIVE_ATTRIBUTE_KEY) return "most-sensitive";
  if (isSensitiveAttributeKey(attributeKey)) return "sensitive";
  return "normal";
}

export class LedgerAppService {
  private readonly logger: Logger;

  constructor(private readonly options: LedgerAppServiceOptions) {
    this.logger = options.logger ?? noopLogger;
  }

  private get unlocked(): LedgerContext | undefined {
    const context = this.options.context();
    return context && !context.vault.isLocked ? context : undefined;
  }

  /** Build the sanitized domain summary. Returns a locked, empty view when locked. */
  domainSummary(): DomainSummary {
    const context = this.unlocked;
    if (!context) return { locked: true, siteAccountCount: 0, attributeCount: 0, attributes: [] };
    const attributes: AttributeSummary[] = context.domain.listPersonalAttributes().map((attr) => ({
      attributeKey: attr.attributeKey,
      label: attr.label,
      sensitivity: attr.sensitivity,
      hasValue: attr.value.length > 0,
      preview: maskPreview(attr.value),
    }));
    return {
      locked: false,
      siteAccountCount: context.domain.listSiteAccounts().length,
      attributeCount: attributes.length,
      attributes,
    };
  }

  // --- CSV import & queue review (RFC-002 §5.1) ---

  /**
   * Import a password-manager CSV (bytes or text) into the vault and persist it.
   * Parsing is local and the raw byte buffer is zeroed by the importer; only a
   * counts-only summary crosses back to the UI (never a raw credential).
   */
  async importCsv(data: string | Uint8Array): Promise<CsvImportResult> {
    const context = this.unlocked;
    if (!context) return { ok: false, error: "locked" };
    try {
      const summary = importPasswordCsv(context.domain, { data });
      await context.vault.save();
      this.logger.info("csv-import", "csv import completed", {
        importedCredentials: summary.importedCredentials,
        sitesCreated: summary.sitesCreated,
        sitesMatched: summary.sitesMatched,
        skipped: summary.skipped,
      });
      return { ok: true, summary };
    } catch (err) {
      // CsvImportError carries a safe reason code; anything else is reported opaquely.
      const reason = err instanceof CsvImportError ? err.reason : "import-failed";
      this.logger.warn("csv-import", "csv import failed", { reason });
      return { ok: false, error: reason };
    }
  }

  async importSavedPage(request: SavedPageImportRequest): Promise<SavedPageImportResult> {
    const context = this.unlocked;
    if (!context) return { ok: false, error: "locked" };
    const renderer = this.options.savedPageRenderer;
    if (!renderer) return { ok: false, error: "import-failed" };
    if (this.options.collectionBusy()) return { ok: false, error: "busy" };
    const siteAccount = context.domain.getSiteAccount(request.siteAccountId);
    if (!siteAccount) return { ok: false, error: "not-found" };
    if (!isSavedPageFile(request.fileName)) return { ok: false, error: "bad-file-type" };
    if (request.data.byteLength > MAX_SAVED_PAGE_BYTES) return { ok: false, error: "too-large" };
    const release = this.options.acquireCollection();
    if (!release) return { ok: false, error: "busy" };
    try {
      const summary = await importSavedPageWith(renderer, {
        domain: context.domain,
        siteAccount,
        data: request.data,
        fileName: request.fileName,
      });
      await context.vault.save();
      return {
        ok: true,
        summary: {
          siteAccountId: summary.siteAccountId,
          disclosures: summary.disclosures,
          ...(summary.sourceUrl !== undefined ? { sourceUrl: summary.sourceUrl } : {}),
          sourceHashPreview: summary.sourceHash.slice(0, 16),
          recommendSourceDeletion: summary.recommendSourceDeletion,
        },
      };
    } catch {
      return { ok: false, error: "import-failed" };
    } finally {
      release();
    }
  }

  /** The target-site URL to open after an explicit user action, or an error code. */
  siteUrl(siteAccountId: string): { ok: true; url: string } | { ok: false; error: string } {
    const context = this.unlocked;
    if (!context) return { ok: false, error: "locked" };
    const siteAccount = context.domain.getSiteAccount(siteAccountId);
    if (!siteAccount) return { ok: false, error: "not-found" };
    // egress: target-site — fallback URL opened only after an explicit user action.
    const url = safeExternalSiteUrl(siteAccount);
    if (!url) return { ok: false, error: "bad-url" };
    return { ok: true, url };
  }

  async markSavedPageManualCheck(siteAccountId: string): Promise<{ ok: boolean; error?: string }> {
    const context = this.unlocked;
    if (!context) return { ok: false, error: "locked" };
    if (this.options.collectionBusy()) return { ok: false, error: "busy" };
    const siteAccount = context.domain.getSiteAccount(siteAccountId);
    if (!siteAccount) return { ok: false, error: "not-found" };
    try {
      const observedAt = Date.now();
      context.domain.addConstraint({
        siteAccountId,
        kind: "unknown-state",
        detail: "保存ページ取り込みをスキップし、ユーザーがこのサイトを手動で確認する印を付けました。",
        observedAt,
        resolution: "user-stopped",
      });
      context.domain.saveCheckpoint({
        workflow: "visibility",
        siteAccountId,
        step: "manual-check",
        status: "failed",
        resumeData: { source: "manual-check" },
      });
      await context.vault.save();
      return { ok: true };
    } catch {
      return { ok: false, error: "mark-failed" };
    }
  }

  // --- Disclosure ledger (RFC-002 §4.2 / §5.1) ---

  /** Composed per-site ledger rows. Returns an empty list when locked. */
  ledgerSites(): SiteLedgerSummary[] {
    const context = this.unlocked;
    if (!context) return [];
    return context.domain
      .listSiteAccountsInManualOrder()
      .map((site) => this.composeSiteSummary(context.domain, site.id))
      .filter((summary): summary is SiteLedgerSummary => summary !== undefined);
  }

  /** Cross-cutting filters and the initial Reflection derived from the ledger (RFC-002 §5.3). */
  ledgerInsights(): LedgerInsights {
    const context = this.unlocked;
    if (!context) return { filters: [], reflection: [] };
    return computeLedgerInsights(context.domain);
  }

  /** The per-site composed ledger detail (masked disclosures, relationships, constraints). */
  ledgerSite(siteAccountId: string): SiteLedgerDetail | undefined {
    const context = this.unlocked;
    if (!context) return undefined;
    return this.composeSiteDetail(context.domain, siteAccountId);
  }

  /**
   * All sites' composed ledger detail in one call (Issue #301's spreadsheet-style
   * ledger view needs every site's disclosures at once to build its attribute
   * columns). Returns an empty list when locked. Fetches dynamic-attribute
   * candidates and constraints once and shares them across every site.
   */
  ledgerSiteDetails(): SiteLedgerDetail[] {
    const context = this.unlocked;
    if (!context) return [];
    const dynamicCandidates = context.domain.listDynamicAttributeCandidates();
    const constraints = context.domain.listConstraints();
    return context.domain
      .listSiteAccountsInManualOrder()
      .map((site) => this.composeSiteDetail(context.domain, site.id, { dynamicCandidates, constraints }))
      .filter((detail): detail is SiteLedgerDetail => detail !== undefined);
  }

  async reorderSiteAccounts(orderedIds: string[]): Promise<{ ok: boolean; error?: string }> {
    const context = this.unlocked;
    if (!context) return { ok: false, error: "locked" };
    const previousIds = context.domain.listSiteAccountsInManualOrder().map((site) => site.id);
    const result = context.domain.reorderSiteAccounts(orderedIds);
    if (!result.ok) return result;
    try {
      await context.vault.save();
      return { ok: true };
    } catch {
      context.domain.reorderSiteAccounts(previousIds);
      return { ok: false, error: "save-failed" };
    }
  }

  /**
   * Confirm a pending dynamic-attribute candidate as a reusable typed attribute
   * (dynamic schema growth, RFC-002 §7). This is the explicit user-confirmation
   * step required before a newly observed field becomes a reusable attribute —
   * it is never inferred or promoted automatically.
   */
  async confirmDynamicAttributeCandidate(
    request: ConfirmDynamicAttributeCandidateRequest,
  ): Promise<ConfirmDynamicAttributeCandidateResult> {
    const context = this.unlocked;
    if (!context) return { ok: false, error: "locked" };
    const proposedAttributeKey = request.proposedAttributeKey.trim();
    const label = request.label.trim();
    if (!proposedAttributeKey.startsWith("custom.") || label === "")
      return { ok: false, error: "invalid-request" };
    const isPendingCandidate = context.domain
      .listDynamicAttributeCandidates()
      .some(
        (candidate) =>
          candidate.status === "candidate" && candidate.proposedAttributeKey === proposedAttributeKey,
      );
    if (!isPendingCandidate) return { ok: false, error: "not-found" };
    try {
      context.domain.confirmDynamicAttributeCandidate({
        attributeKey: proposedAttributeKey as `custom.${string}`,
        label,
        matchTerms: request.matchTerms?.map((term) => term.trim()).filter((term) => term !== "") ?? [label],
      });
      await context.vault.save();
      return { ok: true };
    } catch {
      return { ok: false, error: "confirm-failed" };
    }
  }

  async deleteSiteAccount(request: DeleteSiteAccountRequest): Promise<DeleteSiteAccountResultView> {
    const context = this.unlocked;
    if (!context) return { ok: false, error: "locked" };
    if (!request.confirmedFourthBoundary) return { ok: false, error: "confirmation-required" };
    try {
      const result = context.domain.deleteSiteAccount(request.siteAccountId);
      if (!result.ok) return result;
      await context.vault.save();
      return result;
    } catch {
      return { ok: false, error: "delete-failed" };
    }
  }

  /**
   * Update a site's stored login credential (username and/or password) from the
   * ledger (Issue #362). Requires explicit overwrite acknowledgement. The
   * password never appears in the response or logs.
   */
  async updateSiteCredential(request: UpdateSiteCredentialRequest): Promise<UpdateSiteCredentialResultView> {
    const context = this.unlocked;
    if (!context) return { ok: false, error: "locked" };
    if (!request.confirmedOverwrite) return { ok: false, error: "confirmation-required" };
    if (!request.credentialId) return { ok: false, error: "invalid-request" };

    const existing = context.domain.getCredential(request.credentialId);
    if (!existing) return { ok: false, error: "not-found" };
    if (existing.siteAccountId !== request.siteAccountId) return { ok: false, error: "not-found" };

    try {
      const result = context.domain.updateCredential({
        credentialId: request.credentialId,
        ...(request.username !== undefined ? { username: request.username } : {}),
        ...(request.password !== undefined ? { password: request.password } : {}),
      });
      if (!result.ok) return { ok: false, error: result.error };
      await context.vault.save();
      return { ok: true, credential: toSiteCredentialView(result.credential) };
    } catch {
      return { ok: false, error: "update-failed" };
    }
  }

  // --- Session persistence (opt-in encrypted storageState, Issue #294) ---

  /** Toggle the per-site opt-in; disabling clears any persisted storageState immediately. */
  async setSessionPersistence(
    request: SetSessionPersistenceRequest,
  ): Promise<SessionPersistenceMutationResult> {
    const context = this.unlocked;
    if (!context) return { ok: false, error: "locked" };
    const site = context.domain.setSessionPersistenceEnabled(request.siteAccountId, request.enabled);
    if (!site) return { ok: false, error: "not-found" };
    await context.vault.save();
    return { ok: true, state: this.sessionPersistenceView(context.domain, request.siteAccountId) };
  }

  /** Explicit "clear now" while persistence stays enabled — the next run starts a fresh session. */
  async clearSessionPersistence(siteAccountId: string): Promise<SessionPersistenceMutationResult> {
    const context = this.unlocked;
    if (!context) return { ok: false, error: "locked" };
    if (!context.domain.getSiteAccount(siteAccountId)) return { ok: false, error: "not-found" };
    context.domain.clearPersistedSessionState(siteAccountId);
    await context.vault.save();
    return { ok: true, state: this.sessionPersistenceView(context.domain, siteAccountId) };
  }

  /**
   * Re-authenticated reveal of a single disclosed raw value. Requires the master
   * passphrase to be re-verified for this reveal; refuses most-sensitive values
   * (CVV) outright. Never logs the value.
   */
  async revealValue(disclosureId: string, passphrase: string): Promise<RevealResult> {
    const context = this.unlocked;
    if (!context) return { ok: false, error: "locked" };
    const disclosure = context.domain.getDisclosure(disclosureId);
    if (!disclosure) return { ok: false, error: "not-found" };
    if (sensitivityFor(disclosure.attributeKey) === "most-sensitive") {
      return { ok: false, error: "reveal-not-permitted" };
    }
    if (!(await context.vault.verifyPassphrase(passphrase))) return { ok: false, error: "reauth-failed" };
    if (disclosure.siteHeldValue === undefined) return { ok: false, error: "no-raw-value" };
    return { ok: true, value: disclosure.siteHeldValue };
  }

  private sessionPersistenceView(domain: DomainService, siteAccountId: string): SessionPersistenceView {
    const site = domain.getSiteAccount(siteAccountId);
    // Non-mutating read: this view backs a pure read path (`ledgerSite`), which
    // must not silently delete an expired session as a side effect of display.
    const state = domain.peekPersistedSessionState(siteAccountId);
    return {
      enabled: site?.persistSessionEnabled ?? false,
      hasPersistedSession: state !== undefined,
      ...(state ? { updatedAt: state.updatedAt, expiresAt: state.expiresAt } : {}),
    };
  }

  private composeSiteDetail(
    domain: DomainService,
    siteAccountId: string,
    shared?: {
      dynamicCandidates: ReturnType<DomainService["listDynamicAttributeCandidates"]>;
      constraints: ReturnType<DomainService["listConstraints"]>;
    },
  ): SiteLedgerDetail | undefined {
    const summary = this.composeSiteSummary(domain, siteAccountId);
    if (!summary) return undefined;
    const dynamicCandidates = shared?.dynamicCandidates ?? domain.listDynamicAttributeCandidates();
    const dynamicLabels = new Map<string, string>();
    for (const candidate of dynamicCandidates) {
      dynamicLabels.set(candidate.proposedAttributeKey, candidate.label);
      dynamicLabels.set(candidate.proposedAttributeKey.replace(/^custom\./, "custom.unknown."), candidate.label);
    }
    const pendingAttributeCandidates: PendingAttributeCandidateView[] = dynamicCandidates
      .filter(
        (candidate) =>
          candidate.status === "candidate" && (candidate.siteAccountIds?.includes(siteAccountId) ?? false),
      )
      .map((candidate) => ({
        id: candidate.id,
        label: candidate.label,
        proposedAttributeKey: candidate.proposedAttributeKey,
        matchTerms: candidate.matchTerms,
        observedAt: candidate.updatedAt,
      }));
    const disclosures: DisclosureView[] = domain
      .listDisclosuresForSite(siteAccountId)
      .map((disclosure) => {
        const sensitivity = sensitivityFor(disclosure.attributeKey);
        const canonical = domain.getPersonalAttribute(disclosure.attributeKey);
        const label =
          canonical?.label ??
          dynamicLabels.get(disclosure.attributeKey) ??
          FIXED_ATTRIBUTE_LABELS.get(disclosure.attributeKey);
        const raw = disclosure.siteHeldValue;
        return {
          disclosureId: disclosure.id,
          attributeKey: disclosure.attributeKey,
          label: displayLabelWithAttributeKey(disclosure.attributeKey, label),
          sensitivity,
          staleState: disclosure.staleState,
          sourceKind: disclosure.sourceKind,
          observedAt: disclosure.observedAt,
          preview: previewFor(raw, sensitivity),
          revealable: raw !== undefined && sensitivity === "sensitive",
          evidenceCount: disclosure.evidenceIds.length,
        };
      })
      .sort((a, b) => a.label.localeCompare(b.label));
    const relationships = domain.listAccountRelationshipsForSite(siteAccountId).map((r) => ({
      kind: r.kind,
      state: r.state,
      ...(r.detail !== undefined ? { detail: r.detail } : {}),
      observedAt: r.observedAt,
    }));
    const constraints = (shared?.constraints ?? domain.listConstraints())
      .filter((c) => c.siteAccountId === siteAccountId)
      .map((c) => ({
        kind: c.kind,
        detail: c.detail,
        ...(c.resolution !== undefined ? { resolution: c.resolution } : {}),
        observedAt: c.observedAt,
      }));
    // Preserve vault list order — Visibility uses listCredentialsForSite(...)[0]
    // with no sort (Issue #362: edit UI must target the same primary credential).
    const credentials: SiteCredentialView[] = domain
      .listCredentialsForSite(siteAccountId)
      .map((credential) => toSiteCredentialView(credential));
    return {
      ...summary,
      disclosures,
      relationships,
      constraints,
      pendingAttributeCandidates,
      credentials,
      sessionPersistence: this.sessionPersistenceView(domain, siteAccountId),
    };
  }

  /** Build one composed ledger summary for a site, or undefined if it is gone. */
  private composeSiteSummary(domain: DomainService, siteAccountId: string): SiteLedgerSummary | undefined {
    const site = domain.getSiteAccount(siteAccountId);
    if (!site) return undefined;
    const disclosures = domain.listDisclosuresForSite(siteAccountId);
    const stale: StaleTally = { current: 0, stale: 0, unknown: 0 };
    for (const disclosure of disclosures) stale[disclosure.staleState]++;
    const relationshipKinds = domain
      .listAccountRelationshipsForSite(siteAccountId)
      .filter((r) => r.state === "active")
      .map((r) => r.kind);
    const constraintCount = domain.listConstraints().filter((c) => c.siteAccountId === siteAccountId).length;
    const checkpointDone = domain.getCheckpoint("visibility", siteAccountId)?.status === "done";
    return {
      siteAccountId: site.id,
      domain: site.domain,
      displayName: site.displayName,
      ...(site.url !== undefined ? { url: site.url } : {}),
      credentialCount: domain.listCredentialsForSite(siteAccountId).length,
      disclosureCount: disclosures.length,
      stale,
      relationshipKinds: [...new Set(relationshipKinds)],
      constraintCount,
      collected: disclosures.length > 0 || checkpointDone,
    };
  }
}

/** Masked credential summary for the UI — never includes the password. */
function toSiteCredentialView(credential: Credential): SiteCredentialView {
  return {
    credentialId: credential.id,
    username: credential.username,
    updatedAt: credential.updatedAt,
    source: credential.source,
    passwordStale: credential.passwordStale === true,
  };
}

function isSavedPageFile(fileName: string): boolean {
  return /\.(html?|htm)$/i.test(fileName);
}

function safeExternalSiteUrl(siteAccount: SiteAccount): string | undefined {
  // egress: target-site — constructs only the target site URL that may be opened after explicit user action.
  const candidate = siteAccount.url ?? `https://${siteAccount.domain}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}
