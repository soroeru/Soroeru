// DomainService (RFC-002 §3): typed services over the Vault v2 record vault for
// the Soroeru domain. This layer owns semantic operations the UI/automation
// call through (later via Electron IPC), the most important of which for
// Slice A is Disclosure stale-state derivation (RFC-002 §4.2): comparing what a
// site holds against the user's canonical value so the ledger can flag "stale".
//
// Policy / Delegation Boundary decisions and Account Relationship filters are
// reshaped around later Issues; this foundation provides the storage-backed
// entity operations and stale-state logic they build on. Raw values are never
// logged here.

// randomUUID replaced with globalThis.crypto.globalThis.crypto.randomUUID() for browser compatibility

import { AUTHORIZATION_POLICY_VERSION, authorize, normalizeScope, scopeContains, type Operation, type OperationContext, type AuthorizationDecision } from "./authorization.js";
import { FIXED_ATTRIBUTE_LABELS } from "./attribute-labels.js";
import type { Capability, CapabilityScope } from "./entities.js";
import type { CollectionGrant } from "./collection-authorization.js";
import { normalizedValueHash } from "./normalize.js";
import { deriveLedgerAllowedOrigins, isUrlInLedgerScope } from "./site-account-scope.js";
import {
  type AccountRelationship,
  type Constraint,
  type Credential,
  type Disclosure,
  type DisclosureSourceKind,
  type Evidence,
  type LocalDefinition,
  type PersonalAttribute,
  type SessionState,
  type SiteAccount,
  type SiteCollectionMap,
  type Sensitivity,
  type StaleState,
  type WorkflowCheckpoint,
} from "./entities.js";
import { isSensitiveAttributeKey, MOST_SENSITIVE_ATTRIBUTE_KEY } from "./entities.js";
import type { VaultV2 } from "../store/vault-v2.js";
import type { ProfileKey } from "../types.js";

export interface SetPersonalAttributeInput {
  attributeKey: string;
  label: string;
  value: string;
  valueType?: PersonalAttribute["valueType"];
  sensitivity?: Sensitivity;
}

export interface UpsertSiteAccountInput {
  id?: string;
  domain: string;
  url?: string;
  displayName: string;
  relationshipSummary?: string;
}

export interface DeleteSiteAccountResult {
  ok: boolean;
  error?: "not-found";
  deleted?: {
    siteAccounts: number;
    credentials: number;
    disclosures: number;
    evidence: number;
    accountRelationships: number;
    constraints: number;
    mandates: number;
  };
}

/** Fixed 30-day expiry, sliding on every successful re-export (Issue #294 decision). */
export const SESSION_STATE_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;

export interface AddCredentialInput {
  siteAccountId: string;
  username: string;
  password: string;
  note?: string;
  source?: Credential["source"];
}

/** Update an existing site login credential (password and/or username). Issue #362. */
export interface UpdateCredentialInput {
  credentialId: string;
  /** When set (after trim non-empty), replaces the stored login id. */
  username?: string;
  /** When set (non-empty), replaces the stored password. Empty string is rejected. */
  password?: string;
}

export type UpdateCredentialResult =
  | { ok: true; credential: Credential }
  | { ok: false; error: "not-found" | "invalid-request" };

export interface AddDisclosureInput {
  siteAccountId: string;
  attributeKey: string;
  siteHeldValue?: string;
  normalizedValueHash?: string;
  observedAt?: number;
  sourcePageUrl?: string;
  sourceKind: DisclosureSourceKind;
  /** Trusted collection caller selects this; omission preserves deterministic policy. */
  collectionTier?: Disclosure["collectionTier"];
  confidence?: number;
  evidenceIds?: string[];
}

export interface DynamicAttributeCandidateView {
  id: string;
  status: LocalDefinition["status"];
  label: string;
  proposedAttributeKey: ProfileKey;
  matchTerms: string[];
  fieldId?: string;
  sourcePageUrl?: string;
  /** Every site the candidate has been observed on so far. A field with the
   * same proposed key can be independently observed, unconfirmed, on more than
   * one site — each site's pending list must keep showing it until confirmed.
   * Absent once confirmed (a confirmed attribute is reusable across sites, so
   * it is no longer tied to the sites that happened to surface it). */
  siteAccountIds?: string[];
  createdAt: number;
  updatedAt: number;
}

export interface RecordDynamicAttributeCandidateInput {
  siteAccountId: string;
  label: string;
  fieldId: string;
  sourcePageUrl?: string;
  proposedAttributeKey: ProfileKey;
  matchTerms?: string[];
  now?: () => number;
}

export interface ConfirmDynamicAttributeCandidateInput {
  label: string;
  attributeKey: ProfileKey;
  matchTerms: string[];
  now?: () => number;
}

export class DomainService {
  constructor(private readonly vault: VaultV2, private readonly assertObservation?: (siteAccountId: string, attributeKey: string) => void) {}

  /** Default sensitivity from the attribute key when the caller does not specify one. */
  private static defaultSensitivity(attributeKey: string): Sensitivity {
    if (attributeKey === MOST_SENSITIVE_ATTRIBUTE_KEY) return "most-sensitive";
    if (isSensitiveAttributeKey(attributeKey)) return "sensitive";
    return "normal";
  }

  // --- Personal Attributes (canonical values) ---

