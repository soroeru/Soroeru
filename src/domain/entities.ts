// Soroeru domain entities (RFC-002 §4.1 / §4.2).
//
// These are the logical product entities the Disclosure ledger and Slice A
// Visibility build on. Each entity is persisted as one encrypted record in the
// Vault v2 record vault (`../store/vault-v2.ts`); the whole payload is
// encrypted, so raw values (PII, credentials, card data) only ever exist inside
// an encrypted envelope or in memory while the vault is unlocked.
//
// Persistence shape only — domain decisions (Policy, Delegation Boundary,
// stale-state derivation) live in `./domain-service.ts`.

/** Persisted entity kinds (RFC-002 §2.4). Maps 1:1 to encrypted payload kinds. */
export const ENTITY_KINDS = [
  "personalAttribute",
  "siteAccount",
  "credential",
  "disclosure",
  "accountRelationship",
  "mandate",
  "policy",
  "preference",
  "capability",
  "constraint",
  "evidence",
  "reflection",
  "workflowCheckpoint",
  "providerSettings",
  "localDefinition",
  "siteCollectionMap",
  "diagnostic",
  "sessionState",
  "formSchemaCache",
  "cloudSettings",
] as const;

export type EntityKind = (typeof ENTITY_KINDS)[number];

/** Every persisted payload carries a stable `id` used as the record key. */
export interface DomainRecord {
  id: string;
}

/** How sensitive a value is; drives masking and reveal re-auth (RFC-002 §6). */
export type Sensitivity = "normal" | "sensitive" | "most-sensitive";

export type AttributeProvenance =
  | { source: "user-entered" | "legacy-unknown"; verification: "unverified" }
  | { source: "identity-verification"; verification: "verified"; method: "jpki"; verifiedAt: number; evidenceId: string };

export interface CapabilityScope {
  siteAccountIds: string[];
  attributeKeys: string[];
}

/** Canonical personal value owned by the user (RFC-002 §4.1). Value is PII. */
export interface PersonalAttribute extends DomainRecord {
  provenance: AttributeProvenance;
  /** Stable attribute key, e.g. "email", "phone.full", "card.number", "custom.foo". */
  attributeKey: string;
  label: string;
  /** Canonical value. PII; encrypted at rest, never logged. */
  value: string;
  valueType:
    "text" | "email" | "phone" | "postal" | "address" | "name" | "card" | "date" | "secret" | "custom";
  sensitivity: Sensitivity;
  updatedAt: number;
}

