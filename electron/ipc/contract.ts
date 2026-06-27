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

import type { Sensitivity } from "../../src/domain/entities.js";

/**
 * The complete allowlist of IPC channels the preload bridge may invoke. Any
 * channel not listed here must be rejected by the main process and must be
 * unreachable from the renderer. Keep this minimal (least privilege).
 */
export const IPC_CHANNELS = {
  vaultStatus: "soroeru:vault:status",
  vaultSetup: "soroeru:vault:setup",
  vaultUnlock: "soroeru:vault:unlock",
  vaultLock: "soroeru:vault:lock",
  domainSummary: "soroeru:domain:summary",
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