  /**
   * Upsert a canonical Personal Attribute. The attribute key is used as the
   * record id so a given attribute is canonical (one value per key). Changing a
   * value recomputes the stale-state of every Disclosure for that attribute.
   *
   * Invariant: any path that *changes which canonical value an attribute key
   * resolves to* must call `recomputeStaleStatesForAttribute`. A future
   * `deletePersonalAttribute` must route through that recompute so its
   * Disclosures revert to `unknown` rather than staying pinned at current/stale.
   */
  setPersonalAttribute(input: SetPersonalAttributeInput): PersonalAttribute {
    if (/マイナンバー|個人番号|暗証番号|\bpin\b|my.?number|identity.?secret/i.test([input.attributeKey, input.label, input.value].join(" ")) || /^\d{12}$/.test(input.value.replace(/[\s-]/g, ""))) {
      throw new Error("forbidden canonical value");
    }
    const existing = this.getPersonalAttribute(input.attributeKey);
    // An unchanged manual edit must not mint a new record or drop verification.
    if (
      existing &&
      existing.value === input.value &&
      existing.label === input.label &&
      (input.valueType === undefined || existing.valueType === input.valueType) &&
      (input.sensitivity === undefined || existing.sensitivity === input.sensitivity)
    ) {
      return existing;
    }
    const attribute: PersonalAttribute = {
      provenance: { source: "user-entered", verification: "unverified" },
      id: input.attributeKey,
      attributeKey: input.attributeKey,
      label: input.label,
      value: input.value,
      valueType: input.valueType ?? "custom",
      sensitivity: input.sensitivity ?? DomainService.defaultSensitivity(input.attributeKey),
      updatedAt: Date.now(),
    };
    this.vault.put("personalAttribute", attribute);
    this.recomputeStaleStatesForAttribute(input.attributeKey);
    return attribute;
  }

  getPersonalAttribute(attributeKey: string): PersonalAttribute | undefined {
    return this.vault.get("personalAttribute", attributeKey);
  }

  listPersonalAttributes(): PersonalAttribute[] {
    return this.vault.list("personalAttribute");
  }

  // --- Site Accounts ---

  upsertSiteAccount(input: UpsertSiteAccountInput): SiteAccount {
    const id = input.id ?? globalThis.crypto.randomUUID();
    const existing = this.vault.get("siteAccount", id);
    const account: SiteAccount = {
      id,
      domain: input.domain,
      displayName: input.displayName,
      sortOrder: existing?.sortOrder ?? this.nextSiteAccountSortOrder(),
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    };
    if (input.url !== undefined) account.url = input.url;
    if (input.relationshipSummary !== undefined) account.relationshipSummary = input.relationshipSummary;
    this.vault.put("siteAccount", account);
    return account;
  }

  getSiteAccount(id: string): SiteAccount | undefined {
    return this.vault.get("siteAccount", id);
  }

  listSiteAccounts(): SiteAccount[] {
    return this.vault.list("siteAccount");
  }

  listAllowedLedgerOrigins(): string[] {
    return deriveLedgerAllowedOrigins(this.listSiteAccounts());
  }

  isUrlInLedgerScope(url: string): boolean {
    return isUrlInLedgerScope(url, this.listSiteAccounts());
  }

  /** Assign canonical order to pre-#387 records without disturbing already ordered sites. */
  ensureSiteAccountSortOrders(): boolean {
    const sites = this.listSiteAccounts();
    const missing = sites
      .filter((site) => !Number.isFinite(site.sortOrder))
      .sort((a, b) => a.displayName.localeCompare(b.displayName, "ja") || a.id.localeCompare(b.id));
    if (missing.length === 0) return false;
    let next = this.nextSiteAccountSortOrder();
    for (const site of missing) {
      this.vault.put("siteAccount", { ...site, sortOrder: next++ });
    }
    return true;
  }

  listSiteAccountsInManualOrder(): SiteAccount[] {
    return this.listSiteAccounts().sort(
      (a, b) =>
        (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER) ||
        a.displayName.localeCompare(b.displayName, "ja") ||
        a.id.localeCompare(b.id),
    );
  }

  reorderSiteAccounts(orderedIds: string[]): { ok: true } | { ok: false; error: "invalid-order" } {
    const sites = this.listSiteAccounts();
    if (
      orderedIds.length !== sites.length ||
      new Set(orderedIds).size !== orderedIds.length ||
      sites.some((site) => !orderedIds.includes(site.id))
    ) {
      return { ok: false, error: "invalid-order" };
    }
    const byId = new Map(sites.map((site) => [site.id, site]));
    orderedIds.forEach((id, sortOrder) => {
      const site = byId.get(id);
      if (site) this.vault.put("siteAccount", { ...site, sortOrder, updatedAt: Date.now() });
    });
    return { ok: true };
  }

  private nextSiteAccountSortOrder(): number {
    return this.listSiteAccounts().reduce(
      (next, site) => (Number.isFinite(site.sortOrder) ? Math.max(next, (site.sortOrder as number) + 1) : next),
      0,
    );
  }

