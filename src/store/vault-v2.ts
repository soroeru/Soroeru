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
//
// Storage is injected as a `VaultPersistence` (Issue #556): this module never
// touches the file system and uses only `globalThis.crypto`, so it runs
// unchanged in Node, Electron, and the Chrome extension.

import { isSiteCollectionMap } from "../domain/site-collection-map.js";
import {
  ENTITY_KINDS,
  type DomainRecord,
  type EntityKind,
  type EntityPayloadMap,
} from "../domain/entities.js";
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
import { webCryptoRuntime } from "./crypto-runtime.js";
import { base64ToBytes, bytesEqual, bytesToBase64 } from "./encoding.js";
import { generateRecoveryKey, recoveryKeyToKek } from "./recovery.js";
import {
  VaultCorruptError,
  VaultFormatError,
  VaultLockedError,
  VaultNoRecoveryKeyError,
  VaultUnlockError,
} from "./vault-errors.js";
import type {
  EncryptedVaultData,
  VaultMetadata,
  VaultPersistence,
  VaultRecordEnvelope,
} from "./vault-persistence.js";

export {
  VaultCorruptError,
  VaultFormatError,
  VaultLockedError,
  VaultNoRecoveryKeyError,
  VaultStorageQuotaError,
  VaultUnlockError,
} from "./vault-errors.js";
export type {
  EncryptedVaultData,
  VaultMetadata,
  VaultPersistence,
  VaultRecordEnvelope,
} from "./vault-persistence.js";

/** On-disk vault format version. v2 is the first versioned record vault. */
export const VAULT_FORMAT_VERSION = 2 as const;

/** Default schema version stamped on written record envelopes. */
export const RECORD_SCHEMA_VERSION = 1 as const;

/**
 * Per-kind record schema versions, for kinds whose payload shape changed
 * (design #554 §6.4). Adding a kind or an optional field does not bump the
 * vault format version; older records stay readable and are re-stamped on the
 * next write. A record newer than this build understands fails closed.
 */
export const RECORD_SCHEMA_VERSIONS: Readonly<Record<EntityKind, number>> = Object.fromEntries(
  ENTITY_KINDS.map((kind) => [kind, kind === "workflowCheckpoint" ? 2 : RECORD_SCHEMA_VERSION]),
) as Record<EntityKind, number>;

/**
 * Key handling for an opened vault. `extractableKey: false` keeps the master key
 * as a non-extractable `CryptoKey` (the extension Side Panel session, design
 * #554 §6.2); recovery-key setup then needs the passphrase to derive a
 * short-lived extractable copy. Defaults to `true` (current Electron build).
 */
export interface VaultKeyOptions {
  extractableKey?: boolean;
}

const APP_NAME = "Soroeru";
const ENTITY_KIND_SET = new Set<string>(ENTITY_KINDS);

/**
 * Known plaintext encrypted under the master key and stored alongside the
 * records. It lets `open` reject a wrong passphrase even when the vault holds no
 * records yet (an empty vault has no ciphertext to fail GCM auth on otherwise).
 */
const PASSPHRASE_VERIFIER_TOKEN = "soroeru-vault-passphrase-verifier-v1";

type VaultFileV2 = EncryptedVaultData;

/** In-memory record: the decrypted payload plus its envelope bookkeeping. */
interface StoredRecord {
  payload: DomainRecord;
  schemaVersion: number;
  createdAt: number;
  updatedAt: number;
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
  private readonly persistence: VaultPersistence;
  private pendingSave: Promise<void> = Promise.resolve();
  private readonly extractableKey: boolean;
  /** entityKind -> (recordId -> stored record). Cleared on lock. */
  private readonly records = new Map<EntityKind, Map<string, StoredRecord>>();

  private constructor(
    persistence: VaultPersistence,
    key: MasterKey,
    kdf: KdfParams,
    metadata: VaultMetadata,
    recovery: EncryptedRecord | undefined,
    extractableKey: boolean,
  ) {
    this.persistence = persistence;
    this.extractableKey = extractableKey;
    this.key = key;
    this.kdf = kdf;
    this.metadata = metadata;
    this.recovery = recovery;
    for (const kind of ENTITY_KINDS) this.records.set(kind, new Map());
  }

