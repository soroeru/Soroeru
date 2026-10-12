// File-backed `VaultPersistence` for Electron and tests (Issue #556). Node-only:
// keep `node:` imports here and in ./atomic-write.ts, out of the portable vault code.

import { readFile, unlink } from "node:fs/promises";
import { atomicWriteEncryptedStoreFile } from "./atomic-write.js";
import { VaultCorruptError } from "./vault-errors.js";
import type { EncryptedVaultData, VaultPersistence } from "./vault-persistence.js";

export class FileVaultPersistence implements VaultPersistence {
  constructor(readonly filePath: string) {}

  async load(): Promise<EncryptedVaultData | null> {
    let text: string;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch (err) {
      if (isMissingFile(err)) return null;
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new VaultCorruptError(`vault file at ${this.filePath} is not valid JSON`, { cause: err });
    }
    // `null` means "nothing stored"; a file holding JSON `null` (or any non-object) is corrupt.
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new VaultCorruptError(`vault file at ${this.filePath} is not a vault document`);
    }
    return parsed as EncryptedVaultData;
  }

  async save(data: EncryptedVaultData): Promise<void> {
    // Owner-only perms: contents are encrypted, but a PII-bearing state file should not be world-readable.
    // persist: encrypted-store — AES-256-GCM encrypted record vault only (docs/security.md#encryption-and-durability)
    await atomicWriteEncryptedStoreFile(this.filePath, JSON.stringify(data), { mode: 0o600 });
  }

  async clear(): Promise<void> {
    try {
      await unlink(this.filePath);
    } catch (err) {
      if (!isMissingFile(err)) throw err;
    }
  }
}

function isMissingFile(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ENOENT";
}