  /**
   * Permanently remove a Site Account and its Soroeru-internal records. This is
   * the fourth absolute boundary at the UI/session layer; once called, the
   * vault entries are actually removed rather than hidden.
   */
  deleteSiteAccount(siteAccountId: string): DeleteSiteAccountResult {
    if (!this.getSiteAccount(siteAccountId)) return { ok: false, error: "not-found" };

    const credentials = this.listCredentialsForSite(siteAccountId);
    const disclosures = this.listDisclosuresForSite(siteAccountId);
    const relationships = this.listAccountRelationshipsForSite(siteAccountId);
    const constraints = this.listConstraints().filter(
      (constraint) => constraint.siteAccountId === siteAccountId,
    );
    const mandates = this.vault.list("mandate").filter((mandate) => mandate.siteAccountId === siteAccountId);
    const evidenceIds = new Set<string>();
    for (const evidence of this.listEvidence()) {
      if (evidence.siteAccountId === siteAccountId) evidenceIds.add(evidence.id);
    }
    for (const record of [...disclosures, ...relationships, ...constraints]) {
      for (const evidenceId of record.evidenceIds) evidenceIds.add(evidenceId);
    }

    let deletedCredentials = 0;
    let deletedDisclosures = 0;
    let deletedRelationships = 0;
    let deletedConstraints = 0;
    let deletedMandates = 0;
    for (const credential of credentials) {
      if (this.vault.delete("credential", credential.id)) deletedCredentials++;
    }
    for (const disclosure of disclosures) {
      if (this.vault.delete("disclosure", disclosure.id)) deletedDisclosures++;
    }
    for (const relationship of relationships) {
      if (this.vault.delete("accountRelationship", relationship.id)) deletedRelationships++;
    }
    for (const constraint of constraints) {
      if (this.vault.delete("constraint", constraint.id)) deletedConstraints++;
    }
    for (const mandate of mandates) {
      if (this.vault.delete("mandate", mandate.id)) deletedMandates++;
    }

    let deletedEvidence = 0;
    for (const evidenceId of evidenceIds) {
      if (this.isEvidenceStillReferenced(evidenceId, siteAccountId)) continue;
      if (this.vault.delete("evidence", evidenceId)) deletedEvidence++;
    }

    this.deleteSiteWorkflowCheckpoints(siteAccountId);
    this.removeSiteFromDynamicAttributeCandidates(siteAccountId);
    this.vault.delete("sessionState", siteAccountId);
    for (const map of this.vault.list("siteCollectionMap")) {
      if (map.siteAccountId === siteAccountId) this.vault.delete("siteCollectionMap", map.id);
    }
    const deletedSiteAccounts = this.vault.delete("siteAccount", siteAccountId) ? 1 : 0;
    return {
      ok: true,
      deleted: {
        siteAccounts: deletedSiteAccounts,
        credentials: deletedCredentials,
        disclosures: deletedDisclosures,
        evidence: deletedEvidence,
        accountRelationships: deletedRelationships,
        constraints: deletedConstraints,
        mandates: deletedMandates,
      },
    };
  }

  // --- Credentials ---

  addCredential(input: AddCredentialInput): Credential {
    const credential: Credential = {
      id: globalThis.crypto.randomUUID(),
      siteAccountId: input.siteAccountId,
      username: input.username,
      password: input.password,
      source: input.source ?? "user",
      updatedAt: Date.now(),
    };
    if (input.note !== undefined) credential.note = input.note;
    this.vault.put("credential", credential);
    return credential;
  }

  /**
   * Overwrite username and/or password on an existing credential. This is
   * Soroeru-internal data edit (not deletion / not the fourth absolute
   * boundary). The previous secret is replaced in the encrypted vault; callers
   * must not log the password. At least one of username or password must be a
   * non-empty change.
   */
  updateCredential(input: UpdateCredentialInput): UpdateCredentialResult {
    const existing = this.vault.get("credential", input.credentialId);
    if (!existing) return { ok: false, error: "not-found" };

    const nextUsername = input.username !== undefined ? input.username.trim() : undefined;
    // Passwords are not trimmed for content (spaces may be intentional) but a
    // whitespace-only string is treated as empty / invalid, same as username.
    const nextPassword = input.password !== undefined ? input.password : undefined;
    const passwordMeaningful =
      nextPassword !== undefined && nextPassword !== "" && nextPassword.trim() !== "";

    // Only count a username rewrite when it actually differs from the stored value
    // (no-op same-id updates must not flip source / bump updatedAt alone).
    const usernameChange =
      nextUsername !== undefined && nextUsername !== "" && nextUsername !== existing.username;
    const passwordChange = passwordMeaningful;
    if (!usernameChange && !passwordChange) return { ok: false, error: "invalid-request" };

    const credential: Credential = {
      ...existing,
      ...(usernameChange ? { username: nextUsername } : {}),
      ...(passwordChange ? { password: nextPassword } : {}),
      // User-initiated edit (even when the row was originally csv-import).
      source: "user",
      updatedAt: Date.now(),
    };
    // A new password is the user's current secret; clear the post-reset stale flag.
    if (passwordChange) delete credential.passwordStale;
    this.vault.put("credential", credential);
    return { ok: true, credential };
  }

  /**
   * Mark every stored password for a site as stale (Issue #416). Used after a
   * password-reset wall hand-off resolves: the vault value is definitionally
   * out of date if the user just reset it on the site. Idempotent; returns the
   * credentials that are now flagged (including ones already flagged).
   */
  markSiteCredentialsPasswordStale(siteAccountId: string, now: number = Date.now()): Credential[] {
    const updated: Credential[] = [];
    for (const existing of this.listCredentialsForSite(siteAccountId)) {
      if (existing.passwordStale) {
        updated.push(existing);
        continue;
      }
      const credential: Credential = {
        ...existing,
        passwordStale: true,
        // Do not flip source / rewrite the secret — only the freshness signal.
        updatedAt: now,
      };
      this.vault.put("credential", credential);
      updated.push(credential);
    }
    return updated;
  }

  getCredential(credentialId: string): Credential | undefined {
    return this.vault.get("credential", credentialId);
  }

  listCredentialsForSite(siteAccountId: string): Credential[] {
    return this.vault.list("credential").filter((c) => c.siteAccountId === siteAccountId);
  }

  // --- Session state (persisted storageState, Issue #294) ---