  // --- Opening / creating ---

  /** Open (or create) the vault. A wrong passphrase fails GCM auth and throws. */
  static async open(
    persistence: VaultPersistence,
    passphrase: string,
    kdfAlgo: KdfAlgo = "argon2id",
    options: VaultKeyOptions = {},
  ): Promise<VaultV2> {
    const extractable = options.extractableKey ?? true;
    const raw = await VaultV2.loadRaw(persistence);
    if (raw && VaultV2.looksLikeV1(raw)) {
      return VaultV2.migrateFromV1(persistence, raw as unknown as LegacyV1File, passphrase, extractable);
    }
    const file = raw as VaultFileV2 | undefined;
    if (file && (file.vaultVersion === undefined || !Array.isArray(file.records))) {
      // Neither a v1 store nor a tagged v2 file: fail cleanly instead of
      // crashing later on `file.records` being undefined.
      throw new VaultFormatError("stored vault data is not a recognized Soroeru vault");
    }
    if (file) VaultV2.validateV2Version(file);
    const kdf = file?.kdf ?? newKdfParams(kdfAlgo);
    const key = await deriveKey(passphrase, kdf, webCryptoRuntime, extractable);
    const now = Date.now();
    const metadata = file?.metadata ?? { createdAt: now, updatedAt: now, appName: APP_NAME };
    // Reject a wrong passphrase up front, independent of record count.
    if (file?.verifier) await VaultV2.assertPassphraseVerifier(key, file.verifier);
    const vault = new VaultV2(persistence, key, kdf, metadata, file?.recovery, extractable);
    if (file) await vault.loadRecords(file.records, key);
    return vault;
  }

  /** Decrypt the stored verifier token and confirm it matches; throw otherwise. */
  private static async assertPassphraseVerifier(key: MasterKey, verifier: EncryptedRecord): Promise<void> {
    // A wrong passphrase fails GCM auth here (decryptRecord throws). A successful
    // decrypt that does not match the token means a corrupt/foreign verifier.
    let token: string;
    try {
      token = await decryptRecord(key, verifier);
    } catch (err) {
      throw new VaultUnlockError("passphrase does not open this vault", { cause: err });
    }
    if (token !== PASSPHRASE_VERIFIER_TOKEN) {
      throw new VaultCorruptError("vault passphrase verifier did not match");
    }
  }

  /** Open the vault using a recovery key instead of the passphrase (RFC-002 §6). */
  static async openWithRecoveryKey(
    persistence: VaultPersistence,
    recoveryKey: string,
    options: VaultKeyOptions = {},
  ): Promise<VaultV2> {
    const extractable = options.extractableKey ?? true;
    const file = (await VaultV2.loadRaw(persistence)) as VaultFileV2 | undefined;
    if (!file?.recovery) throw new VaultNoRecoveryKeyError();
    if (file.vaultVersion === undefined || !Array.isArray(file.records)) {
      throw new VaultFormatError("stored vault data is not a recognized Soroeru vault");
    }
    VaultV2.validateV2Version(file);
    const kek = await recoveryKeyToKek(recoveryKey);
    let wrapped: string;
    try {
      wrapped = await decryptRecord(kek, file.recovery);
    } catch (err) {
      throw new VaultUnlockError("recovery key does not open this vault", { cause: err });
    }
    const rawKey = base64ToBytes(wrapped);
    let key: MasterKey;
    try {
      key = await importKeyRaw(rawKey, extractable);
    } finally {
      rawKey.fill(0);
    }
    const vault = new VaultV2(persistence, key, file.kdf, file.metadata, file.recovery, extractable);
    await vault.loadRecords(file.records, key);
    return vault;
  }

