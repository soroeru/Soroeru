// Minimal encrypted store for the PoC (RFC-001 v3 §3, §9).
// All personal data (profile values, site records, mandates, provider settings)
// is persisted only as AES-256-GCM records under a key derived from the master
// passphrase. Decrypted values stay in memory while the store is unlocked and
// are never logged.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { validateCandidateDefinition } from "../agent/definitions.js";
import {
  MOST_SENSITIVE_KEY,
  type AccountNextAction,
  type AccountState,
  type LocalCandidateDefinition,
  type ProfileKey,
  type RegistrationMandate,
  type SiteRecord,
} from "../types.js";
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
  /** Deterministic remains the default; AI is used only when the user enables it. */
  mode?: "deterministic" | "ai";
  /** Remembered local folder for user-saved Chrome Password Manager CSV exports (#132). */
  chromePasswordCsvDir?: string;
}

export interface DiagnosticEvent {
  id: string;
  at: number;
  type: "app" | "flow" | "error" | "wall";
  message: string;
  severity: "info" | "warn" | "error";
  /** Sanitized metadata only: no raw profile values, prompts, cookies, or tokens. */
  metadata?: Record<string, string | number | boolean>;
}

interface StoreFile {
  version: number;
  kdf: KdfParams;
  records: EncryptedRecord[];
  /** Present iff a recovery key has been set up (SEC-003 / #44): the master
   *  key, wrapped under SHA-256(recovery key). */
  recovery?: EncryptedRecord;
}

interface StorePayload {
  kind: "profile" | "site" | "mandate" | "settings" | "candidate" | "diagnostic";
  data: ProfileEntry | SiteRecord | RegistrationMandate | ProviderSettings | LocalCandidateDefinition | DiagnosticEvent;
}

function nextActionForState(state: AccountState): AccountNextAction {
  switch (state) {
    case "unknown":
    case "notRegistered":
      return "startRegistration";
    case "registrationPending":
      return "resumeRegistration";
    case "registered":
    case "imported":
      return "reviewInventory";
    case "updateNeeded":
      return "runUpdate";
    case "updateFailed":
      return "retryUpdate";
    case "withdrawalCandidate":
      return "prepareWithdrawal";
  }
}

function stateFromLegacyStatus(status: SiteRecord["status"]): AccountState {
  switch (status) {
    case "registered":
    case "updated":
      return "registered";
    case "assistedFill":
    case "manualHandoff":
      return "registrationPending";
    case "declined":
      return "notRegistered";
    case "needsUpdate":
      return "updateNeeded";
    case "failed":
      return "updateFailed";
  }
}

function normalizeSiteRecord(record: SiteRecord): SiteRecord {
  const rec = record as SiteRecord & { accountState?: AccountState };
  const accountState = rec.accountState ?? stateFromLegacyStatus(record.status);
  rec.accountState = accountState;
  rec.nextAction = rec.nextAction ?? nextActionForState(accountState);
  rec.lastCheckedAt = rec.lastCheckedAt ?? rec.lastUpdatedAt ?? rec.registeredAt;
  return rec;
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

export class StoreFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreFormatError";
  }
}

export class StoreCorruptError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StoreCorruptError";
  }
}

/** Thrown by `upsertLocalCandidate` when a candidate fails validation (#80). Invalid candidates are never persisted. */
export class CandidateValidationError extends Error {
  constructor(errors: string[]) {
    super(`invalid local candidate definition: ${errors.join("; ")}`);
    this.name = "CandidateValidationError";
  }
}

/**
 * Validate / upgrade a parsed store file to the current format. Throws on a
 * version newer than this build understands instead of silently mis-reading it.
 */
function migrateStoreFile(file: StoreFile): StoreFile {
  if (file.version === STORE_FORMAT_VERSION) return file;
  if (file.version > STORE_FORMAT_VERSION) {
    throw new StoreFormatError(`store format version ${file.version} is newer than supported ${STORE_FORMAT_VERSION}`);
  }
  // No older versions exist yet; future migrations slot in here per version.
  throw new StoreFormatError(`unsupported store format version ${file.version}`);
}

