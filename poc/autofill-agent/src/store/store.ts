// Minimal encrypted store for the PoC (RFC-001 v3 §3, §9).
// All personal data (profile values, site records, mandates) is persisted only
// as AES-256-GCM records under a key derived from the master passphrase.
// Decrypted values stay in memory while the store is unlocked and are never logged.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ProfileKey, RegistrationMandate, SiteRecord } from "../types.js";
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

export interface ProfileEntry {
  key: ProfileKey;
  label: string;
  value: string;
  /** Custom fields keep the words they were created from, for re-matching. */
  matchTerms?: string[];
  updatedAt: number;
}

interface StoreFile {
  version: 1;
  kdf: KdfParams;
  records: EncryptedRecord[];
}

interface StorePayload {
  kind: "profile" | "site" | "mandate";
  data: ProfileEntry | SiteRecord | RegistrationMandate;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export class PocStore {
  private key: MasterKey;
  private kdf: KdfParams;
  private readonly filePath: string;

  readonly profile = new Map<ProfileKey, ProfileEntry>();
  readonly siteRecords = new Map<string, SiteRecord>();
  readonly mandates: RegistrationMandate[] = [];

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
      } else {
        store.mandates.push(payload.data as RegistrationMandate);
      }
    }
    return store;
  }

  getValue(key: ProfileKey): string | undefined {
    return this.profile.get(key)?.value;
  }

  setProfileValue(key: ProfileKey, label: string, value: string, matchTerms?: string[]): void {
    const entry: ProfileEntry = { key, label, value, updatedAt: Date.now() };
    if (matchTerms) entry.matchTerms = matchTerms;
    this.profile.set(key, entry);
  }

  upsertSiteRecord(record: SiteRecord): void {
    this.siteRecords.set(record.siteId, record);
  }

  addMandate(mandate: RegistrationMandate): void {
    this.mandates.push(mandate);
  }

  /** Persist everything; every record gets a fresh random IV. */
  async save(): Promise<void> {
    const payloads: StorePayload[] = [
      ...[...this.profile.values()].map((data): StorePayload => ({ kind: "profile", data })),
      ...[...this.siteRecords.values()].map((data): StorePayload => ({ kind: "site", data })),
      ...this.mandates.map((data): StorePayload => ({ kind: "mandate", data })),
    ];
    const records: EncryptedRecord[] = [];
    for (const payload of payloads) {
      records.push(await encryptRecord(this.key, JSON.stringify(payload)));
    }
    const file: StoreFile = { version: 1, kdf: this.kdf, records };
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(file), "utf8");
  }
}
