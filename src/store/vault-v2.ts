// Vault v2: a versioned encrypted record vault (RFC-002 §2.4 / §4).
//
// Unlike the v1 single-document store (`./store.ts`), Vault v2 makes the
// logical model first-class: each domain entity is one encrypted record with a
// typed envelope (recordId, entityKind, schemaVersion, iv, ciphertext,
// timestamps). The encryption shape is unchanged — AES-256-GCM under an
// Argon2id-derived master key (PBKDF2-HMAC-SHA-512 fallback), derived key in
// memory only — so the existing crypto/recovery primitives are reused.
//
// All raw values live inside encrypted payloads. Anything readable before
// unlock (the file header: version, KDF params, metadata, optional recovery
// wrapper) is non-sensitive by design.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ENTITY_KINDS, type DomainRecord, type EntityKind, type EntityPayloadMap } from "../domain/entities.js";
import {
  decryptRecord,
  deriveKey,
  encryptRecord,
  exportKeyRaw,
  importKeyRaw,
  newKdfParams,
  type EncryptedRecord,
  type KdfAlgo,
  type KdfParams,
  type MasterKey,
} from "./crypto.js";
import { generateRecoveryKey, recoveryKeyToKek } from "./recovery.js";

/** On-disk vault format version. v2 is the first versioned record vault. */
export const VAULT_FORMAT_VERSION = 2 as const;

/** Current schema version stamped on every written record envelope. */
export const RECORD_SCHEMA_VERSION = 1 as const;

const APP_NAME = "Soroeru";
const ENTITY_KIND_SET = new Set<string>(ENTITY_KINDS);

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

interface VaultFileV2 {
  vaultVersion: number;
  kdf: KdfParams;
  metadata: VaultMetadata;
  /** Present iff a recovery key is configured: master key wrapped under the recovery KEK. */
  recovery?: EncryptedRecord;
  records: VaultRecordEnvelope[];
}

/** In-memory record: the decrypted payload plus its envelope bookkeeping. */
interface StoredRecord {
  payload: DomainRecord;
  schemaVersion: number;
  createdAt: number;
  updatedAt: number;
}

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

/** Legacy v1 file shape, for migration only (mirrors `./store.ts` StoreFile). */
interface LegacyV1File {
  version: number;
  kdf: KdfParams;
  records: EncryptedRecord[];
  recovery?: EncryptedRecord;
}

interface LegacyV1Payload {
  kind: "profile" | "site" | "mandate" | "settings" | "candidate" | "diagnostic";
  data: Record<string, unknown>;
}

export class VaultV2 {
  private key: MasterKey | null;
  private kdf: KdfParams;
  private recovery: EncryptedRecord | undefined;
  private metadata: VaultMetadata;
  private readonly filePath: string;
  /** entityKind -> (recordId -> stored record). Cleared on lock. */
  private readonly records = new Map<EntityKind, Map<string, StoredRecord>>();

  private constructor(
    filePath: string,
    key: MasterKey,
    kdf: KdfParams,
    metadata: VaultMetadata,
    recovery?: EncryptedRecord,
  ) {
    this.filePath = filePath;
    this.key = key;
    this.kdf = kdf;
    this.metadata = metadata;
    this.recovery = recovery;
    for (const kind of ENTITY_KINDS) this.records.set(kind, new Map());
  }

  // --- Opening / creating ---

  /** Open (or create) the vault. A wrong passphrase fails GCM auth and throws. */
  static async open(filePath: string, passphrase: string, kdfAlgo: KdfAlgo = "argon2id"): Promise<VaultV2> {
    const raw = await VaultV2.readRawFile(filePath);
    if (raw && VaultV2.looksLikeV1(raw)) {
      return VaultV2.migrateFromV1(filePath, raw as unknown as LegacyV1File, passphrase);
    }
    const file = raw as VaultFileV2 | undefined;
    if (file && file.vaultVersion === undefined) {
      // Neither a v1 store nor a tagged v2 file: fail cleanly instead of
      // crashing later on `file.records` being undefined.
      throw new VaultFormatError(`vault file at ${filePath} is not a recognized Soroeru vault`);
    }
    if (file) VaultV2.validateV2Version(file);
    const kdf = file?.kdf ?? newKdfParams(kdfAlgo);
    const key = await deriveKey(passphrase, kdf);
    const now = Date.now();
    const metadata = file?.metadata ?? { createdAt: now, updatedAt: now, appName: APP_NAME };
    const vault = new VaultV2(filePath, key, kdf, metadata, file?.recovery);
    if (file) await vault.loadRecords(file.records, key);
    return vault;
  }

