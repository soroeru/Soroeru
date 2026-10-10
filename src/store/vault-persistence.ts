// Storage backend for the encrypted vault document (Issue #556, design #554 §6.1).
//
// `VaultV2` owns the envelope format and every crypto operation; a persistence
// backend only stores and returns the already-encrypted document as a whole.
// Backends: `FileVaultPersistence` (./file-vault-persistence.ts, Electron and
// tests, atomic file replacement) and, later, an IndexedDB backend for the
// extension. This module must stay free of `node:` imports and `Buffer`.

import type { EncryptedRecord, KdfParams } from "./crypto.js";
import type { EntityKind } from "../domain/entities.js";

/**
 * Encrypted record envelope (RFC-002 §4). AES-GCM appends its 16-byte auth tag
 * to the ciphertext (Web Crypto behavior), so `ciphertext` holds ciphertext +
 * tag and no separate `tag` field is needed for round-tripping.
 */
export interface VaultRecordEnvelope {
  recordId: string;
  entityKind: EntityKind;
  schemaVersion: number;
  /** base64, 96-bit random IV, fresh per record per save. */
  iv: string;
  /** base64 ciphertext + GCM auth tag. */
  ciphertext: string;
  createdAt: number;
  updatedAt: number;
}

export interface VaultMetadata {
  createdAt: number;
  updatedAt: number;
  appName: string;
}

/**
 * The Vault v2 document (header + record envelopes). Same shape as the vault
 * file and the encrypted export, so either backend can import the other's data.
 * Everything outside the encrypted payloads is non-sensitive by design.
 */
export interface EncryptedVaultData {
  vaultVersion: number;
  kdf: KdfParams;
  metadata: VaultMetadata;
  /** Present iff a recovery key is configured: master key wrapped under the recovery KEK. */
  recovery?: EncryptedRecord;
  /**
   * Known token encrypted under the master key, for passphrase verification.
   * Optional for forward-compat: a vault written before this field existed has
   * none, so `open` only enforces the check when present.
   */
  verifier?: EncryptedRecord;
  records: VaultRecordEnvelope[];
}

export interface VaultPersistence {
  /**
   * Return the stored document, or `null` when nothing is stored. The result is
   * untrusted (it may be a legacy v1 store or corrupt data); `VaultV2` validates
   * it. Unreadable data must throw rather than return `null` (fail closed: a
   * corrupt vault must never look like an empty one).
   */
  load(): Promise<EncryptedVaultData | null>;
  /** Replace the whole stored document atomically: on failure the previous version remains. */
  save(data: EncryptedVaultData): Promise<void>;
  /** Remove the stored document. Callers must have passed the deletion confirmation gate. */
  clear(): Promise<void>;
}