  /** Load the stored document; anything other than a JSON object is corrupt (fail closed). */
  private static async loadRaw(persistence: VaultPersistence): Promise<Record<string, unknown> | undefined> {
    const raw: unknown = await persistence.load();
    if (raw === null) return undefined;
    if (typeof raw !== "object" || Array.isArray(raw)) {
      throw new VaultCorruptError("stored vault data is not a JSON object");
    }
    return raw as Record<string, unknown>;
  }

  private static looksLikeV1(raw: Record<string, unknown>): boolean {
    return typeof raw.version === "number" && raw.vaultVersion === undefined && Array.isArray(raw.records);
  }

  private static validateV2Version(raw: VaultFileV2): void {
    if (raw.vaultVersion !== VAULT_FORMAT_VERSION) {
      throw new VaultFormatError(
        `vault format version ${String(raw.vaultVersion)} is not supported; expected ${VAULT_FORMAT_VERSION}`,
      );
    }
  }

  /** Reject a document that cannot be authenticated, before any KDF or store write. */
  private static assertImportDocument(parsed: VaultFileV2): void {
    const kdf = parsed.kdf;
    const metadata = parsed.metadata;
    const headerOk =
      !!kdf &&
      (kdf.algo === "argon2id" || kdf.algo === "pbkdf2-sha512") &&
      typeof kdf.salt === "string" &&
      kdf.salt.length > 0 &&
      Number.isInteger(kdf.iterations) &&
      kdf.iterations >= 1 &&
      !!metadata &&
      typeof metadata.createdAt === "number" &&
      typeof metadata.updatedAt === "number" &&
      typeof metadata.appName === "string" &&
      (parsed.verifier !== undefined || parsed.records.length > 0);
    if (!headerOk) {
      throw new VaultCorruptError("encrypted export has an invalid header or no authentication material");
    }
    for (const env of parsed.records) {
      if (
        !env ||
        typeof env.recordId !== "string" ||
        typeof env.entityKind !== "string" ||
        !ENTITY_KIND_SET.has(env.entityKind) ||
        typeof env.iv !== "string" ||
        typeof env.ciphertext !== "string"
      ) {
        throw new VaultCorruptError("encrypted export has an invalid record envelope");
      }
      const supported = RECORD_SCHEMA_VERSIONS[env.entityKind as EntityKind];
      if (!Number.isInteger(env.schemaVersion) || env.schemaVersion !== supported) {
        throw new VaultFormatError(
          `vault record ${env.recordId} has unsupported ${env.entityKind} schema version ${String(env.schemaVersion)}`,
        );
      }
    }
  }

