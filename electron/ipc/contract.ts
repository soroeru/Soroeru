// Typed IPC contract between the Electron main (trusted) and renderer
// (untrusted UI surface) processes (RFC-002 §3 trust rule, §8.2 IPC permission
// test). This module is the single source of truth for:
//
//   - the exact set of IPC channels the renderer may invoke (an allowlist), and
//   - the request/response shapes crossing the boundary.
//
// It is deliberately framework-free (no electron / react imports) so both
// processes and the unit tests can import it. Raw values are only allowed on
// explicitly gated flows: one-value ledger reveal after re-authentication, and
// the active wall hand-off credential copy helper. Ordinary summaries carry
// masked previews only.

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
  savedPageImport: "soroeru:saved-page:import",
  savedPageOpenSite: "soroeru:saved-page:open-site",
  savedPageMarkManual: "soroeru:saved-page:mark-manual",
  ledgerSites: "soroeru:ledger:sites",
  ledgerSite: "soroeru:ledger:site",
  ledgerInsights: "soroeru:ledger:insights",
  revealValue: "soroeru:ledger:reveal",
  ledgerConfirmDynamicCandidate: "soroeru:ledger:confirm-dynamic-candidate",
  ledgerDeleteSite: "soroeru:ledger:delete-site",
  visibilityRun: "soroeru:visibility:run",
  visibilityResume: "soroeru:visibility:resume",
  visibilityAbort: "soroeru:visibility:abort",
  visibilityStatus: "soroeru:visibility:status",
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

/**
 * One-way main→renderer channel for Visibility run progress / wall hand-off
 * events. It is NOT in `IPC_CHANNELS` because the renderer only *subscribes*
 * (it never invokes it); the invoke allowlist above stays the renderer's full
 * set of callable channels.
 */
export const VISIBILITY_EVENT_CHANNEL = "soroeru:visibility:event" as const;

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

// --- Payload shapes ---

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

// --- Saved account page import (local manual-import fallback, issue #184) ---

export interface SavedPageImportRequest {
  siteAccountId: string;
  fileName: string;
  data: Uint8Array;
}

export interface SavedPageImportSummaryView {
  siteAccountId: string;
  disclosures: number;
  sourceUrl?: string;
  sourceHashPreview: string;
  recommendSourceDeletion: boolean;
}

export interface SavedPageImportResult {
  ok: boolean;
  error?: string;
  summary?: SavedPageImportSummaryView;
}

export interface SavedPageOpenSiteResult {
  ok: boolean;
  url?: string;
  error?: string;
}

export interface SavedPageManualCheckResult {
  ok: boolean;
  error?: string;
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

/**
 * A field the deterministic classifier could not map to a known or already
 * confirmed attribute, observed with its label so the user can review and
 * confirm it as a reusable attribute (dynamic schema growth, RFC-002 §7).
 * Carries no raw collected value — only the field's label/identity.
 */
export interface PendingAttributeCandidateView {
  id: string;
  label: string;
  proposedAttributeKey: string;
  matchTerms: string[];
  observedAt: number;
}

/** The per-site composed ledger view: the summary plus its masked detail rows. */
export interface SiteLedgerDetail extends SiteLedgerSummary {
  disclosures: DisclosureView[];
  relationships: RelationshipView[];
  constraints: ConstraintView[];
  /** Unconfirmed dynamic-attribute candidates observed on this site. */
  pendingAttributeCandidates: PendingAttributeCandidateView[];
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

/** Confirm a pending dynamic-attribute candidate as a reusable typed attribute. */
export interface ConfirmDynamicAttributeCandidateRequest {
  proposedAttributeKey: string;
  label: string;
  matchTerms?: string[];
}

export interface ConfirmDynamicAttributeCandidateResult {
  ok: boolean;
  error?: string;
}

export interface DeleteSiteAccountRequest {
  siteAccountId: string;
  /** Fourth absolute boundary: Soroeru-internal deletion is irreversible and must be explicitly confirmed. */
  confirmedFourthBoundary: boolean;
}

export interface DeleteSiteAccountResultView {
  ok: boolean;
  error?: "locked" | "not-found" | "confirmation-required" | "delete-failed";
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

// --- Visibility run (auto-login / collection, RFC-002 §5.1 / §5.2) ---

/** Terminal outcome of a per-site Visibility run as the renderer sees it. */
export type VisibilityRunStatus =
  | "collected"
  | "handoff"
  | "failed"
  | "unreachable"
  | "skipped"
  | "login-failed"
  | "no-data"
  | "locked"
  | "busy";

/** Counts-only result of a Visibility run; never a raw collected value. */
export interface VisibilityRunResultView {
  siteAccountId: string;
  status: VisibilityRunStatus;
  disclosures: number;
  relationships: number;
  constraints: number;
}

/** Whether a run is in progress and whether it is paused at a wall hand-off. */
export interface VisibilityStatusView {
  running: boolean;
  siteAccountId?: string;
  /** True when the run is paused waiting for the user to clear a wall in the headed browser. */
  awaitingHandoff: boolean;
  /** Hand-off instruction text (what to resolve), present only while awaiting hand-off. */
  instruction?: string;
}

/** Acknowledgement of a resume/abort request against the active hand-off. */
export interface VisibilityHandoffAck {
  ok: boolean;
  /** A non-sensitive reason when `ok` is false (e.g. "no-active-handoff"). */
  error?: string;
}

/** Login credential shown only during an active wall hand-off so the user can
 * complete the login/MFA step in the headed browser. This is an explicit UI
 * exception to the normal masked renderer contract: it is not persisted by the
 * renderer and is only emitted while the vault is unlocked and the run is
 * waiting for the user. */
export interface VisibilityHandoffCredentialView {
  username: string;
  password: string;
}

/**
 * A one-way Visibility event pushed to the renderer over
 * `VISIBILITY_EVENT_CHANNEL`. Normal ledger events carry only references /
 * counts / masked hand-off wording. A `handoff` event may additionally carry
 * the site's login credential for local copy assistance while the headed
 * browser is paused at a wall.
 */
export type VisibilityEvent =
  | { type: "run-started"; siteAccountId: string }
  | {
      type: "handoff";
      siteAccountId: string;
      instruction: string;
      evidence: string;
      credential?: VisibilityHandoffCredentialView;
    }
  | { type: "resumed"; siteAccountId: string }
  | { type: "run-finished"; result: VisibilityRunResultView };
