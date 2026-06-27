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
import type { AttributeSummary, DomainSummary, VaultMutationResult, VaultStatus } from "./ipc/contract.js";

/** Mask a value to a fixed-width bullet preview that reveals at most its length. */
function maskPreview(value: string): string {
  if (value.length === 0) return "";
  return "•".repeat(Math.min(value.length, 8));
}

export class SoroeruSession {
  private vault: VaultV2 | undefined;
  private domain: DomainService | undefined;

  constructor(private readonly vaultPath: string) {}

  async status(): Promise<VaultStatus> {
    return {
      exists: await vaultExists(this.vaultPath),
      locked: this.vault === undefined || this.vault.isLocked,
    };
  }

  /** First-run vault creation. Fails if a vault already exists at the path. */
  async setup(passphrase: string): Promise<VaultMutationResult> {
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

  lock(): VaultMutationResult {
    this.vault?.lock();
    this.vault = undefined;
    this.domain = undefined;
    return { ok: true, locked: true };
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
}