  /** Open the vault using a recovery key instead of the passphrase (RFC-002 §6). */
  static async openWithRecoveryKey(filePath: string, recoveryKey: string): Promise<VaultV2> {
    const file = (await VaultV2.readRawFile(filePath)) as VaultFileV2 | undefined;
    if (!file?.recovery) throw new Error("no recovery key is configured for this vault");
    const kek = await recoveryKeyToKek(recoveryKey);
    const rawKey = Buffer.from(await decryptRecord(kek, file.recovery), "base64");
    const key = await importKeyRaw(rawKey);
    const vault = new VaultV2(filePath, key, file.kdf, file.metadata, file.recovery);
    await vault.loadRecords(file.records, key);
    return vault;
  }

  private static async readRawFile(filePath: string): Promise<Record<string, unknown> | undefined> {
    let text: string;
    try {
      text = await readFile(filePath, "utf8");
    } catch {
      return undefined;
    }
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch (err) {
      throw new VaultCorruptError(`vault file at ${filePath} is not valid JSON`, { cause: err });
    }
  }

  private static looksLikeV1(raw: Record<string, unknown>): boolean {
    return typeof raw.version === "number" && raw.vaultVersion === undefined && Array.isArray(raw.records);
  }

  private static validateV2Version(raw: VaultFileV2): void {
    if (raw.vaultVersion > VAULT_FORMAT_VERSION) {
      throw new VaultFormatError(
        `vault format version ${raw.vaultVersion} is newer than supported ${VAULT_FORMAT_VERSION}`,
      );
    }
  }

  /** Decrypt every envelope into the in-memory maps. */
  private async loadRecords(envelopes: VaultRecordEnvelope[], key: MasterKey): Promise<void> {
    for (const env of envelopes) {
      if (!ENTITY_KIND_SET.has(env.entityKind)) {
        throw new VaultCorruptError(`unknown entity kind "${env.entityKind}" in vault record ${env.recordId}`);
      }
      const plaintext = await decryptRecord(key, { iv: env.iv, ct: env.ciphertext });
      const payload = JSON.parse(plaintext) as DomainRecord;
      if (env.recordId !== payload.id) {
        throw new VaultCorruptError(
          `vault record envelope id "${env.recordId}" does not match payload id "${payload.id}"`,
        );
      }
      this.bucket(env.entityKind).set(payload.id, {
        payload,
        schemaVersion: env.schemaVersion,
        createdAt: env.createdAt,
        updatedAt: env.updatedAt,
      });
    }
  }

  private bucket(kind: EntityKind): Map<string, StoredRecord> {
    const map = this.records.get(kind);
    if (!map) throw new VaultCorruptError(`no in-memory bucket for entity kind "${kind}"`);
    return map;
  }

  private requireKey(): MasterKey {
    if (this.key === null) throw new VaultLockedError();
    return this.key;
  }

  get isLocked(): boolean {
    return this.key === null;
  }

  get vaultMetadata(): Readonly<VaultMetadata> {
    return this.metadata;
  }

  /** Drop the master key and every decrypted record from memory. */
  lock(): void {
    this.key = null;
    for (const map of this.records.values()) map.clear();
  }

  // --- Typed record access ---

