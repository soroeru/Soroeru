// SoroeruSession: the trusted main-process owner of the Vault v2 lifecycle and
// DomainService (RFC-002 §2.1 / §3). It is the only thing that holds the
// decrypted vault and canonical values; the renderer reaches it solely through
// the typed IPC bridge, which returns sanitized views.
//
// This module is framework-free (no electron import) so it is unit-testable.
// It never logs decrypted values.

import { DomainService } from "../src/domain/domain-service.js";
import { VaultV2 } from "../src/store/vault-v2.js";
import { vaultExists } from "../src/store/vault.js";
import { importPasswordCsv, CsvImportError } from "../src/domain/csv-import.js";
import {
  isSensitiveAttributeKey,
  MOST_SENSITIVE_ATTRIBUTE_KEY,
  type Sensitivity,
} from "../src/domain/entities.js";
import { MIN_PASSPHRASE_LENGTH } from "./ipc/contract.js";
import type {
  AttributeSummary,
  CsvImportResult,
  DisclosureView,
  DomainSummary,
  RecoveryKeyResult,
  RevealResult,
  SiteLedgerDetail,
  SiteLedgerSummary,
  StaleTally,
  VaultMutationResult,
  VaultStatus,
} from "./ipc/contract.js";

/** Mask a value to a fixed-width bullet preview that reveals at most its length. */
function maskPreview(value: string): string {
  if (value.length === 0) return "";
  return "•".repeat(Math.min(value.length, 8));
}

/** Sensitivity classification mirrors DomainService's; drives masking and reveal refusal. */
function sensitivityFor(attributeKey: string): Sensitivity {
  if (attributeKey === MOST_SENSITIVE_ATTRIBUTE_KEY) return "most-sensitive";
  if (isSensitiveAttributeKey(attributeKey)) return "sensitive";
  return "normal";
}

export class SoroeruSession {
  private vault: VaultV2 | undefined;
  private domain: DomainService | undefined;

  constructor(private readonly vaultPath: string) {}

  async status(): Promise<VaultStatus> {
    return {
      exists: await vaultExists(this.vaultPath),
      locked: this.vault === undefined || this.vault.isLocked,
      hasRecoveryKey: this.vault?.hasRecoveryKey ?? false,
    };
  }

