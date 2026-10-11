// Vault error types, shared by `VaultV2` and its persistence backends.

export class VaultLockedError extends Error {
  constructor() {
    super("vault is locked");
    this.name = "VaultLockedError";
  }
}

/** The passphrase or recovery key does not open this vault (its verifier or recovery wrap failed to authenticate). */
export class VaultUnlockError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "VaultUnlockError";
  }
}

/** Recovery-key unlock was requested for a vault without a recovery key. */
export class VaultNoRecoveryKeyError extends Error {
  constructor() {
    super("no recovery key is configured for this vault");
    this.name = "VaultNoRecoveryKeyError";
  }
}

export class VaultFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultFormatError";
  }
}

export class VaultCorruptError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "VaultCorruptError";
  }
}

/** A save failed because browser storage is full; the previous stored version remains. */
export class VaultStorageQuotaError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("vault save failed: storage quota exceeded", options);
    this.name = "VaultStorageQuotaError";
  }
}