  /**
   * Toggle the per-site opt-in for persisting a browser session across
   * Visibility runs. Disabling is unconditional and immediate: any existing
   * `SessionState` for the site is cleared in the same call (mirrors
   * Delegation Boundary reduction — CLAUDE.md "reduction is unconditional and
   * immediate").
   */
  setSessionPersistenceEnabled(siteAccountId: string, enabled: boolean): SiteAccount | undefined {
    const site = this.getSiteAccount(siteAccountId);
    if (!site) return undefined;
    const updated: SiteAccount = { ...site, persistSessionEnabled: enabled, updatedAt: Date.now() };
    this.vault.put("siteAccount", updated);
    if (!enabled) this.vault.delete("sessionState", siteAccountId);
    return updated;
  }

  /**
   * Insert or refresh the persisted `storageState` for a site. Always slides
   * `expiresAt` forward from `now`, so a session that keeps getting reused
   * never silently expires mid-use.
   */
  savePersistedSessionState(input: {
    siteAccountId: string;
    storageState: string;
    now?: number;
  }): SessionState {
    const now = input.now ?? Date.now();
    const existing = this.vault.get("sessionState", input.siteAccountId);
    const state: SessionState = {
      id: input.siteAccountId,
      siteAccountId: input.siteAccountId,
      storageState: input.storageState,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      expiresAt: now + SESSION_STATE_EXPIRY_MS,
    };
    this.vault.put("sessionState", state);
    return state;
  }

  /**
   * Read the persisted `SessionState` for a site, treating an expired one as
   * absent and discarding it (Issue #294: fixed 30-day expiry, no per-site
   * risk tiering).
   */
  getPersistedSessionState(siteAccountId: string, now: number = Date.now()): SessionState | undefined {
    const state = this.vault.get("sessionState", siteAccountId);
    if (!state) return undefined;
    if (state.expiresAt <= now) {
      this.vault.delete("sessionState", siteAccountId);
      return undefined;
    }
    return state;
  }

  /**
   * Read-only variant of {@link getPersistedSessionState}: reports whether a
   * live (non-expired) session exists without deleting an expired one as a
   * side effect. For pure-read call sites (e.g. the ledger detail view) that
   * must not mutate the vault just by being viewed.
   */
  peekPersistedSessionState(siteAccountId: string, now: number = Date.now()): SessionState | undefined {
    const state = this.vault.get("sessionState", siteAccountId);
    if (!state || state.expiresAt <= now) return undefined;
    return state;
  }

  /** Explicit "clear now" while persistence stays enabled — a fresh session starts next run. */
  clearPersistedSessionState(siteAccountId: string): boolean {
    return this.vault.delete("sessionState", siteAccountId);
  }

  // --- Disclosures (the ledger edge) ---

  /**
   * Record a Disclosure: a value a site holds for an attribute. Re-observing
   * the same normalized value for the same site and attribute refreshes the
   * existing ledger edge instead of creating a duplicate. A changed value has
   * a different hash and remains a separate history row.
   *
   * The normalized hash and stale-state are derived at insert time against the
   * current canonical attribute; both are recomputed whenever the attribute
   * changes.
   */
  addDisclosure(input: AddDisclosureInput): Disclosure {
    this.assertObservation?.(input.siteAccountId, input.attributeKey);
    const storedSiteHeldValue = disclosureStoredValue(
      input.attributeKey, input.siteHeldValue, input.collectionTier,
    );
    const observedAt = input.observedAt ?? Date.now();
    const disclosure: Disclosure = {
      id: globalThis.crypto.randomUUID(),
      siteAccountId: input.siteAccountId,
      attributeKey: input.attributeKey,
      observedAt,
      sourceKind: input.sourceKind,
      collectionTier: input.collectionTier ?? "deterministic",
      confidence: input.confidence ?? 1,
      evidenceIds: input.evidenceIds ?? [],
      staleState: "unknown",
    };
    if (storedSiteHeldValue !== undefined) {
      disclosure.siteHeldValue = storedSiteHeldValue;
      disclosure.normalizedValueHash = normalizedValueHash(input.attributeKey, storedSiteHeldValue);
    } else if (
      (input.attributeKey !== MOST_SENSITIVE_ATTRIBUTE_KEY || input.collectionTier === "ai-driven") &&
      input.normalizedValueHash !== undefined
    ) {
      disclosure.normalizedValueHash = input.normalizedValueHash;
    }
    if (input.sourcePageUrl !== undefined) disclosure.sourcePageUrl = input.sourcePageUrl;
    disclosure.staleState = this.deriveStaleState(disclosure);

    if (disclosure.normalizedValueHash !== undefined) {
      const existing = this.vault.list("disclosure").find(
        (candidate) =>
          candidate.siteAccountId === disclosure.siteAccountId &&
          candidate.attributeKey === disclosure.attributeKey &&
          (candidate.collectionTier ?? "deterministic") === disclosure.collectionTier &&
          candidate.normalizedValueHash === disclosure.normalizedValueHash,
      );
      if (existing) {
        const isNewerObservation = observedAt > existing.observedAt;
        const updated: Disclosure = {
          ...existing,
          observedAt: Math.max(existing.observedAt, observedAt),
          evidenceIds: [...new Set([...existing.evidenceIds, ...disclosure.evidenceIds])],
          staleState: this.deriveStaleState(existing),
        };
        if (isNewerObservation) {
          updated.sourceKind = disclosure.sourceKind;
          updated.confidence = disclosure.confidence;
          if (disclosure.sourcePageUrl !== undefined) {
            updated.sourcePageUrl = disclosure.sourcePageUrl;
          } else {
            delete updated.sourcePageUrl;
          }
        }
        this.vault.put("disclosure", updated);
        return updated;
      }
    }

    this.vault.put("disclosure", disclosure);
    return disclosure;
  }