export class PocStore {
  private key: MasterKey | null;
  private kdf: KdfParams;
  private recovery: EncryptedRecord | undefined;
  private readonly filePath: string;

  readonly profile = new Map<ProfileKey, ProfileEntry>();
  readonly siteRecords = new Map<string, SiteRecord>();
  readonly mandates: RegistrationMandate[] = [];
  /** Local, unreviewed site definitions (#80, PRIV-003); never treated as official. */
  readonly localCandidates = new Map<string, LocalCandidateDefinition>();
  /** Local support diagnostics (#90); encrypted because even site/activity summaries are sensitive. */
  readonly diagnostics: DiagnosticEvent[] = [];
  private settings: ProviderSettings | undefined;

  private constructor(filePath: string, key: MasterKey, kdf: KdfParams, recovery?: EncryptedRecord) {
    this.filePath = filePath;
    this.key = key;
    this.kdf = kdf;
    this.recovery = recovery;
  }

  private static async readFile(filePath: string): Promise<StoreFile | undefined> {
    let text: string;
    try {
      text = await readFile(filePath, "utf8");
    } catch {
      return undefined;
    }
    let file: StoreFile;
    try {
      file = JSON.parse(text) as StoreFile;
    } catch (err) {
      throw new StoreCorruptError(`store file at ${filePath} is not valid JSON`, { cause: err });
    }
    return migrateStoreFile(file);
  }

  private static async loadRecords(store: PocStore, file: StoreFile | undefined, key: MasterKey): Promise<void> {
    for (const record of file?.records ?? []) {
      const payload = JSON.parse(await decryptRecord(key, record)) as StorePayload;
      if (payload.kind === "profile") {
        const entry = payload.data as ProfileEntry;
        store.profile.set(entry.key, entry);
      } else if (payload.kind === "site") {
        const rec = normalizeSiteRecord(payload.data as SiteRecord);
        store.siteRecords.set(rec.siteId, rec);
      } else if (payload.kind === "settings") {
        store.settings = payload.data as ProviderSettings;
      } else if (payload.kind === "candidate") {
        const candidate = payload.data as LocalCandidateDefinition;
        store.localCandidates.set(candidate.id, candidate);
      } else if (payload.kind === "diagnostic") {
        store.diagnostics.push(payload.data as DiagnosticEvent);
      } else {
        store.mandates.push(payload.data as RegistrationMandate);
      }
    }
  }

  /** Open (or create) the store. Wrong passphrase fails GCM authentication and throws. */
  static async open(filePath: string, passphrase: string, kdfAlgo: KdfAlgo = "argon2id"): Promise<PocStore> {
    const file = await PocStore.readFile(filePath);
    const kdf = file?.kdf ?? newKdfParams(kdfAlgo);
    const key = await deriveKey(passphrase, kdf);
    const store = new PocStore(filePath, key, kdf, file?.recovery);
    await PocStore.loadRecords(store, file, key);
    return store;
  }