  /** Decrypt every envelope into the in-memory maps. */
  private async loadRecords(envelopes: VaultRecordEnvelope[], key: MasterKey): Promise<void> {
    for (const env of envelopes) {
      if (!ENTITY_KIND_SET.has(env.entityKind)) {
        throw new VaultCorruptError(
          `unknown entity kind "${env.entityKind}" in vault record ${env.recordId}`,
        );
      }
      if (
        !Number.isInteger(env.schemaVersion) ||
        env.schemaVersion < 1 ||
        env.schemaVersion > RECORD_SCHEMA_VERSIONS[env.entityKind]
      ) {
        throw new VaultFormatError(
          `vault record ${env.recordId} has unsupported ${env.entityKind} schema version ${String(env.schemaVersion)}`,
        );
      }
      const plaintext = await decryptRecord(key, { iv: env.iv, ct: env.ciphertext });
      const payload = JSON.parse(plaintext) as DomainRecord;
      if (env.entityKind === "siteCollectionMap" && !isSiteCollectionMap(payload)) {
        throw new VaultCorruptError("invalid site collection map");
      }
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
    if (kind === "siteCollectionMap" && !isSiteCollectionMap(payload)) {
      throw new VaultCorruptError("invalid site collection map");
    }
    const existing = this.bucket(kind).get(payload.id);
    this.bucket(kind).set(payload.id, {
      payload,
      schemaVersion: RECORD_SCHEMA_VERSIONS[kind],
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
   *
   * A vault opened with a non-extractable key needs `passphrase`: it derives a
   * short-lived extractable copy of the same key, wraps it, and drops it
   * (design #554 §6.2). A passphrase that derives a different key is rejected.
   */
  async setupRecoveryKey(passphrase?: string): Promise<string> {
    const key = this.requireKey();
    let wrappable = key;
    if (!this.extractableKey) {
      if (passphrase === undefined) {
        throw new Error("recovery key setup on a non-extractable vault key requires the passphrase");
      }
      wrappable = await deriveKey(passphrase, this.kdf, webCryptoRuntime, true);
      if (!(await sameAesKey(key, wrappable))) throw new Error("passphrase does not match this vault");
    }
    const recoveryKey = generateRecoveryKey();
    const kek = await recoveryKeyToKek(recoveryKey);
    const raw = await exportKeyRaw(wrappable);
    try {
      this.recovery = await encryptRecord(kek, bytesToBase64(raw));
    } finally {
      raw.fill(0);
    }
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
    if (!this.extractableKey) {
      return sameAesKey(key, await deriveKey(candidate, this.kdf, webCryptoRuntime, false));
    }
    const candidateKey = await deriveKey(candidate, this.kdf);
    const [a, b] = await Promise.all([exportKeyRaw(key), exportKeyRaw(candidateKey)]);
    return bytesEqual(a, b);
  }

  /** Re-key under a fresh salt. Invalidates any recovery wrap (it wraps the old key). */
  async rekey(newPassphrase: string, kdfAlgo: KdfAlgo = "argon2id"): Promise<void> {
    this.requireKey();
    const newKdf = newKdfParams(kdfAlgo);
    this.key = await deriveKey(newPassphrase, newKdf, webCryptoRuntime, this.extractableKey);
    this.kdf = newKdf;
    this.recovery = undefined;
  }

  // --- Persistence ---

  /** Build the stored document shape; every record gets a fresh random IV. */
  private async serialize(): Promise<VaultFileV2> {
    const key = this.requireKey();
    const now = Date.now();
    const kdf = this.kdf;
    const metadata = { ...this.metadata, updatedAt: now };
    const recovery = this.recovery;
    // Capture every plaintext payload before encryption yields. Lock/close clears
    // the live maps, and callers may mutate records while encryption is pending.
    const snapshot = [];
    const records: VaultRecordEnvelope[] = [];
    for (const kind of ENTITY_KINDS) {
      for (const [id, stored] of this.bucket(kind)) {
        // Callers can mutate records returned by put/get/list. Validate the exact
        // map being serialized before any await or encrypted file replacement.
        if (
          kind === "siteCollectionMap" &&
          (!isSiteCollectionMap(stored.payload) || stored.payload.id !== id)
        ) {
          throw new VaultCorruptError("invalid site collection map");
        }
        snapshot.push({
          recordId: id,
          entityKind: kind,
          schemaVersion: stored.schemaVersion,
          payload: JSON.stringify(stored.payload),
          createdAt: stored.createdAt,
          updatedAt: stored.updatedAt,
        });
      }
    }
    for (const { payload, ...record } of snapshot) {
      const enc = await encryptRecord(key, payload);
      records.push({ ...record, iv: enc.iv, ciphertext: enc.ct });
    }
    const file: VaultFileV2 = {
      vaultVersion: VAULT_FORMAT_VERSION,
      kdf,
      metadata,
      verifier: await encryptRecord(key, PASSPHRASE_VERIFIER_TOKEN),
      records,
    };
    if (recovery) file.recovery = recovery;
    this.metadata = file.metadata;
    return file;
  }

  /** Persist everything; every record gets a fresh random IV. */
  async save(): Promise<void> {
    const snapshot = this.serialize();
    // Snapshots are captured synchronously, but writes must retain call order.
    // A failed earlier write must not prevent an explicit later retry.
    snapshot.catch(() => undefined);
    const saving = this.pendingSave
      .catch(() => undefined)
      .then(async () => {
        await this.persistence.save(await snapshot);
      });
    this.pendingSave = saving;
    await saving;
  }

  /** Same encrypted JSON shape as the stored document, for the user to copy elsewhere as a backup. */
  async exportEncrypted(): Promise<string> {
    return JSON.stringify(await this.serialize());
  }

  /**
   * Restore an encrypted export into `persistence` and open it. Validates the
   * vault format version before writing anything and refuses to overwrite
   * existing (or unreadable) stored data unless `options.overwrite` is set.
   */
  static async importEncrypted(
    persistence: VaultPersistence,
    exported: string,
    passphrase: string,
    options?: { overwrite?: boolean } & VaultKeyOptions,
  ): Promise<VaultV2> {
    let parsed: VaultFileV2;
    try {
      parsed = JSON.parse(exported) as VaultFileV2;
    } catch (err) {
      throw new VaultCorruptError("encrypted export is not valid JSON", { cause: err });
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      parsed.vaultVersion === undefined ||
      !Array.isArray(parsed.records)
    ) {
      throw new VaultFormatError("encrypted export is not a Vault v2 file");
    }
    if (!options?.overwrite) {
      // Corrupt stored data counts as existing: never replace it implicitly.
      const exists = await persistence.load().then(
        (data) => data !== null,
        () => true,
      );
      if (exists) {
        throw new Error("refusing to overwrite an existing vault (pass { overwrite: true } to replace it)");
      }
    }
    VaultV2.validateV2Version(parsed);
    VaultV2.assertImportDocument(parsed);
    // Authenticate and validate every record against a staged document before
    // committing. Subsequent saves by the returned vault use the real backend.
    const staged: VaultPersistence = {
      load: async () => parsed,
      save: (data) => persistence.save(data),
      clear: () => persistence.clear(),
    };
    const vault = await VaultV2.open(staged, passphrase, "argon2id", {
      extractableKey: options?.extractableKey ?? true,
    });
    try {
      await persistence.save(parsed);
      return vault;
    } catch (err) {
      vault.lock();
      throw err;
    }
  }

  // --- Migration from v1 (RFC-002 §2.4) ---

  /**
   * Migrate a v1 single-document store into a v2 record vault, in memory. The
   * caller still controls persistence: the migrated vault is saved on the next
   * save(), which writes the v2 shape through `persistence`.
   */
  private static async migrateFromV1(
    persistence: VaultPersistence,
    file: LegacyV1File,
    passphrase: string,
    extractable: boolean,
  ): Promise<VaultV2> {
    const key = await deriveKey(passphrase, file.kdf, webCryptoRuntime, extractable);
    const now = Date.now();
    const vault = new VaultV2(
      persistence,
      key,
      file.kdf,
      { createdAt: now, updatedAt: now, appName: APP_NAME },
      file.recovery,
      extractable,
    );
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
          id: attributeKey || webCryptoRuntime.randomUUID(),
          attributeKey,
          label: String(d.label ?? attributeKey),
          value: String(d.value ?? ""),
          valueType: "custom",
          sensitivity:
            attributeKey.startsWith("card.") || attributeKey === "account.password" ? "sensitive" : "normal",
          updatedAt: typeof d.updatedAt === "number" ? d.updatedAt : now,
        });
        return;
      }
      case "site": {
        const d = payload.data;
        const origin = String(d.origin ?? "");
        const siteAccount: EntityPayloadMap["siteAccount"] = {
          id: String(d.siteId ?? webCryptoRuntime.randomUUID()),
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
          id: String(d.id ?? webCryptoRuntime.randomUUID()),
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
          id: String(d.id ?? webCryptoRuntime.randomUUID()),
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
          id: webCryptoRuntime.randomUUID(),
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
          id: webCryptoRuntime.randomUUID(),
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

/**
 * True when two AES-GCM keys hold the same bytes, without exporting either:
 * a token sealed under `a` authenticates under `b` only if the keys match.
 */
async function sameAesKey(a: MasterKey, b: MasterKey): Promise<boolean> {
  const probe = await encryptRecord(a, PASSPHRASE_VERIFIER_TOKEN);
  try {
    return (await decryptRecord(b, probe)) === PASSPHRASE_VERIFIER_TOKEN;
  } catch {
    return false;
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