  getDisclosure(id: string): Disclosure | undefined {
    return this.vault.get("disclosure", id);
  }

  listDisclosures(): Disclosure[] {
    return this.vault.list("disclosure");
  }

  listDisclosuresForSite(siteAccountId: string): Disclosure[] {
    return this.vault.list("disclosure").filter((d) => d.siteAccountId === siteAccountId);
  }

  listDisclosuresForAttribute(attributeKey: string): Disclosure[] {
    return this.vault.list("disclosure").filter((d) => d.attributeKey === attributeKey);
  }

  /**
   * Derive a Disclosure's stale-state (RFC-002 §4.2): compare its normalized
   * value hash with the canonical Personal Attribute's normalized hash.
   *
   * - `unknown` when the site-held value or the canonical attribute is missing;
   * - `current` when the normalized hashes match;
   * - `stale` otherwise.
   *
   * Known gap (issue #229, tracked as documented tech debt — no user data
   * predates this yet, so no migration code has been written): `card.number`
   * disclosures are now hashed against only the last 4 digits
   * (`comparisonValue`), whereas earlier code hashed the full collected value.
   * A `card.number` Disclosure recorded before that change would carry an
   * old-scheme hash that no longer matches this method's last-4-digit
   * canonical hash, and would misflag as `stale` the next time the canonical
   * card number is edited (`recomputeStaleStatesForAttribute`) — even though
   * the underlying card did not change. Revisit once the vault has a schema
   * versioning / migration mechanism (there is none today, see `VaultV2`).
   */
  deriveStaleState(
    disclosure: Pick<Disclosure, "attributeKey" | "normalizedValueHash" | "collectionTier">,
  ): StaleState {
    if (!disclosure.normalizedValueHash) return "unknown";
    const canonical = this.getPersonalAttribute(disclosure.attributeKey);
    if (!canonical) return "unknown";
    const canonicalValue = comparisonValue(
      canonical.attributeKey, canonical.value, disclosure.collectionTier,
    );
    if (canonicalValue === undefined) return "unknown";
    const canonicalHash = normalizedValueHash(canonical.attributeKey, canonicalValue);
    return disclosure.normalizedValueHash === canonicalHash ? "current" : "stale";
  }

  /** Recompute and persist stale-state for every Disclosure. Returns the count that changed. */
  recomputeAllStaleStates(): number {
    let changed = 0;
    for (const disclosure of this.listDisclosures()) {
      const next = this.deriveStaleState(disclosure);
      if (next !== disclosure.staleState) {
        this.vault.put("disclosure", { ...disclosure, staleState: next });
        changed++;
      }
    }
    return changed;
  }

  private recomputeStaleStatesForAttribute(attributeKey: string): number {
    let changed = 0;
    for (const disclosure of this.listDisclosuresForAttribute(attributeKey)) {
      const next = this.deriveStaleState(disclosure);
      if (next !== disclosure.staleState) {
        this.vault.put("disclosure", { ...disclosure, staleState: next });
        changed++;
      }
    }
    return changed;
  }

  // --- Account Relationships (filters reshaped in #161) ---

  listAccountRelationships(): AccountRelationship[] {
    return this.vault.list("accountRelationship");
  }

  listAccountRelationshipsForSite(siteAccountId: string): AccountRelationship[] {
    return this.vault.list("accountRelationship").filter((r) => r.siteAccountId === siteAccountId);
  }

  addAccountRelationship(input: AddAccountRelationshipInput): AccountRelationship {
    const relationship: AccountRelationship = {
      id: globalThis.crypto.randomUUID(),
      siteAccountId: input.siteAccountId,
      kind: input.kind,
      state: input.state,
      confidence: input.confidence ?? 1,
      evidenceIds: input.evidenceIds ?? [],
      observedAt: input.observedAt ?? Date.now(),
    };
    if (input.detail !== undefined) relationship.detail = input.detail;
    this.vault.put("accountRelationship", relationship);
    return relationship;
  }

  // --- Evidence (audit trail; never raw values) ---

  /**
   * Record a piece of audit Evidence. Callers must pass only redacted material
   * (URL, timestamp, field label/type, masked snippet, normalized hash). This
   * method does not accept and never stores raw values, screenshots, cookies,
   * or tokens (RFC-002 §5.1).
   */
  addEvidence(input: AddEvidenceInput): Evidence {
    const evidence: Evidence = {
      id: globalThis.crypto.randomUUID(),
      observedAt: input.observedAt ?? Date.now(),
    };
    if (input.siteAccountId !== undefined) evidence.siteAccountId = input.siteAccountId;
    if (input.pageUrl !== undefined) evidence.pageUrl = input.pageUrl;
    if (input.fieldLabel !== undefined) evidence.fieldLabel = input.fieldLabel;
    if (input.fieldType !== undefined) evidence.fieldType = input.fieldType;
    if (input.maskedSnippet !== undefined) evidence.maskedSnippet = input.maskedSnippet;
    if (input.normalizedHash !== undefined) evidence.normalizedHash = input.normalizedHash;
    this.vault.put("evidence", evidence);
    return evidence;
  }

  listEvidence(): Evidence[] {
    return this.vault.list("evidence");
  }

  private isEvidenceStillReferenced(evidenceId: string, deletedSiteAccountId: string): boolean {
    const evidence = this.vault.get("evidence", evidenceId);
    if (evidence?.siteAccountId !== undefined && evidence.siteAccountId !== deletedSiteAccountId) return true;
    for (const disclosure of this.listDisclosures()) {
      if (disclosure.evidenceIds.includes(evidenceId)) return true;
    }
    for (const relationship of this.listAccountRelationships()) {
      if (relationship.evidenceIds.includes(evidenceId)) return true;
    }
    for (const constraint of this.listConstraints()) {
      if (constraint.evidenceIds.includes(evidenceId)) return true;
    }
    return false;
  }

