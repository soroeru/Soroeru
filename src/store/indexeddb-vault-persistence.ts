// IndexedDB-backed `VaultPersistence` for the Chrome extension (Issue #557,
// design #554 §6.1, architecture §3.6).
//
// Stores the already-encrypted Vault v2 document (ciphertext + non-sensitive
// header) as one JSON string under a single key. `save` replaces it inside one
// `readwrite` transaction and resolves only on `oncomplete`, so an aborted or
// failed save leaves the previous version in place. Unreadable data fails
// closed (`VaultCorruptError`); it is never reported as "no vault".
// Portable code: no `node:` imports, no `Buffer`.

import { VaultCorruptError, VaultStorageQuotaError } from "./vault-errors.js";
import type { EncryptedVaultData, VaultPersistence } from "./vault-persistence.js";

export const VAULT_DB_NAME = "soroeru-vault";
export const VAULT_DB_VERSION = 1;
export const VAULT_OBJECT_STORE = "vault";
export const VAULT_DOCUMENT_KEY = "document";

export class IndexedDbVaultPersistence implements VaultPersistence {
  private db: Promise<IDBDatabase> | null = null;

  constructor(
    private readonly factory: IDBFactory = globalThis.indexedDB,
    private readonly dbName: string = VAULT_DB_NAME,
  ) {
    if (!factory) throw new Error("IndexedDB is not available in this runtime");
  }

  async load(): Promise<EncryptedVaultData | null> {
    const db = await this.open();
    const tx = db.transaction(VAULT_OBJECT_STORE, "readonly");
    const stored = await requestResult<unknown>(tx.objectStore(VAULT_OBJECT_STORE).get(VAULT_DOCUMENT_KEY));
    if (stored === undefined) return null;
    if (typeof stored !== "string") throw new VaultCorruptError("stored vault document is not a string");
    let parsed: unknown;
    try {
      parsed = JSON.parse(stored);
    } catch (err) {
      throw new VaultCorruptError("stored vault document is not valid JSON", { cause: err });
    }
    // `null` means "nothing stored"; a stored non-object is corrupt.
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new VaultCorruptError("stored vault document is not a vault document");
    }
    return parsed as EncryptedVaultData;
  }

  async save(data: EncryptedVaultData): Promise<void> {
    const text = JSON.stringify(data);
    const db = await this.open();
    await this.write(db, (store) => {
      // persist: encrypted-store — AES-256-GCM encrypted Vault v2 document only (docs/security.md §4)
      store.put(text, VAULT_DOCUMENT_KEY);
    });
  }

  async clear(): Promise<void> {
    const db = await this.open();
    await this.write(db, (store) => {
      store.delete(VAULT_DOCUMENT_KEY);
    });
  }

  /** Close the connection (e.g. when the Side Panel closes). Reopens lazily. */
  close(): void {
    const pending = this.db;
    this.db = null;
    void pending?.then(
      (db) => db.close(),
      () => undefined,
    );
  }

  /** Run `body` in one readwrite transaction; settle only when the transaction completes or fails. */
  private write(db: IDBDatabase, body: (store: IDBObjectStore) => void): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let tx: IDBTransaction;
      try {
        tx = db.transaction(VAULT_OBJECT_STORE, "readwrite");
      } catch (err) {
        reject(mapStorageError(err));
        return;
      }
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(mapStorageError(tx.error ?? new Error("vault save transaction aborted")));
      tx.onerror = (event) => {
        // The transaction aborts after an unhandled request error; `onabort` rejects.
        event.preventDefault?.();
        tx.abort();
      };
      try {
        body(tx.objectStore(VAULT_OBJECT_STORE));
      } catch (err) {
        try {
          tx.abort();
        } catch {
          // Already finished/aborted: onabort reports the outcome.
        }
        reject(mapStorageError(err));
      }
    });
  }

  private open(): Promise<IDBDatabase> {
    if (!this.db) {
      const opening = new Promise<IDBDatabase>((resolve, reject) => {
        const request = this.factory.open(this.dbName, VAULT_DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(VAULT_OBJECT_STORE)) db.createObjectStore(VAULT_OBJECT_STORE);
        };
        request.onsuccess = () => {
          const db = request.result;
          // Another context upgrading the schema must not hang on this connection.
          db.onversionchange = () => db.close();
          resolve(db);
        };
        request.onerror = () => reject(request.error ?? new Error("cannot open the vault database"));
        request.onblocked = () => reject(new Error("vault database upgrade is blocked by another window"));
      });
      // Let a later call retry after a failed open instead of caching the failure.
      opening.catch(() => {
        if (this.db === opening) this.db = null;
      });
      this.db = opening;
    }
    return this.db;
  }
}

function requestResult<T>(request: IDBRequest): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result as T);
    request.onerror = () => reject(request.error ?? new Error("vault database request failed"));
  });
}

function mapStorageError(err: unknown): unknown {
  if (typeof err === "object" && err !== null && (err as { name?: unknown }).name === "QuotaExceededError") {
    return new VaultStorageQuotaError({ cause: err });
  }
  return err;
}