  /** First-run vault creation. Fails if a vault already exists at the path. */
  async setup(passphrase: string): Promise<VaultMutationResult> {
    if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
      return { ok: false, locked: true, error: "passphrase-too-short" };
    }
    if (await vaultExists(this.vaultPath)) {
      return { ok: false, locked: true, error: "vault-already-exists" };
    }
    this.vault = await VaultV2.open(this.vaultPath, passphrase);
    this.domain = new DomainService(this.vault);
    await this.vault.save();
    return { ok: true, locked: false };
  }

  /** Unlock an existing vault. A wrong passphrase fails GCM auth and is reported. */
  async unlock(passphrase: string): Promise<VaultMutationResult> {
    if (!(await vaultExists(this.vaultPath))) {
      return { ok: false, locked: true, error: "vault-not-found" };
    }
    try {
      this.vault = await VaultV2.open(this.vaultPath, passphrase);
      this.domain = new DomainService(this.vault);
      return { ok: true, locked: false };
    } catch {
      // Do not surface the underlying error: it must not leak vault internals.
      this.vault = undefined;
      this.domain = undefined;
      return { ok: false, locked: true, error: "unlock-failed" };
    }
  }

  /** Unlock an existing vault with its recovery key instead of the passphrase (RFC-002 §6). */
  async unlockWithRecoveryKey(recoveryKey: string): Promise<VaultMutationResult> {
    if (!(await vaultExists(this.vaultPath))) {
      return { ok: false, locked: true, error: "vault-not-found" };
    }
    try {
      this.vault = await VaultV2.openWithRecoveryKey(this.vaultPath, recoveryKey);
      this.domain = new DomainService(this.vault);
      return { ok: true, locked: false };
    } catch {
      // Wrong recovery key, or none configured: report uniformly, leak nothing.
      this.vault = undefined;
      this.domain = undefined;
      return { ok: false, locked: true, error: "unlock-failed" };
    }
  }

  lock(): VaultMutationResult {
    this.vault?.lock();
    this.vault = undefined;
    this.domain = undefined;
    return { ok: true, locked: true };
  }

  /**
   * Generate a one-time recovery key for the unlocked vault and persist its
   * wrap. The plaintext is returned exactly once for immediate display and is
   * never logged or re-fetchable.
   */
  async generateRecoveryKey(): Promise<RecoveryKeyResult> {
    if (!this.vault || this.vault.isLocked) return { ok: false, error: "locked" };
    try {
      const recoveryKey = await this.vault.setupRecoveryKey();
      await this.vault.save();
      return { ok: true, recoveryKey };
    } catch {
      return { ok: false, error: "recovery-failed" };
    }
  }

  /** Build the sanitized domain summary. Returns a locked, empty view when locked. */
  domainSummary(): DomainSummary {
    if (!this.domain || !this.vault || this.vault.isLocked) {
      return { locked: true, siteAccountCount: 0, attributeCount: 0, attributes: [] };
    }
    const attributes: AttributeSummary[] = this.domain.listPersonalAttributes().map((attr) => ({
      attributeKey: attr.attributeKey,
      label: attr.label,
      sensitivity: attr.sensitivity,
      hasValue: attr.value.length > 0,
      preview: maskPreview(attr.value),
    }));
    return {
      locked: false,
      siteAccountCount: this.domain.listSiteAccounts().length,
      attributeCount: attributes.length,
      attributes,
    };
  }

  // --- CSV import & queue review (RFC-002 §5.1) ---

  /**
   * Import a password-manager CSV (bytes or text) into the vault and persist it.
   * Parsing is local and the raw byte buffer is zeroed by the importer; only a
   * counts-only summary crosses back to the renderer (never a raw credential).
   */
  async importCsv(data: string | Uint8Array): Promise<CsvImportResult> {
    if (!this.domain || !this.vault || this.vault.isLocked) return { ok: false, error: "locked" };
    try {
      const summary = importPasswordCsv(this.domain, { data });
      await this.vault.save();
      return { ok: true, summary };
    } catch (err) {
      // CsvImportError carries a safe reason code; anything else is reported opaquely.
      return { ok: false, error: err instanceof CsvImportError ? err.reason : "import-failed" };
    }
  }

  // --- Disclosure ledger (RFC-002 §4.2 / §5.1) ---

  /** Composed per-site ledger rows. Returns an empty list when locked. */
  ledgerSites(): SiteLedgerSummary[] {
    if (!this.domain || !this.vault || this.vault.isLocked) return [];
    const domain = this.domain;
    return domain
      .listSiteAccounts()
      .map((site) => this.composeSiteSummary(site.id))
      .filter((summary): summary is SiteLedgerSummary => summary !== undefined)
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  /** The per-site composed ledger detail (masked disclosures, relationships, constraints). */
  ledgerSite(siteAccountId: string): SiteLedgerDetail | undefined {
    if (!this.domain || !this.vault || this.vault.isLocked) return undefined;
    const summary = this.composeSiteSummary(siteAccountId);
    if (!summary) return undefined;
    const disclosures: DisclosureView[] = this.domain
      .listDisclosuresForSite(siteAccountId)
      .map((disclosure) => {
        const sensitivity = sensitivityFor(disclosure.attributeKey);
        const canonical = this.domain?.getPersonalAttribute(disclosure.attributeKey);
        const raw = disclosure.siteHeldValue;
        return {
          disclosureId: disclosure.id,
          attributeKey: disclosure.attributeKey,
          label: canonical?.label ?? disclosure.attributeKey,
          sensitivity,
          staleState: disclosure.staleState,
          sourceKind: disclosure.sourceKind,
          observedAt: disclosure.observedAt,
          preview: raw !== undefined ? maskPreview(raw) : "",
          revealable: raw !== undefined && sensitivity !== "most-sensitive",
          evidenceCount: disclosure.evidenceIds.length,
        };
      })
      .sort((a, b) => a.label.localeCompare(b.label));
    const relationships = this.domain.listAccountRelationshipsForSite(siteAccountId).map((r) => ({
      kind: r.kind,
      state: r.state,
      ...(r.detail !== undefined ? { detail: r.detail } : {}),
      observedAt: r.observedAt,
    }));
    const constraints = this.domain
      .listConstraints()
      .filter((c) => c.siteAccountId === siteAccountId)
      .map((c) => ({
        kind: c.kind,
        detail: c.detail,
        ...(c.resolution !== undefined ? { resolution: c.resolution } : {}),
        observedAt: c.observedAt,
      }));
    return { ...summary, disclosures, relationships, constraints };
  }

  /**
   * Re-authenticated reveal of a single disclosed raw value. Requires the master
   * passphrase to be re-verified for this reveal; refuses most-sensitive values
   * (CVV) outright. Never logs the value.
   */
  async revealValue(disclosureId: string, passphrase: string): Promise<RevealResult> {
    if (!this.domain || !this.vault || this.vault.isLocked) return { ok: false, error: "locked" };
    const disclosure = this.domain.getDisclosure(disclosureId);
    if (!disclosure) return { ok: false, error: "not-found" };
    if (sensitivityFor(disclosure.attributeKey) === "most-sensitive") {
      return { ok: false, error: "reveal-not-permitted" };
    }
    if (!(await this.vault.verifyPassphrase(passphrase))) return { ok: false, error: "reauth-failed" };
    if (disclosure.siteHeldValue === undefined) return { ok: false, error: "no-raw-value" };
    return { ok: true, value: disclosure.siteHeldValue };
  }

  /** Build one composed ledger summary for a site, or undefined if it is gone. */
  private composeSiteSummary(siteAccountId: string): SiteLedgerSummary | undefined {
    if (!this.domain) return undefined;
    const site = this.domain.getSiteAccount(siteAccountId);
    if (!site) return undefined;
    const disclosures = this.domain.listDisclosuresForSite(siteAccountId);
    const stale: StaleTally = { current: 0, stale: 0, unknown: 0 };
    for (const disclosure of disclosures) stale[disclosure.staleState]++;
    const relationshipKinds = this.domain
      .listAccountRelationshipsForSite(siteAccountId)
      .filter((r) => r.state === "active")
      .map((r) => r.kind);
    const constraintCount = this.domain
      .listConstraints()
      .filter((c) => c.siteAccountId === siteAccountId).length;
    const checkpointDone = this.domain.getCheckpoint("visibility", siteAccountId)?.status === "done";
    return {
      siteAccountId: site.id,
      domain: site.domain,
      displayName: site.displayName,
      ...(site.url !== undefined ? { url: site.url } : {}),
      credentialCount: this.domain.listCredentialsForSite(siteAccountId).length,
      disclosureCount: disclosures.length,
      stale,
      relationshipKinds: [...new Set(relationshipKinds)],
      constraintCount,
      collected: disclosures.length > 0 || checkpointDone,
    };
  }
}