  private deleteSiteWorkflowCheckpoints(siteAccountId: string): void {
    for (const checkpoint of this.listCheckpoints()) {
      if (checkpoint.siteAccountId === siteAccountId) this.vault.delete("workflowCheckpoint", checkpoint.id);
    }
  }

  private removeSiteFromDynamicAttributeCandidates(siteAccountId: string): void {
    for (const definition of this.vault.list("localDefinition")) {
      const siteAccountIds = legacyCompatibleSiteAccountIds(definition.data);
      if (!siteAccountIds.includes(siteAccountId)) continue;
      const nextSiteAccountIds = siteAccountIds.filter((id) => id !== siteAccountId);
      if (definition.status === "candidate" && nextSiteAccountIds.length === 0) {
        this.vault.delete("localDefinition", definition.id);
        continue;
      }
      const data: Record<string, unknown> = { ...definition.data, siteAccountIds: nextSiteAccountIds };
      delete data["siteAccountId"];
      this.vault.put("localDefinition", { ...definition, data, updatedAt: Date.now() });
    }
  }

  // --- Dynamic attribute candidates (user-confirmed schema growth) ---

  recordDynamicAttributeCandidate(
    input: RecordDynamicAttributeCandidateInput,
  ): DynamicAttributeCandidateView {
    const now = input.now ?? Date.now;
    const label = input.label.trim() || input.fieldId;
    const id = dynamicAttributeDefinitionId(input.proposedAttributeKey);
    const existing = this.vault.get("localDefinition", id);
    // Two unrelated sites can independently surface a field with the same
    // proposed key under different labels (e.g. "職業" vs "ご職業") before
    // either is confirmed. Merge match terms and site ids with whatever was
    // already stored rather than overwriting, so (a) confirming still lets a
    // later collection on the *other* site re-map via its own original label,
    // and (b) confirming relevance for one site never makes the candidate
    // vanish from another site's still-unconfirmed pending list.
    const matchTerms = uniqueTerms([
      ...stringArrayData(existing?.data["matchTerms"]),
      ...(input.matchTerms ?? [label]),
    ]);
    const siteAccountIds = uniqueTerms([
      ...legacyCompatibleSiteAccountIds(existing?.data ?? {}),
      input.siteAccountId,
    ]);
    const definition: LocalDefinition = {
      id,
      serviceName: label,
      source: "observation",
      status: existing?.status ?? "candidate",
      data: {
        kind: "dynamic-attribute",
        label,
        proposedAttributeKey: input.proposedAttributeKey,
        matchTerms,
        fieldId: input.fieldId,
        siteAccountIds,
        ...(input.sourcePageUrl !== undefined ? { sourcePageUrl: input.sourcePageUrl } : {}),
      },
      createdAt: existing?.createdAt ?? now(),
      updatedAt: now(),
    };
    this.vault.put("localDefinition", definition);
    return dynamicAttributeView(definition)!;
  }

  confirmDynamicAttributeCandidate(
    input: ConfirmDynamicAttributeCandidateInput,
  ): DynamicAttributeCandidateView {
    const now = input.now ?? Date.now;
    const label = input.label.trim() || input.attributeKey;
    const matchTerms = uniqueTerms(input.matchTerms.length > 0 ? input.matchTerms : [label]);
    const id = dynamicAttributeDefinitionId(input.attributeKey);
    const existing = this.vault.get("localDefinition", id);
    const definition: LocalDefinition = {
      id,
      serviceName: label,
      source: "user",
      status: "validated",
      data: {
        kind: "dynamic-attribute",
        label,
        proposedAttributeKey: input.attributeKey,
        attributeKey: input.attributeKey,
        matchTerms,
      },
      createdAt: existing?.createdAt ?? now(),
      updatedAt: now(),
    };
    this.vault.put("localDefinition", definition);
    return dynamicAttributeView(definition)!;
  }

  listDynamicAttributeCandidates(): DynamicAttributeCandidateView[] {
    return this.vault
      .list("localDefinition")
      .map(dynamicAttributeView)
      .filter((candidate): candidate is DynamicAttributeCandidateView => candidate !== undefined);
  }

  // --- Constraints (surfaced, never silently enforced) ---

  /** Surface a Constraint (e.g. a detected automation-prohibiting ToS clause). */
  addConstraint(input: AddConstraintInput): Constraint {
    const constraint: Constraint = {
      id: globalThis.crypto.randomUUID(),
      kind: input.kind,
      detail: input.detail,
      evidenceIds: input.evidenceIds ?? [],
      observedAt: input.observedAt ?? Date.now(),
      resolution: input.resolution ?? "pending",
    };
    if (input.siteAccountId !== undefined) constraint.siteAccountId = input.siteAccountId;
    this.vault.put("constraint", constraint);
    return constraint;
  }

  // --- Site Collection Maps (Issue #518) ---

  /** The active map for a site: the highest revision; failed generations are never active. */
  getSiteCollectionMap(siteAccountId: string): SiteCollectionMap | undefined {
    return this.vault.list("siteCollectionMap")
      .filter((map) => map.siteAccountId === siteAccountId && map.generationStatus !== "failed")
      .sort((a, b) => b.revision - a.revision)[0];
  }

