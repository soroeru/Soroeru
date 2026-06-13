// Minimal encrypted store for the PoC (RFC-001 v3 §3, §9).
// All personal data (profile values, site records, mandates, provider settings)
// is persisted only as AES-256-GCM records under a key derived from the master
// passphrase. Decrypted values stay in memory while the store is unlocked and
// are never logged.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { MOST_SENSITIVE_KEY, type ProfileKey, type RegistrationMandate, type SiteRecord } from "../types.js";
import {
  decryptRecord,
  deriveKey,
  encryptRecord,
  newKdfParams,
  type EncryptedRecord,
  type KdfAlgo,
  type KdfParams,
  type MasterKey,
} from "./crypto.js";

/**
 * On-disk store format version. The field name is `version`; bump it and add a
 * `migrateStoreFile` branch whenever the persisted shape changes. v1 is the
 * initial encrypted-records format.
 */
export const STORE_FORMAT_VERSION = 1 as const;

export interface ProfileEntry {
  key: ProfileKey;
  label: string;
  value: string;
  /** Custom fields keep the words they were created from, for re-matching. */
  matchTerms?: string[];
  updatedAt: number;
}

/** The user's own AI provider configuration (REQ-012). The API key is a secret. */
export interface ProviderSettings {
  provider: "anthropic" | "openai";
  model: string;
  apiKey: string;
}

interface StoreFile {
  version: number;
  kdf: KdfParams;
  records: EncryptedRecord[];
}

interface StorePayload {
  kind: "profile" | "site" | "mandate" | "settings";
  data: ProfileEntry | SiteRecord | RegistrationMandate | ProviderSettings;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Thrown when the store is used after `lock()` has cleared the in-memory key. */
export class StoreLockedError extends Error {
  constructor() {
    super("store is locked");
    this.name = "StoreLockedError";
  }
}

/**
 * Validate / upgrade a parsed store file to the current format. Throws on a
 * version newer than this build understands instead of silently mis-reading it.
 */
function migrateStoreFile(file: StoreFile): StoreFile {
  if (file.version === STORE_FORMAT_VERSION) return file;
  if (file.version > STORE_FORMAT_VERSION) {
    throw new Error(`store format version ${file.version} is newer than supported ${STORE_FORMAT_VERSION}`);
  }
  // No older versions exist yet; future migrations slot in here per version.
  throw new Error(`unsupported store format version ${file.version}`);
}

export class PocStore {
  private key: MasterKey | null;
  private kdf: KdfParams;
  private readonly filePath: string;

  readonly profile = new Map<ProfileKey, ProfileEntry>();
  readonly siteRecords = new Map<string, SiteRecord>();
  readonly mandates: RegistrationMandate[] = [];
  private settings: ProviderSettings | undefined;

  private constructor(filePath: string, key: MasterKey, kdf: KdfParams) {
    this.filePath = filePath;
    this.key = key;
    this.kdf = kdf;
  }

  /** Open (or create) the store. Wrong passphrase fails GCM authentication and throws. */
  static async open(filePath: string, passphrase: string, kdfAlgo: KdfAlgo = "argon2id"): Promise<PocStore> {
    let file: StoreFile | undefined;
    try {
      file = JSON.parse(await readFile(filePath, "utf8")) as StoreFile;
    } catch {
      file = undefined;
    }
    if (file) file = migrateStoreFile(file);
    const kdf = file?.kdf ?? newKdfParams(kdfAlgo);
    const key = await deriveKey(passphrase, kdf);
    const store = new PocStore(filePath, key, kdf);
    for (const record of file?.records ?? []) {
      const payload = JSON.parse(await decryptRecord(key, record)) as StorePayload;
      if (payload.kind === "profile") {
        const entry = payload.data as ProfileEntry;
        store.profile.set(entry.key, entry);
      } else if (payload.kind === "site") {
        const rec = payload.data as SiteRecord;
        store.siteRecords.set(rec.siteId, rec);
      } else if (payload.kind === "settings") {
        store.settings = payload.data as ProviderSettings;
      } else {
        store.mandates.push(payload.data as RegistrationMandate);
      }
    }
    return store;
  }

  private requireKey(): MasterKey {
    if (this.key === null) throw new StoreLockedError();
    return this.key;
  }

  get isLocked(): boolean {
    return this.key === null;
  }

  /**
   * Drop the master key and every decrypted value from memory. Call on idle /
   * shutdown; the store must be reopened with the passphrase to be used again.
   */
  lock(): void {
    this.key = null;
    this.profile.clear();
    this.siteRecords.clear();
    this.mandates.length = 0;
    this.settings = undefined;
  }

  getValue(key: ProfileKey): string | undefined {
    this.requireKey();
    return this.profile.get(key)?.value;
  }

  /**
   * Sanctioned accessor for the automation layer to read a value at fill time,
   * including the most-sensitive field (CVV). Functionally the same as
   * `getValue`, but named so call sites that touch CVV are auditable.
   */
  getValueForFill(key: ProfileKey): string | undefined {
    return this.getValue(key);
  }

  /**
   * Decrypted values keyed by profile key for local transforms, **excluding the
   * most-sensitive field** (CVV) so it is never broadcast into shared maps; CVV
   * is read individually via `getValueForFill` only when it is being filled.
   */
  profileView(): ReadonlyMap<ProfileKey, string> {
    this.requireKey();
    const view = new Map<ProfileKey, string>();
    for (const entry of this.profile.values()) {
      if (entry.key === MOST_SENSITIVE_KEY) continue;
      view.set(entry.key, entry.value);
    }
    return view;
  }

  setProfileValue(key: ProfileKey, label: string, value: string, matchTerms?: string[]): void {
    this.requireKey();
    const entry: ProfileEntry = { key, label, value, updatedAt: Date.now() };
    if (matchTerms) entry.matchTerms = matchTerms;
    this.profile.set(key, entry);
  }

  getSettings(): ProviderSettings | undefined {
    this.requireKey();
    return this.settings;
  }

  setProviderSettings(settings: ProviderSettings): void {
    this.requireKey();
    this.settings = settings;
  }

  upsertSiteRecord(record: SiteRecord): void {
    this.requireKey();
    this.siteRecords.set(record.siteId, record);
  }

  addMandate(mandate: RegistrationMandate): void {
    this.requireKey();
    this.mandates.push(mandate);
  }

  /** Persist everything; every record gets a fresh random IV. */
  async save(): Promise<void> {
    const key = this.requireKey();
    const payloads: StorePayload[] = [
      ...[...this.profile.values()].map((data): StorePayload => ({ kind: "profile", data })),
      ...[...this.siteRecords.values()].map((data): StorePayload => ({ kind: "site", data })),
      ...this.mandates.map((data): StorePayload => ({ kind: "mandate", data })),
    ];
    if (this.settings) payloads.push({ kind: "settings", data: this.settings });
    const records: EncryptedRecord[] = [];
    for (const payload of payloads) {
      records.push(await encryptRecord(key, JSON.stringify(payload)));
    }
    const file: StoreFile = { version: STORE_FORMAT_VERSION, kdf: this.kdf, records };
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(file), "utf8");
  }
}