  /** Insert or replace a record. Stamps envelope timestamps; preserves createdAt on update. */
  put<K extends EntityKind>(kind: K, payload: EntityPayloadMap[K]): EntityPayloadMap[K] {
    this.requireKey();
    const now = Date.now();
    const existing = this.bucket(kind).get(payload.id);
    this.bucket(kind).set(payload.id, {
      payload,
      schemaVersion: RECORD_SCHEMA_VERSION,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    return payload;
  }

  get<K extends EntityKind>(kind: K, id: string): EntityPayloadMap[K] | undefined {
    this.requireKey();
    return this.bucket(kind).get(id)?.payload as EntityPayloadMap[K] | undefined;
  }

  list<K extends EntityKind>(kind: K): EntityPayloadMap[K][] {
    this.requireKey();
    return [...this.bucket(kind).values()].map((r) => r.payload as EntityPayloadMap[K]);
  }

  /** Remove a record (user/domain initiated). Returns true if it existed. */
  delete(kind: EntityKind, id: string): boolean {
    this.requireKey();
    return this.bucket(kind).delete(id);
  }

  // --- Recovery key (RFC-002 §6) ---

  get hasRecoveryKey(): boolean {
    return this.recovery !== undefined;
  }

  /**
   * Generate a recovery key, wrap the master key under it, and stage the wrap
   * for the next save(). Returns the recovery key for one-time display; the
   * caller must show it immediately and never log or persist the plaintext.
   */
  async setupRecoveryKey(): Promise<string> {
    const key = this.requireKey();
    const recoveryKey = generateRecoveryKey();
    const kek = await recoveryKeyToKek(recoveryKey);
    const raw = await exportKeyRaw(key);
    this.recovery = await encryptRecord(kek, Buffer.from(raw).toString("base64"));
    return recoveryKey;
  }

  removeRecoveryKey(): void {
    this.requireKey();
    this.recovery = undefined;
  }

  async verifyRecoveryKey(candidate: string): Promise<boolean> {
    if (!this.recovery) return false;
    try {
      const kek = await recoveryKeyToKek(candidate);
      await decryptRecord(kek, this.recovery);
      return true;
    } catch {
      return false;
    }
  }

  /** Check whether `candidate` re-derives the same master key, without changing state. */
  async verifyPassphrase(candidate: string): Promise<boolean> {
    const key = this.requireKey();
    const candidateKey = await deriveKey(candidate, this.kdf);
    const [a, b] = await Promise.all([exportKeyRaw(key), exportKeyRaw(candidateKey)]);
    return Buffer.from(a).equals(Buffer.from(b));
  }

  /** Re-key under a fresh salt. Invalidates any recovery wrap (it wraps the old key). */
  async rekey(newPassphrase: string, kdfAlgo: KdfAlgo = "argon2id"): Promise<void> {
    this.requireKey();
    const newKdf = newKdfParams(kdfAlgo);
    this.key = await deriveKey(newPassphrase, newKdf);
    this.kdf = newKdf;
    this.recovery = undefined;
  }

  // --- Persistence ---

  /** Build the on-disk file shape; every record gets a fresh random IV. */
  private async serialize(): Promise<VaultFileV2> {
    const key = this.requireKey();
    const now = Date.now();
    const records: VaultRecordEnvelope[] = [];
    for (const kind of ENTITY_KINDS) {
      for (const [id, stored] of this.bucket(kind)) {
        const enc = await encryptRecord(key, JSON.stringify(stored.payload));
        records.push({
          recordId: id,
          entityKind: kind,
          schemaVersion: stored.schemaVersion,
          iv: enc.iv,
          ciphertext: enc.ct,
          createdAt: stored.createdAt,
          updatedAt: stored.updatedAt,
        });
      }
    }
    const file: VaultFileV2 = {
      vaultVersion: VAULT_FORMAT_VERSION,
      kdf: this.kdf,
      metadata: { ...this.metadata, updatedAt: now },
      records,
    };
    if (this.recovery) file.recovery = this.recovery;
    this.metadata = file.metadata;
    return file;
  }

  /** Persist everything; every record gets a fresh random IV. */
  async save(): Promise<void> {
    const file = await this.serialize();
    await mkdir(dirname(this.filePath), { recursive: true });
    // Owner-only perms: contents are encrypted, but a PII-bearing state file should not be world-readable.
    // persist: encrypted-store — AES-256-GCM encrypted record vault only (docs/security.md §4)
    await writeFile(this.filePath, JSON.stringify(file), { encoding: "utf8", mode: 0o600 });
  }

  /** Same encrypted JSON shape as on disk, for the user to copy elsewhere as a backup. */
  async exportEncrypted(): Promise<string> {
    return JSON.stringify(await this.serialize());
  }

  /**
   * Restore an encrypted export to `filePath` and open it. Validates the vault
   * format version before writing anything and refuses to overwrite an existing
   * file unless `options.overwrite` is set.
   */
  static async importEncrypted(
    filePath: string,
    exported: string,
    passphrase: string,
    options?: { overwrite?: boolean },
  ): Promise<VaultV2> {
    let parsed: VaultFileV2;
    try {
      parsed = JSON.parse(exported) as VaultFileV2;
    } catch (err) {
      throw new VaultCorruptError("encrypted export is not valid JSON", { cause: err });
    }
    if (parsed.vaultVersion === undefined) {
      throw new VaultFormatError("encrypted export is not a Vault v2 file");
    }
    VaultV2.validateV2Version(parsed);
    if (!options?.overwrite) {
      const exists = await readFile(filePath).then(
        () => true,
        () => false,
      );
      if (exists) {
        throw new Error(`refusing to overwrite existing vault at ${filePath} (pass { overwrite: true } to replace it)`);
      }
    }
    await mkdir(dirname(filePath), { recursive: true });
    // persist: encrypted-store — restoring an encrypted export writes the same encrypted shape (§4)
    await writeFile(filePath, JSON.stringify(parsed), { encoding: "utf8", mode: 0o600 });
    return VaultV2.open(filePath, passphrase);
  }

  // --- Migration from v1 (RFC-002 §2.4) ---

  /**
   * Migrate a v1 single-document store into a v2 record vault, in memory. The
   * caller still controls persistence: the migrated vault is saved on the next
   * save(), which writes the v2 shape over `filePath`.
   */
  private static async migrateFromV1(filePath: string, file: LegacyV1File, passphrase: string): Promise<VaultV2> {
    const key = await deriveKey(passphrase, file.kdf);
    const now = Date.now();
    const vault = new VaultV2(filePath, key, file.kdf, { createdAt: now, updatedAt: now, appName: APP_NAME }, file.recovery);
    for (const record of file.records) {
      const payload = JSON.parse(await decryptRecord(key, record)) as LegacyV1Payload;
      vault.absorbLegacyPayload(payload, now);
    }
    return vault;
  }

  private absorbLegacyPayload(payload: LegacyV1Payload, now: number): void {
    switch (payload.kind) {
      case "profile": {
        const d = payload.data;
        const attributeKey = String(d.key ?? "");
        this.put("personalAttribute", {
          id: attributeKey || randomUUID(),
          attributeKey,
          label: String(d.label ?? attributeKey),
          value: String(d.value ?? ""),
          valueType: "custom",
          sensitivity: attributeKey.startsWith("card.") || attributeKey === "account.password" ? "sensitive" : "normal",
          updatedAt: typeof d.updatedAt === "number" ? d.updatedAt : now,
        });
        return;
      }
      case "site": {
        const d = payload.data;
        const origin = String(d.origin ?? "");
        const siteAccount: EntityPayloadMap["siteAccount"] = {
          id: String(d.siteId ?? randomUUID()),
          domain: safeHost(origin),
          displayName: String(d.serviceName ?? safeHost(origin)),
          createdAt: typeof d.registeredAt === "number" ? d.registeredAt : now,
          updatedAt: now,
        };
        if (origin) siteAccount.url = origin;
        this.put("siteAccount", siteAccount);
        return;
      }
      case "settings": {
        const d = payload.data;
        this.put("providerSettings", {
          id: "provider",
          provider: d.provider === "openai" ? "openai" : "anthropic",
          model: String(d.model ?? ""),
          apiKey: String(d.apiKey ?? ""),
          mode: d.mode === "ai" ? "ai" : "deterministic",
          updatedAt: now,
        });
        return;
      }
      case "candidate": {
        const d = payload.data;
        this.put("localDefinition", {
          id: String(d.id ?? randomUUID()),
          serviceName: String(d.serviceName ?? ""),
          source: d.source === "user" || d.source === "observation" ? d.source : "ai",
          status: "candidate",
          data: d,
          createdAt: typeof d.createdAt === "number" ? d.createdAt : now,
          updatedAt: now,
        });
        return;
      }
      case "diagnostic": {
        const d = payload.data;
        const diagnostic: EntityPayloadMap["diagnostic"] = {
          id: String(d.id ?? randomUUID()),
          at: typeof d.at === "number" ? d.at : now,
          type: legacyDiagType(d.type),
          message: String(d.message ?? ""),
          severity: legacySeverity(d.severity),
        };
        if (d.metadata && typeof d.metadata === "object") {
          diagnostic.metadata = d.metadata as Record<string, string | number | boolean>;
        }
        this.put("diagnostic", diagnostic);
        return;
      }
      case "mandate": {
        const d = payload.data;
        const mandate: EntityPayloadMap["mandate"] = {
          id: randomUUID(),
          operation: "registration",
          authorizedAt: typeof d.authorizedAt === "number" ? d.authorizedAt : now,
        };
        if (typeof d.origin === "string" && d.origin) mandate.scope = d.origin;
        this.put("mandate", mandate);
        return;
      }
      default: {
        // The on-disk v1 file is untrusted at migration time. Surface an
        // unrecognized record as a diagnostic rather than silently dropping it
        // (the vault is the user's source of truth — no silent data loss).
        const unknownKind = (payload as { kind?: unknown }).kind;
        this.put("diagnostic", {
          id: randomUUID(),
          at: now,
          type: "error",
          message: `unmigrated legacy record kind: ${String(unknownKind)}`,
          severity: "warn",
        });
        return;
      }
    }
  }
}

function safeHost(origin: string): string {
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin;
  }
}

function legacyDiagType(value: unknown): EntityPayloadMap["diagnostic"]["type"] {
  return value === "flow" || value === "error" || value === "wall" ? value : "app";
}

function legacySeverity(value: unknown): EntityPayloadMap["diagnostic"]["severity"] {
  return value === "warn" || value === "error" ? value : "info";
}