  /**
   * Replace the site's map with the next revision. Only an AI-driven generation run
   * (first collection or explicit user-requested regeneration) calls this; map-based
   * recollection never regenerates. Vault validation rejects invalid maps.
   */
  saveSiteCollectionMap(input: {
    siteAccountId: string;
    generationStatus: "candidate" | "ready";
    observedAt: number;
    pages: SiteCollectionMap["pages"];
  }): SiteCollectionMap {
    const existing = this.vault.list("siteCollectionMap").filter((map) => map.siteAccountId === input.siteAccountId);
    const map: SiteCollectionMap = {
      id: globalThis.crypto.randomUUID(),
      schemaVersion: 1,
      siteAccountId: input.siteAccountId,
      revision: Math.max(0, ...existing.map((m) => m.revision)) + 1,
      generationStatus: input.generationStatus,
      provenance: { kind: "ai-driven", observedAt: input.observedAt },
      pages: input.pages,
    };
    this.vault.put("siteCollectionMap", map);
    for (const old of existing) this.vault.delete("siteCollectionMap", old.id);
    return map;
  }

  getCapability(operation: Operation): Capability | undefined {
    return this.vault.list("capability").find(c => c.operationType === operation);
  }

  enableCapability(input: { operation: Operation; scope: CapabilityScope; policyVersion: number }): Capability {
    const scope = normalizeScope(input.scope);
    if (input.policyVersion !== AUTHORIZATION_POLICY_VERSION || !scope.siteAccountIds.length || !scope.attributeKeys.length ||
        scope.siteAccountIds.some(id => !this.getSiteAccount(id)) || scope.attributeKeys.some(key => !FIXED_ATTRIBUTE_LABELS.has(key))) throw new Error("invalid capability scope");
    const old = this.getCapability(input.operation);
    if (old?.level === "L1" && old.scope && scopeContains(old.scope, scope) && scopeContains(scope, old.scope)) return old;
    const next: Capability = { id: old?.id ?? input.operation, operationType: input.operation, level: "L1", revision: (old?.revision ?? 0) + 1,
      scope, policyVersion: input.policyVersion, explicitlyEnabledAt: Date.now(), updatedAt: Date.now() };
    return this.vault.put("capability", next);
  }

  reduceCapability(input: { operation: Operation; scope?: CapabilityScope }): Capability {
    const old = this.getCapability(input.operation);
    const scope = input.scope ? normalizeScope(input.scope) : undefined;
    if (scope && (!old?.scope || !scopeContains(old.scope, scope))) throw new Error("reduction cannot expand authority");
    const active = scope && scope.siteAccountIds.length > 0 && scope.attributeKeys.length > 0;
    const next: Capability = { id: old?.id ?? input.operation, operationType: input.operation, level: active ? "L1" : "L0",
      revision: (old?.revision ?? 0) + 1, reducedAt: Date.now(), updatedAt: Date.now(),
      ...(active ? { scope, policyVersion: AUTHORIZATION_POLICY_VERSION, explicitlyEnabledAt: old!.explicitlyEnabledAt! } : {}) };
    return this.vault.put("capability", next);
  }

  authorizeOperation(context: OperationContext): AuthorizationDecision {
    return authorize(this.getCapability(context.operation), context);
  }

  /** Live reads make revocation/reduction effective before every collection action. */
  permitsAiCollection(grant: CollectionGrant, siteAccountId: string, runId: string, epoch: number): boolean {
    if (grant.siteAccountId !== siteAccountId || grant.runId !== runId || grant.epoch !== epoch || grant.policyVersion !== AUTHORIZATION_POLICY_VERSION || !grant.attributeKeys.length) return false;
    const mandate = this.vault.get("mandate", grant.mandateId);
    const capability = this.vault.get("capability", grant.capabilityId);
    return !!mandate && !!capability && mandate.operation === "ai-assisted-discovery" &&
      mandate.siteAccountId === siteAccountId && mandate.scope === runId &&
      capability.operationType === "ai-assisted-discovery" && capability.revision === grant.capabilityRevision &&
      (capability.reducedAt === undefined || mandate.authorizedAt > capability.reducedAt) &&
      (capability.level === "L0" || this.authorizeOperation({ operation: "ai-assisted-discovery", siteAccountId,
        attributeKeys: grant.attributeKeys, actionId: runId, revision: grant.capabilityRevision, policyVersion: grant.policyVersion }).kind === "permitted");
  }

  resolveCollectionConstraint(id: string, resolution: "user-proceeded" | "user-stopped"): void {
    const constraint = this.vault.get("constraint", id);
    if (!constraint) throw new Error("collection constraint missing");
    this.vault.put("constraint", { ...constraint, resolution });
  }

  listConstraints(): Constraint[] {
    return this.vault.list("constraint");
  }

  // --- Workflow checkpoints (encrypted resume state, RFC-002 §5.2) ---

  /**
   * Insert or update the checkpoint for a (workflow, siteAccount) pair. The id
   * is derived so a run resumes from one record per site rather than appending.
   */
  saveCheckpoint(input: SaveCheckpointInput): WorkflowCheckpoint {
    const id = checkpointId(input.workflow, input.siteAccountId);
    const checkpoint: WorkflowCheckpoint = {
      id,
      workflow: input.workflow,
      step: input.step,
      status: input.status,
      updatedAt: Date.now(),
    };
    if (input.siteAccountId !== undefined) checkpoint.siteAccountId = input.siteAccountId;
    if (input.resumeData !== undefined) checkpoint.resumeData = sanitizeResumeData(input.resumeData);
    if (input.resolutionStage !== undefined) checkpoint.resolutionStage = input.resolutionStage;
    if (input.unresolvedAttributeKeys !== undefined) {
      checkpoint.unresolvedAttributeKeys = [...input.unresolvedAttributeKeys];
    }
    this.vault.put("workflowCheckpoint", checkpoint);
    return checkpoint;
  }

