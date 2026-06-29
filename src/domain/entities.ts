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
  "diagnostic",
] as const;

export type EntityKind = (typeof ENTITY_KINDS)[number];

/** Every persisted payload carries a stable `id` used as the record key. */
export interface DomainRecord {
  id: string;
}

/** How sensitive a value is; drives masking and reveal re-auth (RFC-002 §6). */
export type Sensitivity = "normal" | "sensitive" | "most-sensitive";

/** Canonical personal value owned by the user (RFC-002 §4.1). Value is PII. */
export interface PersonalAttribute extends DomainRecord {
  /** Stable attribute key, e.g. "email", "phone.full", "card.number", "custom.foo". */
  attributeKey: string;
  label: string;
  /** Canonical value. PII; encrypted at rest, never logged. */
  value: string;
  valueType: "text" | "email" | "phone" | "postal" | "address" | "name" | "card" | "date" | "secret" | "custom";
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
  /** Short human-readable relationship summary; never raw PII. */
  relationshipSummary?: string;
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
  updatedAt: number;
}

export type DisclosureSourceKind =
  | "form-field"
  | "profile-text"
  | "billing-page"
  | "newsletter-setting"
  | "user-confirmed"
  | "manual-import";

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
  operation: "collection" | "update" | "withdrawal" | "registration" | "policy-expansion";
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
  operationType: "collection" | "update" | "withdrawal" | "registration";
  level: "L0" | "L1";
  understandingCheckPassedAt?: number;
  reducedAt?: number;
  updatedAt: number;
}

/**
 * Inspectable decision evidence (RFC-002 §4.3). Stores references/hashes/masked
 * snippets only — never screenshot pixels, full HTML, cookies, tokens, or raw
 * values.
 */
export interface Evidence extends DomainRecord {
  siteAccountId?: string;
  pageUrl?: string;
  observedAt: number;
  fieldLabel?: string;
  fieldType?: string;
  maskedSnippet?: string;
  normalizedHash?: string;
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
  diagnostic: Diagnostic;
}

/** Attribute keys whose values must never be displayed unmasked or logged. */
export function isSensitiveAttributeKey(attributeKey: string): boolean {
  return attributeKey.startsWith("card.") || attributeKey === "account.password";
}

/** CVV is the most sensitive field (RFC-002 §6): reveal requires a dedicated accessor. */
export const MOST_SENSITIVE_ATTRIBUTE_KEY = "card.cvv";
