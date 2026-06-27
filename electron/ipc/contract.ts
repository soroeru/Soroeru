// Typed IPC contract between the Electron main (trusted) and renderer
// (untrusted UI surface) processes (RFC-002 §3 trust rule, §8.2 IPC permission
// test). This module is the single source of truth for:
//
//   - the exact set of IPC channels the renderer may invoke (an allowlist), and
//   - the request/response shapes crossing the boundary.
//
// It is deliberately framework-free (no electron / react imports) so both
// processes and the unit tests can import it. The renderer never receives raw
// personal values through these types: the domain summary carries masked
// previews only (full-value reveal is a later, separately gated capability).

import type {
  AccountRelationship,
  Constraint,
  DisclosureSourceKind,
  Sensitivity,
  StaleState,
} from "../../src/domain/entities.js";

// Re-export the leaf-only ledger insight types so the renderer keeps a single
// IPC-facing type source (contract.ts) without importing the Node-side domain.
export type {
  EvidenceRef,
  LedgerFilter,
  LedgerFilterKey,
  LedgerFilterSite,
  LedgerInsights,
  ReflectionFinding,
  ReflectionKind,
} from "../../src/domain/insights-types.js";

/**
 * The complete allowlist of IPC channels the preload bridge may invoke. Any
 * channel not listed here must be rejected by the main process and must be
 * unreachable from the renderer. Keep this minimal (least privilege).
 */
