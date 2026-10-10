// Vault error types, shared by `VaultV2` and its persistence backends.

export class VaultLockedError extends Error {
  constructor() {
    super("vault is locked");
    this.name = "VaultLockedError";
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