/** A site the user has an account/relationship with (RFC-002 §4.1). No copied raw PII. */
export interface SiteAccount extends DomainRecord {
  /** Normalized registrable host, e.g. "example.com". */
  domain: string;
  /** Login anchor / entry URL when known. */
  url?: string;
  displayName: string;
  /** Canonical user-defined order. Absent only on vaults created before Issue #387 migration. */
  sortOrder?: number;
  /** Short human-readable relationship summary; never raw PII. */
  relationshipSummary?: string;
  /**
   * Opt-in per-site permission (Issue #294) to persist a browser session
   * (`SessionState.storageState`) across Visibility runs instead of starting
   * every run from an ephemeral context. Default false/absent. Disabling this
   * is unconditional and immediate (mirrors Delegation Boundary reduction):
   * the caller must also clear any existing `SessionState` for the site.
   */
  persistSessionEnabled?: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Login credential for a Site Account (RFC-002 §4.1 / §4.4). Secret values encrypted at rest. */
export interface Credential extends DomainRecord {
  siteAccountId: string;
  username: string;
  /** Secret; encrypted at rest, never logged or re-exported as plaintext. */
  password: string;
  /** Free-text note column from the CSV, if any. May be sensitive. */
  note?: string;
  source: "csv-import" | "user";
  /**
   * When true, the stored password is known (or strongly suspected) not to match
   * the site anymore — e.g. after a forced password-reset handoff was resolved
   * (Issue #416). Cleared when the user overwrites the password in Soroeru.
   * Does not reveal the secret; only a freshness signal for the ledger / runner.
   */
  passwordStale?: boolean;
  updatedAt: number;
}

export type DisclosureSourceKind =
  "form-field" | "profile-text" | "billing-page" | "newsletter-setting" | "user-confirmed" | "manual-import";

/** Derived by comparing the site-held value hash with the canonical attribute hash. */
export type StaleState = "current" | "stale" | "unknown";

/**
 * The core ledger edge (RFC-002 §4.2): "this account holds this value for this
 * attribute, as of this time." The site-held value is collected PII, so it is
 * stored inside this encrypted record, separately from the Site Account, so
 * bulk update can query "all Disclosures where attribute = phone and value !=
 * canonical" without treating Site Account as a raw-value dump.
 */
export interface Disclosure extends DomainRecord {
  siteAccountId: string;
  attributeKey: string;
  /** The value the site holds, collected as PII. Encrypted at rest, never logged. */
  siteHeldValue?: string;
  /** Optional reference to a separately stored encrypted value record (future use). */
  encryptedValueRef?: string;
  /** Normalized hash of the site-held value for comparison/audit without revealing it. */
  normalizedValueHash?: string;
  observedAt: number;
  sourcePageUrl?: string;
  sourceKind: DisclosureSourceKind;
  /** Absent on legacy records: deterministic card/CVV policy. */
  collectionTier?: "deterministic" | "ai-driven";
  /** 0..1 collection confidence. */
  confidence: number;
  evidenceIds: string[];
  staleState: StaleState;
}

/** Newsletter / recurring-billing / membership / last-used state (RFC-002 §4.1 / §5.3). */
export interface AccountRelationship extends DomainRecord {
  siteAccountId: string;
  kind: "newsletter" | "recurring-billing" | "free-trial" | "membership" | "last-used";
  state: "active" | "inactive" | "unknown";
  /** 0..1 confidence. */
  confidence: number;
  evidenceIds: string[];
  observedAt: number;
  detail?: string;
}

/** What the user authorized (RFC-002 §4.1). */
export interface Mandate extends DomainRecord {
  siteAccountId?: string;
  operation:
    "ai-assisted-discovery" | "collection" | "update" | "withdrawal" | "registration" | "policy-expansion";
  scope?: string;
  authorizedAt: number;
}

/**
 * Something the user must decide: an automation-prohibiting ToS clause, a wall
 * encountered, a payment/high-risk-terms situation, or an unknown state
 * (RFC-002 §4.1 / §6). Surfaced, never silently hard-blocked or bypassed.
 */
export interface Constraint extends DomainRecord {
  siteAccountId?: string;
  kind: "tos-automation-prohibition" | "wall" | "payment" | "high-risk-terms" | "unknown-state";
  detail: string;
  evidenceIds: string[];
  observedAt: number;
  resolution?: "pending" | "user-proceeded" | "user-stopped";
}

/** A safe default or user-selected policy value (RFC-002 §4.1). */
export interface Policy extends DomainRecord {
  key: string;
  value: string;
  source: "default" | "user";
  updatedAt: number;
}

/** Preference-formation state: suggest after 3 consistent observations (RFC-002 §4.1). */
export interface Preference extends DomainRecord {
  key: string;
  /** Count of consistent observations toward the suggestion threshold. */
  observations: number;
  suggestedAt?: number;
  promoted: boolean;
  value?: string;
  updatedAt: number;
}

/**
 * Per-operation Delegation Boundary state (RFC-002 §5.4). L2 is out of MVP
 * scope, so `level` is only L0 or L1. Reductions are unconditional/immediate.
 */
export interface Capability extends DomainRecord {
  operationType: "ai-assisted-discovery" | "collection" | "update" | "withdrawal" | "registration";
  level: "L0" | "L1";
  revision: number;
  scope?: CapabilityScope;
  policyVersion?: number;
  explicitlyEnabledAt?: number;
  reducedAt?: number;
  updatedAt: number;
}

/**
 * Inspectable decision evidence (RFC-002 §4.3). Stores references/hashes/masked
 * snippets only — never screenshot pixels, full HTML, cookies, tokens, or raw
 * values.
 *
 * Extended (design #554 §6.4): `kind: "tier3-consent"` records C6 consent events —
 * time, site hash, attribute keys, result, payload byte count and SHA-256. No values duplicated.
 */
export interface Evidence extends DomainRecord {
  siteAccountId?: string;
  pageUrl?: string;
  observedAt: number;
  fieldLabel?: string;
  fieldType?: string;
  maskedSnippet?: string;
  normalizedHash?: string;
  /** Discriminates Tier 3 consent audit records from ordinary field evidence. */
  kind?: "tier3-consent";
  /** Populated only when `kind === "tier3-consent"`. */
  tier3Consent?: {
    /** HMAC-SHA-256 hex of the site eTLD+1 (no raw site name stored). */
    siteHash: string;
    /** Attribute keys that were shown in the consent gate. */
    attributeKeys: string[];
    /** Outcome of the consent event. */
    result: "approved" | "declined" | "timeout" | "error";
    /** Wire-size of the consented payload in bytes. */
    payloadBytes: number;
    /** SHA-256 hex of the canonical payload JSON. */
    payloadSha256: string;
  };
}

/** Initial footprint or post-action change record (RFC-002 §4.1 / §5.1). */
export interface Reflection extends DomainRecord {
  kind: "initial-footprint" | "post-action-change";
  summary: string;
  createdAt: number;
  data?: Record<string, string | number | boolean>;
}

/**
 * Queue/resumability metadata for an automation run (RFC-002 §4.1 / §2.3).
 * Never holds raw browser profile state; resume happens from this encrypted
 * checkpoint, not from a raw cookie jar.
 */
export interface WorkflowCheckpoint extends DomainRecord {
  workflow: "visibility" | "bulk-update" | "withdrawal" | "registration";
  siteAccountId?: string;
  step: string;
  status: "pending" | "in-progress" | "handoff" | "done" | "failed";
  resumeData?: Record<string, string | number | boolean>;
  /**
   * Resolution stage reached when the run stopped (record schema v2, design
   * #554 §6.4 / §7.4). Absent on v1 records. A resumed run never inherits a
   * Tier 3 consent; `consent-pending` means consent must be asked again.
   */
  resolutionStage?: "tier1" | "tier2" | "consent-pending" | "tier3";
  /** Attribute keys still unresolved at the checkpoint. Keys only — never values or page content. */
  unresolvedAttributeKeys?: string[];
  updatedAt: number;
}

/** The user's own AI provider configuration (RFC-002 §2.5). API key is a secret. */
export interface ProviderSettings extends DomainRecord {
  provider: "anthropic" | "openai";
  model: string;
  /** Secret; encrypted at rest, never logged. */
  apiKey: string;
  /** Deterministic remains the default; AI is opt-in. */
  mode: "deterministic" | "ai";
  updatedAt: number;
}

/**
 * A local, unreviewed site/page/field definition private to this vault
 * (RFC-002 §3 DefinitionService). Stored opaquely here; the definition schema
 * and validation are reshaped around Slice A in a later Issue (#159).
 */
export interface LocalDefinition extends DomainRecord {
  serviceName: string;
  source: "ai" | "user" | "observation";
  status: "candidate" | "validated" | "rejected" | "submitted";
  /** Opaque definition body; typed/validated by the DefinitionService later. */
  data: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

/**
 * An encrypted, exported Playwright `storageState` for one Site Account
 * (Issue #294, follow-up to #293). Opt-in only (`SiteAccount.persistSessionEnabled`)
 * for sites where a fresh ephemeral context is treated as more automation-suspicious
 * than a reused session. `id` equals `siteAccountId` (at most one persisted state
 * per site). Encrypted the same way as every other vault record — the raw
 * cookies/localStorage payload never touches disk unencrypted or a log line.
 */
export interface SessionState extends DomainRecord {
  siteAccountId: string;
  /** Playwright's `storageState` export, serialized as JSON. Secret; encrypted at rest. */
  storageState: string;
  createdAt: number;
  /** Refreshed (sliding) on every successful re-export, which also pushes out `expiresAt`. */
  updatedAt: number;
  /** Fixed 30-day expiry from `updatedAt` (Issue #294 decision); read paths treat an expired record as absent. */
  expiresAt: number;
}

/**
 * Locally cached shared Form Schema (design #554 §6.3). Which sites have a
 * cached schema reveals which services the user uses, so the cache lives in
 * the encrypted vault. The schema body is the value-free Soroeru Cloud shape
 * (§7.3); the Tier 1 boundary validates this opaque body with the shared
 * cloud contract before storing or reusing it.
 */
export interface FormSchemaCache extends DomainRecord {
  /** Registrable site (eTLD+1) the schema belongs to. */
  site: string;
  /** Soroeru Cloud schema id. */
  schemaId: string;
  /** Monotonic schema version from Soroeru Cloud. */
  version: number;
  /** Value-free schema body (structure only, never personal values). */
  schema: Record<string, unknown>;
  fetchedAt: number;
}

/** One queued, not-yet-delivered cloud write (feedback or telemetry), retried idempotently. */
export interface CloudQueueItem {
  /** Client-generated key so a retried delivery is applied at most once. */
  idempotencyKey: string;
  kind: "feedback" | "telemetry";
  /** Typed, allowlisted, value-free event body (built by the cloud contract layer). */
  body: Record<string, unknown>;
  /** Number of delivery failures so far. Absent before the first attempt. */
  attempts: number;
  enqueuedAt: number;
  /** Epoch ms at which the next delivery attempt is due. Absent on newly enqueued items. */
  nextAttemptAt?: number;
}

/**
 * Soroeru Cloud preferences and pending deliveries (design #554 §6.4). Single
 * record (`id: "cloud"`). Telemetry and cloud assistance are off unless the
 * user (or the documented hackathon build default) turns them on.
 */
export interface CloudSettings extends DomainRecord {
  telemetryEnabled: boolean;
  cloudAssistEnabled: boolean;
  /** Per-install random token used for validator de-duplication (§7.3). Secret-ish; never logged. */
  validatorKey: string;
  queue: CloudQueueItem[];
  updatedAt: number;
}

/** Local support diagnostic (RFC-002 §4.1). Sanitized metadata only. */
export interface Diagnostic extends DomainRecord {
  at: number;
  type: "app" | "flow" | "error" | "wall";
  message: string;
  severity: "info" | "warn" | "error";
  /** Sanitized metadata only: no raw values, prompts, cookies, or tokens. */
  metadata?: Record<string, string | number | boolean>;
}

/** Maps each entity kind to its persisted payload type. */
export interface EntityPayloadMap {
  personalAttribute: PersonalAttribute;
  siteAccount: SiteAccount;
  credential: Credential;
  disclosure: Disclosure;
  accountRelationship: AccountRelationship;
  mandate: Mandate;
  policy: Policy;
  preference: Preference;
  capability: Capability;
  constraint: Constraint;
  evidence: Evidence;
  reflection: Reflection;
  workflowCheckpoint: WorkflowCheckpoint;
  providerSettings: ProviderSettings;
  localDefinition: LocalDefinition;
  siteCollectionMap: SiteCollectionMap;
  diagnostic: Diagnostic;
  sessionState: SessionState;
  formSchemaCache: FormSchemaCache;
  cloudSettings: CloudSettings;
}

/** Attribute keys whose values must never be displayed unmasked or logged. */
export function isSensitiveAttributeKey(attributeKey: string): boolean {
  return attributeKey.startsWith("card.") || attributeKey === "account.password";
}

/** CVV is the most sensitive field (RFC-002 §6): reveal requires a dedicated accessor. */
export const MOST_SENSITIVE_ATTRIBUTE_KEY = "card.cvv";

/**
 * Structure-only coordinates, never extracted values or page/request bodies.
 * CSS is a :root-anchored chain of positional *:nth-child(N) steps only.
 * fieldId is a bounded scanner-generated f-N / d-N coordinate, never a DOM id.
 */
export type CollectionItemLocator = { kind: "css"; selector: string } | { kind: "field-id"; fieldId: string };

/**
 * Versioned per-account collection facts; separate from B–D LocalDefinition.
 * Fingerprints are lowercase SHA-256 hex over locally derived structure only
 * (architecture §5.2), never hashes of values/text. Storage ceilings and runtime
 * validation live in site-collection-map.ts.
 */
export interface SiteCollectionMap extends DomainRecord {
  schemaVersion: 1;
  siteAccountId: string;
  revision: number;
  generationStatus: "candidate" | "ready" | "failed";
  provenance: { kind: "ai-driven" | "user-confirmed"; observedAt: number };
  pages: Array<{
    url: string;
    purpose: "profile" | "billing" | "security" | "notifications" | "other";
    fingerprint: string;
    items: Array<{ attributeKey: string; locator: CollectionItemLocator; fingerprint: string }>;
  }>;
}