  getCheckpoint(
    workflow: WorkflowCheckpoint["workflow"],
    siteAccountId?: string,
  ): WorkflowCheckpoint | undefined {
    return this.vault.get("workflowCheckpoint", checkpointId(workflow, siteAccountId));
  }

  /** Remove a checkpoint so the next run starts fresh (e.g. when saving it failed). */
  discardCheckpoint(workflow: WorkflowCheckpoint["workflow"], siteAccountId?: string): void {
    this.vault.delete("workflowCheckpoint", checkpointId(workflow, siteAccountId));
  }

  listCheckpoints(): WorkflowCheckpoint[] {
    return this.vault.list("workflowCheckpoint");
  }
}

export interface AddAccountRelationshipInput {
  siteAccountId: string;
  kind: AccountRelationship["kind"];
  state: AccountRelationship["state"];
  confidence?: number;
  evidenceIds?: string[];
  observedAt?: number;
  detail?: string;
}

export interface AddEvidenceInput {
  siteAccountId?: string;
  pageUrl?: string;
  observedAt?: number;
  fieldLabel?: string;
  fieldType?: string;
  maskedSnippet?: string;
  normalizedHash?: string;
}

export interface AddConstraintInput {
  siteAccountId?: string;
  kind: Constraint["kind"];
  detail: string;
  evidenceIds?: string[];
  observedAt?: number;
  resolution?: Constraint["resolution"];
}

export interface SaveCheckpointInput {
  workflow: WorkflowCheckpoint["workflow"];
  siteAccountId?: string;
  step: string;
  status: WorkflowCheckpoint["status"];
  resumeData?: Record<string, string | number | boolean>;
  resolutionStage?: WorkflowCheckpoint["resolutionStage"];
  unresolvedAttributeKeys?: string[];
}

/**
 * Checkpoints must not carry personal data, so a resume `url` keeps only origin and path
 * (no query string or fragment); an unparsable URL is dropped.
 */
function sanitizeResumeData(
  data: Record<string, string | number | boolean>,
): Record<string, string | number | boolean> {
  if (typeof data.url !== "string") return data;
  const { url: raw, ...rest } = data;
  try {
    const url = new URL(raw);
    url.search = "";
    url.hash = "";
    return { ...rest, url: url.toString() };
  } catch {
    return rest;
  }
}

function checkpointId(workflow: string, siteAccountId?: string): string {
  return siteAccountId ? `${workflow}:${siteAccountId}` : workflow;
}

function disclosureStoredValue(
  attributeKey: string,
  value: string | undefined,
  tier?: Disclosure["collectionTier"],
): string | undefined {
  if (value === undefined) return undefined;
  return comparisonValue(attributeKey, value, tier);
}

function comparisonValue(
  attributeKey: string,
  value: string,
  tier?: Disclosure["collectionTier"],
): string | undefined {
  if (tier === "ai-driven") return value;
  if (attributeKey === MOST_SENSITIVE_ATTRIBUTE_KEY) return undefined;
  if (attributeKey === "card.number") {
    const digits = value.replace(/\D/g, "");
    return digits.slice(-4);
  }
  return value;
}

function dynamicAttributeDefinitionId(attributeKey: string): string {
  return `dynamic-attribute:${attributeKey}`;
}

function dynamicAttributeView(definition: LocalDefinition): DynamicAttributeCandidateView | undefined {
  const data = definition.data;
  if (data["kind"] !== "dynamic-attribute") return undefined;
  const label = stringData(data["label"]);
  const proposedAttributeKey = stringData(data["attributeKey"]) ?? stringData(data["proposedAttributeKey"]);
  if (!label || !proposedAttributeKey || !proposedAttributeKey.startsWith("custom.")) return undefined;
  const matchTerms = Array.isArray(data["matchTerms"])
    ? data["matchTerms"].filter((term): term is string => typeof term === "string" && term.trim() !== "")
    : [label];
  const view: DynamicAttributeCandidateView = {
    id: definition.id,
    status: definition.status,
    label,
    proposedAttributeKey: proposedAttributeKey as ProfileKey,
    matchTerms: uniqueTerms(matchTerms),
    createdAt: definition.createdAt,
    updatedAt: definition.updatedAt,
  };
  const fieldId = stringData(data["fieldId"]);
  if (fieldId !== undefined) view.fieldId = fieldId;
  const sourcePageUrl = stringData(data["sourcePageUrl"]);
  if (sourcePageUrl !== undefined) view.sourcePageUrl = sourcePageUrl;
  const siteAccountIds = legacyCompatibleSiteAccountIds(data);
  if (siteAccountIds.length > 0) view.siteAccountIds = siteAccountIds;
  return view;
}

function stringData(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function stringArrayData(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "")
    : [];
}

/**
 * Reads the record's site ids under the current array shape (`siteAccountIds`),
 * folding in the singular `siteAccountId` shape a record may still carry from
 * before candidates tracked every observing site. Without this fallback, a
 * candidate already persisted under the old shape would silently stop
 * appearing in any site's pending list.
 */
function legacyCompatibleSiteAccountIds(data: Record<string, unknown>): string[] {
  const legacySingular = stringData(data["siteAccountId"]);
  return uniqueTerms([
    ...stringArrayData(data["siteAccountIds"]),
    ...(legacySingular ? [legacySingular] : []),
  ]);
}

function uniqueTerms(terms: string[]): string[] {
  return [...new Set(terms.map((term) => term.trim()).filter((term) => term !== ""))];
}