export const IPC_CHANNELS = {
  vaultStatus: "soroeru:vault:status",
  vaultSetup: "soroeru:vault:setup",
  vaultUnlock: "soroeru:vault:unlock",
  vaultUnlockRecovery: "soroeru:vault:unlock-recovery",
  vaultLock: "soroeru:vault:lock",
  recoveryGenerate: "soroeru:vault:recovery-generate",
  domainSummary: "soroeru:domain:summary",
  csvImport: "soroeru:csv:import",
  ledgerSites: "soroeru:ledger:sites",
  ledgerSite: "soroeru:ledger:site",
  ledgerInsights: "soroeru:ledger:insights",
  revealValue: "soroeru:ledger:reveal",
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

/**
 * Minimum master-passphrase length, enforced in the trusted layer (the renderer
 * is untrusted per RFC-002 §3, so its UI guard alone must not be load-bearing).
 * Defined here so both the session boundary and the UI share one value.
 */
export const MIN_PASSPHRASE_LENGTH = 8;

/** Frozen list form of the channel allowlist, for membership checks in tests. */
export const IPC_CHANNEL_LIST: readonly IpcChannel[] = Object.freeze(
  Object.values(IPC_CHANNELS),
) as readonly IpcChannel[];

export function isIpcChannel(value: unknown): value is IpcChannel {
  return typeof value === "string" && (IPC_CHANNEL_LIST as readonly string[]).includes(value);
}

// --- Payload shapes (sanitized; no raw personal values) ---

export interface VaultStatus {
  /** A vault file already exists on disk (so the user should unlock, not set up). */
  exists: boolean;
  /** No decrypted key is held in memory; domain operations are unavailable. */
  locked: boolean;
  /**
   * A recovery key is configured on the currently-unlocked vault. Only
   * meaningful while unlocked (the locked file is not read for this); the unlock
   * screen may always offer a recovery-key attempt regardless.
   */
  hasRecoveryKey: boolean;
}

export interface VaultMutationResult {
  ok: boolean;
  locked: boolean;
  /** A non-sensitive, user-presentable reason when `ok` is false. Never a value. */
  error?: string;
}

/**
 * A redacted view of one canonical Personal Attribute. `preview` is masked and
 * reveals at most the value's length — never its characters. Sensitive and
 * most-sensitive attributes are masked identically; the renderer has no path to
 * the raw value in this slice.
 */
export interface AttributeSummary {
  attributeKey: string;
  label: string;
  sensitivity: Sensitivity;
  hasValue: boolean;
  preview: string;
}

export interface DomainSummary {
  locked: boolean;
  siteAccountCount: number;
  attributeCount: number;
  attributes: AttributeSummary[];
}

// --- Recovery key (RFC-002 §6) ---

/**
 * Result of generating a one-time recovery key. `recoveryKey` is plaintext and
 * is returned exactly once for immediate display; it is never logged, persisted
 * in plaintext, or re-fetchable. The UI must show it then drop it.
 */
export interface RecoveryKeyResult {
  ok: boolean;
  recoveryKey?: string;
  error?: string;
}

// --- CSV import & queue review (RFC-002 §5.1) ---

/**
 * Counts-only import summary as the renderer sees it. Mirrors the domain
 * `CsvImportSummary` field-for-field, but is declared here so the contract's
 * type graph stays leaf-only (importing the domain importer would pull the
 * Node-only vault/crypto modules into the renderer typecheck). Never a raw
 * username / password / note.
 */
export interface CsvImportSummaryView {
  totalDataRows: number;
  importedCredentials: number;
  sitesCreated: number;
  sitesMatched: number;
  skipped: number;
  siteAccountIds: string[];
  recommendSourceDeletion: boolean;
}

/** Sanitized import outcome: counts only, never a raw username / password / note. */
export interface CsvImportResult {
  ok: boolean;
  /** A non-sensitive reason code when `ok` is false (e.g. "too-large", "bad-header"). */
  error?: string;
  summary?: CsvImportSummaryView;
}

// --- Disclosure ledger (RFC-002 §4.2 / §5.1) ---

/** Per-attribute stale tally for a site, driving the ledger's stale flag. */
export interface StaleTally {
  current: number;
  stale: number;
  unknown: number;
}

/**
 * One row of the composed ledger: what a single Site Account holds, summarized.
 * Carries no raw values — only counts, derived stale tallies, and relationship
 * kinds. `collected` is false until a Visibility run has filled the ledger.
 */
export interface SiteLedgerSummary {
  siteAccountId: string;
  domain: string;
  displayName: string;
  url?: string;
  credentialCount: number;
  disclosureCount: number;
  stale: StaleTally;
  /** Active Account Relationship kinds detected for the site. */
  relationshipKinds: AccountRelationship["kind"][];
  constraintCount: number;
  /** True once at least one Disclosure exists or the Visibility checkpoint is done. */
  collected: boolean;
}

/** One disclosed value as the renderer sees it: masked preview, never the raw value. */
export interface DisclosureView {
  disclosureId: string;
  attributeKey: string;
  label: string;
  sensitivity: Sensitivity;
  staleState: StaleState;
  sourceKind: DisclosureSourceKind;
  observedAt: number;
  /** Masked bullets that reveal at most the value's length, or "" when unknown. */
  preview: string;
  /** A re-authenticated reveal can return a raw value (has one and not most-sensitive). */
  revealable: boolean;
  evidenceCount: number;
}

export interface RelationshipView {
  kind: AccountRelationship["kind"];
  state: AccountRelationship["state"];
  detail?: string;
  observedAt: number;
}

export interface ConstraintView {
  kind: Constraint["kind"];
  detail: string;
  resolution?: Constraint["resolution"];
  observedAt: number;
}

/** The per-site composed ledger view: the summary plus its masked detail rows. */
export interface SiteLedgerDetail extends SiteLedgerSummary {
  disclosures: DisclosureView[];
  relationships: RelationshipView[];
  constraints: ConstraintView[];
}

/**
 * Result of a re-authenticated reveal. `value` is a raw personal value returned
 * only after the master passphrase is re-verified for this single reveal; the
 * renderer must show it transiently and never persist it. Most-sensitive values
 * (CVV) are refused here and require a dedicated accessor (RFC-002 §6).
 */
export interface RevealResult {
  ok: boolean;
  value?: string;
  error?: string;
}