  /**
   * Open the store using a recovery key instead of the passphrase (SEC-003 /
   * #44). Fails if no recovery key was set up, or the given key does not
   * unwrap the stored master key (wrong recovery key / tampering).
   */
  static async openWithRecoveryKey(filePath: string, recoveryKey: string): Promise<PocStore> {
    const file = await PocStore.readFile(filePath);
    if (!file?.recovery) throw new Error("no recovery key is configured for this store");
    const kek = await recoveryKeyToKek(recoveryKey);
    const rawKey = Buffer.from(await decryptRecord(kek, file.recovery), "base64");
    const key = await importKeyRaw(rawKey);
    const store = new PocStore(filePath, key, file.kdf, file.recovery);
    await PocStore.loadRecords(store, file, key);
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
   * Check whether `candidate` re-derives the same master key under this
   * store's KDF params, without changing any state. Used by the UI to
   * require master-passphrase re-entry before revealing the most-sensitive
   * fields (CVV, credentials, API key) (UI-001 / #17).
   */
  async verifyPassphrase(candidate: string): Promise<boolean> {
    const key = this.requireKey();
    const candidateKey = await deriveKey(candidate, this.kdf);
    const [a, b] = await Promise.all([exportKeyRaw(key), exportKeyRaw(candidateKey)]);
    return Buffer.from(a).equals(Buffer.from(b));
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
    this.localCandidates.clear();
    this.diagnostics.length = 0;
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

  /** Remove a profile field (user-initiated). Returns true if it existed. */
  deleteProfileValue(key: ProfileKey): boolean {
    this.requireKey();
    return this.profile.delete(key);
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
    this.siteRecords.set(record.siteId, normalizeSiteRecord(record));
  }

  setSiteAccountState(siteId: string, accountState: AccountState, now: number = Date.now()): SiteRecord | undefined {
    this.requireKey();
    const record = this.siteRecords.get(siteId);
    if (!record) return undefined;
    record.accountState = accountState;
    record.nextAction = nextActionForState(accountState);
    record.lastCheckedAt = now;
    if (accountState === "withdrawalCandidate") record.withdrawalCandidateAt = now;
    this.siteRecords.set(siteId, record);
    return record;
  }

  // --- Per-site inventory API (REQ-010) for the UI / bulk update ---
  getSiteRecord(siteId: string): SiteRecord | undefined {
    this.requireKey();
    return this.siteRecords.get(siteId);
  }

  listSiteRecords(): SiteRecord[] {
    this.requireKey();
    return [...this.siteRecords.values()];
  }

  /** Remove a site from the inventory (user-initiated). Returns true if it existed. */
  deleteSiteRecord(siteId: string): boolean {
    this.requireKey();
    return this.siteRecords.delete(siteId);
  }

  // --- Local candidate definitions API (#80, PRIV-003) ---

  /**
   * Add or replace a local candidate definition. Validates the candidate
   * (`validateCandidateDefinition`) first; invalid candidates are never
   * stored.
   */
  upsertLocalCandidate(candidate: LocalCandidateDefinition): void {
    this.requireKey();
    const { ok, errors } = validateCandidateDefinition(candidate);
    if (!ok) throw new CandidateValidationError(errors);
    this.localCandidates.set(candidate.id, candidate);
  }

  getLocalCandidate(id: string): LocalCandidateDefinition | undefined {
    this.requireKey();
    return this.localCandidates.get(id);
  }

  listLocalCandidates(): LocalCandidateDefinition[] {
    this.requireKey();
    return [...this.localCandidates.values()];
  }

  /** Remove a local candidate definition (user-initiated). Returns true if it existed. */
  deleteLocalCandidate(id: string): boolean {
    this.requireKey();
    return this.localCandidates.delete(id);
  }

  /** Mandates for a given origin (or all), for audit display. */
  listMandates(origin?: string): RegistrationMandate[] {
    this.requireKey();
    return origin ? this.mandates.filter((m) => m.origin === origin) : [...this.mandates];
  }

  addMandate(mandate: RegistrationMandate): void {
    this.requireKey();
    this.mandates.push(mandate);
  }

  addDiagnosticEvent(event: Omit<DiagnosticEvent, "id" | "at"> & { id?: string; at?: number }): DiagnosticEvent {
    this.requireKey();
    const diagnostic: DiagnosticEvent = {
      id: event.id ?? `diag-${Date.now()}-${this.diagnostics.length + 1}`,
      at: event.at ?? Date.now(),
      type: event.type,
      message: event.message,
      severity: event.severity,
    };
    if (event.metadata) diagnostic.metadata = event.metadata;
    this.diagnostics.push(diagnostic);
    return diagnostic;
  }

  listDiagnosticEvents(limit = 100): DiagnosticEvent[] {
    this.requireKey();
    return [...this.diagnostics].sort((a, b) => b.at - a.at).slice(0, limit);
  }

  /** True once a recovery key has been set up (SEC-003 / #44). */
  get hasRecoveryKey(): boolean {
    return this.recovery !== undefined;
  }

  /**
   * Generate a new recovery key, wrap the current master key under it, and
   * stage the wrap for the next `save()`. Returns the recovery key for
   * one-time display; the caller must show it to the user immediately and
   * never log or persist the plaintext value itself.
   */
  async setupRecoveryKey(): Promise<string> {
    const key = this.requireKey();
    const recoveryKey = generateRecoveryKey();
    const kek = await recoveryKeyToKek(recoveryKey);
    const raw = await exportKeyRaw(key);
    this.recovery = await encryptRecord(kek, Buffer.from(raw).toString("base64"));
    return recoveryKey;
  }

  /** Remove the recovery wrap (staged for the next `save()`). */
  removeRecoveryKey(): void {
    this.requireKey();
    this.recovery = undefined;
  }

  /** Check whether `candidate` unwraps the current recovery wrap, without unlocking a new store. */
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

  /**
   * Change the passphrase: derive a new master key under a fresh KDF salt and
   * switch to it for subsequent reads/writes. This invalidates any existing
   * recovery wrap (it wraps the old key), so it is cleared here; call
   * `setupRecoveryKey()` again afterward if recovery should remain available.
   * Caller must `save()` to persist.
   */
  async rekey(newPassphrase: string, kdfAlgo: KdfAlgo = "argon2id"): Promise<void> {
    this.requireKey();
    const newKdf = newKdfParams(kdfAlgo);
    const newKey = await deriveKey(newPassphrase, newKdf);
    this.key = newKey;
    this.kdf = newKdf;
    this.recovery = undefined;
  }

  /** Build the on-disk file shape; every record gets a fresh random IV. */
  private async serialize(): Promise<StoreFile> {
    const key = this.requireKey();
    const payloads: StorePayload[] = [
      ...[...this.profile.values()].map((data): StorePayload => ({ kind: "profile", data })),
      ...[...this.siteRecords.values()].map((data): StorePayload => ({ kind: "site", data })),
      ...this.mandates.map((data): StorePayload => ({ kind: "mandate", data })),
      ...[...this.localCandidates.values()].map((data): StorePayload => ({ kind: "candidate", data })),
      ...this.diagnostics.map((data): StorePayload => ({ kind: "diagnostic", data })),
    ];
    if (this.settings) payloads.push({ kind: "settings", data: this.settings });
    const records: EncryptedRecord[] = [];
    for (const payload of payloads) {
      records.push(await encryptRecord(key, JSON.stringify(payload)));
    }
    const file: StoreFile = { version: STORE_FORMAT_VERSION, kdf: this.kdf, records };
    if (this.recovery) file.recovery = this.recovery;
    return file;
  }

  /** Persist everything; every record gets a fresh random IV. */
  async save(): Promise<void> {
    const file = await this.serialize();
    await mkdir(dirname(this.filePath), { recursive: true });
    // persist: encrypted-store — AES-256-GCM encrypted records only (docs/security.md §4)
    await writeFile(this.filePath, JSON.stringify(file), "utf8");
  }

  /**
   * Return the same encrypted JSON shape as the on-disk store, for the user
   * to copy elsewhere as a backup. No plaintext export exists; the file is
   * useless without the passphrase (or recovery key, if configured).
   */
  async exportEncrypted(): Promise<string> {
    const file = await this.serialize();
    return JSON.stringify(file);
  }

  /**
   * Restore an encrypted export to `filePath` and open it. Validates the
   * store format version before writing anything, and refuses to overwrite
   * an existing file at `filePath` unless `options.overwrite` is set.
   */
  static async importEncrypted(
    filePath: string,
    exported: string,
    passphrase: string,
    options?: { overwrite?: boolean },
  ): Promise<PocStore> {
    let parsed: StoreFile;
    try {
      parsed = JSON.parse(exported) as StoreFile;
    } catch (err) {
      throw new StoreCorruptError("encrypted export is not valid JSON", { cause: err });
    }
    const file = migrateStoreFile(parsed);
    if (!options?.overwrite) {
      const exists = await readFile(filePath).then(
        () => true,
        () => false,
      );
      if (exists) {
        throw new Error(`refusing to overwrite existing store at ${filePath} (pass { overwrite: true } to replace it)`);
      }
    }
    await mkdir(dirname(filePath), { recursive: true });
    // persist: encrypted-store — restoring an encrypted export writes the same encrypted shape (§4)
    await writeFile(filePath, JSON.stringify(file), "utf8");
    return PocStore.open(filePath, passphrase);
  }
}
