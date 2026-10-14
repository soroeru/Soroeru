// Issue #557 (design #554 §4.1, §6.1–§6.4; architecture §3.6): IndexedDB vault
// persistence, the Side Panel `VaultSession` (non-extractable key, Web Lock
// single writer, lock/close), and the extension manifest/CSP.
//
// No IndexedDB dependency is added (Issue #557 open question): `FakeIdbFactory`
// below models only the IndexedDB surface the adapter uses, with the contract
// that matters here — writes become visible only when the transaction commits,
// and an aborted transaction leaves the previous value.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { importFailureMessage, vaultErrorMessage } from "../../extension/sidepanel-messages.js";
import { FileVaultPersistence } from "../../src/store/file-vault-persistence.js";
import { DomainService } from "../../src/domain/domain-service.js";
import { exportKeyRaw } from "../../src/store/crypto.js";
import { IndexedDbVaultPersistence } from "../../src/store/indexeddb-vault-persistence.js";
import {
  EXPORT_REMINDER_SAVE_COUNT,
  PassphraseTooShortError,
  VaultSession,
  VaultSessionStateError,
  webLockManager,
  type VaultLockHandle,
  type VaultLockManager,
  type WebLocksLike,
} from "../../src/store/vault-session.js";
import {
  RECORD_SCHEMA_VERSIONS,
  VaultCorruptError,
  VaultFormatError,
  VaultLockedError,
  VaultNoRecoveryKeyError,
  VaultStorageQuotaError,
  VaultUnlockError,
  VaultV2,
  type EncryptedVaultData,
} from "../../src/store/vault-v2.js";

// dist/compiled/tests/unit/<this file> -> repo root is four levels up.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

// Fake data only (docs/testing.md).
const PASSPHRASE = "unit-test-passphrase";
const FIXTURE_PASSPHRASE = "fixture-passphrase-fake";

// --- Minimal IndexedDB fake (adapter boundary only) ---

type Handler = ((event: { preventDefault?: () => void }) => void) | null;

class FakeRequest {
  result: unknown;
  error: DOMException | null = null;
  onsuccess: Handler = null;
  onerror: Handler = null;
  onupgradeneeded: Handler = null;
  onblocked: Handler = null;
}

class FakeStore {
  constructor(
    private readonly tx: FakeTransaction,
    private readonly name: string,
  ) {}
  get(key: string): FakeRequest {
    const request = new FakeRequest();
    const value = this.tx.db.factory.data.get(this.tx.db.name)?.get(this.name)?.get(key);
    queueMicrotask(() => {
      request.result = value;
      request.onsuccess?.({});
    });
    return request;
  }
  put(value: unknown, key: string): FakeRequest {
    this.tx.requireWritable();
    this.tx.pending.push(() => this.table().set(key, value));
    return new FakeRequest();
  }
  delete(key: string): FakeRequest {
    this.tx.requireWritable();
    this.tx.pending.push(() => this.table().delete(key));
    return new FakeRequest();
  }
  private table(): Map<string, unknown> {
    const tables = this.tx.db.factory.data.get(this.tx.db.name);
    const table = tables?.get(this.name);
    if (!table) throw new Error("missing fake table");
    return table;
  }
}

class FakeTransaction {
  readonly pending: Array<() => void> = [];
  error: DOMException | null = null;
  oncomplete: Handler = null;
  onabort: Handler = null;
  onerror: Handler = null;
  private finished = false;
  constructor(
    readonly db: FakeDatabase,
    private readonly storeName: string,
    private readonly mode: "readonly" | "readwrite",
  ) {
    // Auto-commit after the current task, like IndexedDB once no requests are pending.
    setTimeout(() => this.commit(), 0);
  }
  objectStore(name: string): FakeStore {
    assert.equal(name, this.storeName);
    return new FakeStore(this, name);
  }
  requireWritable(): void {
    if (this.mode !== "readwrite") throw new DOMException("read-only transaction", "ReadOnlyError");
  }
  abort(): void {
    if (this.finished) throw new DOMException("transaction finished", "InvalidStateError");
    this.finished = true;
    this.pending.length = 0;
    queueMicrotask(() => this.onabort?.({}));
  }
  private commit(): void {
    if (this.finished) return;
    const failure = this.mode === "readwrite" ? this.db.factory.nextCommitFailure : null;
    if (failure) {
      this.db.factory.nextCommitFailure = null;
      this.error = failure;
      this.finished = true;
      this.pending.length = 0;
      this.onabort?.({});
      return;
    }
    this.finished = true;
    for (const write of this.pending) write();
    this.oncomplete?.({});
  }
}

class FakeDatabase {
  onversionchange: Handler = null;
  closed = false;
  constructor(
    readonly factory: FakeIdbFactory,
    readonly name: string,
  ) {}
  get objectStoreNames(): { contains(name: string): boolean } {
    return { contains: (name) => this.factory.data.get(this.name)?.has(name) ?? false };
  }
  createObjectStore(name: string): void {
    this.factory.data.get(this.name)?.set(name, new Map());
  }
  transaction(storeName: string, mode: "readonly" | "readwrite"): FakeTransaction {
    if (this.closed) throw new DOMException("database closed", "InvalidStateError");
    return new FakeTransaction(this, storeName, mode);
  }
  close(): void {
    this.closed = true;
  }
}

class FakeIdbFactory {
  /** database name -> object store name -> key -> value */
  readonly data = new Map<string, Map<string, Map<string, unknown>>>();
  /** Fail the next readwrite commit with this error (the transaction aborts). */
  nextCommitFailure: DOMException | null = null;
  /** Connections handed out, to simulate another context's version change. */
  readonly connections: FakeDatabase[] = [];
  open(name: string): FakeRequest {
    const request = new FakeRequest();
    queueMicrotask(() => {
      const isNew = !this.data.has(name);
      if (isNew) this.data.set(name, new Map());
      const db = new FakeDatabase(this, name);
      this.connections.push(db);
      request.result = db;
      if (isNew) request.onupgradeneeded?.({});
      request.onsuccess?.({});
    });
    return request;
  }
  /** Raw stored document, as another context would see it. */
  stored(): unknown {
    return this.data.get("soroeru-vault")?.get("vault")?.get("document");
  }
  setStored(value: unknown): void {
    if (!this.data.has("soroeru-vault")) this.data.set("soroeru-vault", new Map([["vault", new Map()]]));
    this.data.get("soroeru-vault")?.get("vault")?.set("document", value);
  }
}

function idb(factory: FakeIdbFactory): IndexedDbVaultPersistence {
  return new IndexedDbVaultPersistence(factory as unknown as IDBFactory);
}

/** In-process lock manager with `ifAvailable` semantics. */
class FakeLockManager implements VaultLockManager {
  held = false;
  async tryAcquire(): Promise<VaultLockHandle | null> {
    if (this.held) return null;
    this.held = true;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.held = false;
      },
    };
  }
}

function newSession(factory: FakeIdbFactory, locks: VaultLockManager = new FakeLockManager()): VaultSession {
  return new VaultSession({ persistence: idb(factory), lockManager: locks, kdfAlgo: "pbkdf2-sha512" });
}

function siteAccount(id: string, displayName: string) {
  return { id, domain: "example.test", displayName, createdAt: 1, updatedAt: 1 };
}

// --- IndexedDbVaultPersistence ---

test("IndexedDB: empty database loads as null; save/load round-trips; clear removes", async () => {
  const factory = new FakeIdbFactory();
  const persistence = idb(factory);
  assert.equal(await persistence.load(), null);

  const vault = await VaultV2.open(persistence, PASSPHRASE, "pbkdf2-sha512", { extractableKey: false });
  vault.put("siteAccount", siteAccount("acct-1", "Example Shop"));
  await vault.save();
  assert.equal(typeof factory.stored(), "string");
  assert.doesNotMatch(String(factory.stored()), /Example Shop/, "only ciphertext is stored");

  const reopened = await VaultV2.open(idb(factory), PASSPHRASE);
  assert.equal(reopened.get("siteAccount", "acct-1")?.displayName, "Example Shop");

  await persistence.clear();
  assert.equal(await persistence.load(), null);
});

test("IndexedDB: a failed save (quota) rejects and keeps the previous version", async () => {
  const factory = new FakeIdbFactory();
  const persistence = idb(factory);
  const vault = await VaultV2.open(persistence, PASSPHRASE, "pbkdf2-sha512");
  vault.put("siteAccount", siteAccount("acct-1", "Before"));
  await vault.save();
  const before = factory.stored();

  vault.put("siteAccount", siteAccount("acct-1", "After"));
  factory.nextCommitFailure = new DOMException("quota", "QuotaExceededError");
  await assert.rejects(vault.save(), VaultStorageQuotaError);
  assert.equal(factory.stored(), before);

  factory.nextCommitFailure = new DOMException("disk", "UnknownError");
  await assert.rejects(vault.save(), (err: unknown) => (err as DOMException).name === "UnknownError");
  assert.equal(factory.stored(), before);

  const reopened = await VaultV2.open(idb(factory), PASSPHRASE);
  assert.equal(reopened.get("siteAccount", "acct-1")?.displayName, "Before");
});

test("IndexedDB: unreadable stored data fails closed and is never overwritten", async () => {
  for (const raw of ["{not json", "null", "[]", "42", 42, { vaultVersion: 2 }]) {
    const factory = new FakeIdbFactory();
    factory.setStored(raw);
    await assert.rejects(idb(factory).load(), VaultCorruptError);
    await assert.rejects(VaultV2.open(idb(factory), PASSPHRASE), VaultCorruptError);
    const session = newSession(factory);
    await assert.rejects(session.start(), VaultCorruptError);
    assert.equal(session.state, "locked");
    await assert.rejects(session.create(PASSPHRASE), VaultSessionStateError);
    assert.deepEqual(factory.stored(), raw);
  }
});

test("IndexedDB: decrypts an existing Vault v2 fixture with a non-extractable key", async () => {
  const fixture = JSON.parse(
    await readFile(join(REPO_ROOT, "tests", "fixtures", "vault-v2", "legacy-argon2id.json"), "utf8"),
  ) as { fakeRecoveryKey: string; vault: EncryptedVaultData };
  const factory = new FakeIdbFactory();
  factory.setStored(JSON.stringify(fixture.vault));

  const session = new VaultSession({ persistence: idb(factory), lockManager: new FakeLockManager() });
  assert.equal(await session.start(), "locked");
  await session.unlock(FIXTURE_PASSPHRASE);
  assert.equal(session.vault.get("personalAttribute", "email")?.value, "taro.fixture@example.test");
  assert.equal(await session.vault.verifyPassphrase(FIXTURE_PASSPHRASE), true);
  assert.equal(await session.vault.verifyPassphrase("wrong-passphrase-fake"), false);

  session.lock();
  await session.unlockWithRecoveryKey(fixture.fakeRecoveryKey);
  assert.equal(session.vault.get("siteAccount", "acct-fixture")?.domain, "shop.example.test");
});

// --- Non-extractable master key ---

test("a non-extractable vault key cannot be exported; recovery setup needs the matching passphrase", async () => {
  const persistence = idb(new FakeIdbFactory());
  const vault = await VaultV2.open(persistence, PASSPHRASE, "pbkdf2-sha512", { extractableKey: false });
  const key = (vault as unknown as { key: CryptoKey }).key;
  assert.equal(key.extractable, false);
  await assert.rejects(exportKeyRaw(key));

  await assert.rejects(vault.setupRecoveryKey(), /requires the passphrase/);
  await assert.rejects(vault.setupRecoveryKey("wrong-passphrase-fake"), /does not match/);
  assert.equal(vault.hasRecoveryKey, false);

  const recoveryKey = await vault.setupRecoveryKey(PASSPHRASE);
  await vault.save();
  assert.equal(await vault.verifyRecoveryKey(recoveryKey), true);
  const recovered = await VaultV2.openWithRecoveryKey(persistence, recoveryKey, { extractableKey: false });
  assert.equal((recovered as unknown as { key: CryptoKey }).key.extractable, false);

  await vault.rekey("rotated-passphrase-fake", "pbkdf2-sha512");
  assert.equal((vault as unknown as { key: CryptoKey }).key.extractable, false);
});

// --- Record kinds and schema versions (design #554 §6.4) ---

test("new record kinds round-trip; workflowCheckpoint v2 adds resolutionStage; v1 stays readable", async () => {
  const persistence = idb(new FakeIdbFactory());
  const vault = await VaultV2.open(persistence, PASSPHRASE, "pbkdf2-sha512");
  vault.put("formSchemaCache", {
    id: "schema-1",
    site: "example.test",
    schemaId: "schema-1",
    version: 3,
    schema: { fields: [{ anchor: { kind: "field-id", fieldId: "f-1" }, attributeKey: "email" }] },
    fetchedAt: 1,
  });
  vault.put("cloudSettings", {
    id: "cloud",
    telemetryEnabled: false,
    cloudAssistEnabled: false,
    validatorKey: "fake-validator-key",
    queue: [
      { idempotencyKey: "k-1", kind: "telemetry", body: { result: "success" }, attempts: 0, enqueuedAt: 1 },
    ],
    updatedAt: 1,
  });
  vault.put("workflowCheckpoint", {
    id: "visibility:acct-1",
    workflow: "visibility",
    siteAccountId: "acct-1",
    step: "collect",
    status: "handoff",
    resolutionStage: "consent-pending",
    unresolvedAttributeKeys: ["phone.full"],
    updatedAt: 1,
  });
  await vault.save();

  const stored = (await persistence.load()) as EncryptedVaultData;
  const versions = Object.fromEntries(stored.records.map((r) => [r.entityKind, r.schemaVersion]));
  assert.equal(versions.workflowCheckpoint, 2);
  assert.equal(versions.formSchemaCache, 1);
  assert.equal(versions.cloudSettings, 1);

  const reopened = await VaultV2.open(persistence, PASSPHRASE);
  assert.equal(reopened.get("formSchemaCache", "schema-1")?.version, 3);
  assert.equal(reopened.get("cloudSettings", "cloud")?.queue[0]?.idempotencyKey, "k-1");
  assert.equal(reopened.get("workflowCheckpoint", "visibility:acct-1")?.resolutionStage, "consent-pending");

  // A v1 checkpoint (written before #557) still opens; a newer version fails closed.
  const checkpoint = stored.records.find((r) => r.entityKind === "workflowCheckpoint");
  assert.ok(checkpoint);
  checkpoint.schemaVersion = 1;
  await persistence.save(stored);
  assert.equal(
    (await VaultV2.open(persistence, PASSPHRASE)).get("workflowCheckpoint", "visibility:acct-1")?.step,
    "collect",
  );
  checkpoint.schemaVersion = RECORD_SCHEMA_VERSIONS.workflowCheckpoint + 1;
  await persistence.save(stored);
  await assert.rejects(VaultV2.open(persistence, PASSPHRASE), VaultFormatError);
});

// --- VaultSession ---

test("VaultSession: create shows a recovery key once, holds a non-extractable key, and lock drops it", async () => {
  const factory = new FakeIdbFactory();
  const session = newSession(factory);
  const states: string[] = [];
  session.onStateChange((state) => states.push(state));

  assert.equal(await session.start(), "absent");
  await assert.rejects(session.create("short"), PassphraseTooShortError);
  assert.equal(factory.stored(), undefined);

  const recoveryKey = await session.create(PASSPHRASE);
  assert.match(recoveryKey, /^[A-Z2-7]{4}(-[A-Z2-7]{1,4})+$/);
  assert.equal(session.state, "unlocked");
  assert.equal((session.vault as unknown as { key: CryptoKey }).key.extractable, false);
  assert.equal(typeof factory.stored(), "string", "the new vault is saved immediately");
  assert.doesNotMatch(String(factory.stored()), new RegExp(recoveryKey.replaceAll("-", "")));

  const vault = session.vault;
  vault.put("siteAccount", siteAccount("acct-1", "Example"));
  await session.save();

  session.lock();
  assert.equal(session.state, "locked");
  assert.throws(() => session.vault, VaultLockedError);
  assert.throws(() => vault.get("siteAccount", "acct-1"), VaultLockedError, "the old handle is locked too");
  await assert.rejects(session.save(), VaultLockedError);

  await assert.rejects(session.unlock("wrong-passphrase-fake"));
  assert.equal(session.state, "locked");
  await session.unlockWithRecoveryKey(recoveryKey);
  assert.equal(session.vault.get("siteAccount", "acct-1")?.displayName, "Example");
  session.lock();
  await session.unlock(PASSPHRASE);
  assert.equal(session.vault.get("siteAccount", "acct-1")?.displayName, "Example");

  session.close();
  assert.equal(session.state, "closed");
  assert.throws(() => session.vault, VaultLockedError);
  await assert.rejects(session.unlock(PASSPHRASE), VaultSessionStateError);
  assert.deepEqual(states, ["absent", "unlocked", "locked", "unlocked", "locked", "unlocked", "closed"]);
});

test("VaultSession: a second panel cannot unlock while another holds the Web Lock", async () => {
  const factory = new FakeIdbFactory();
  const locks = new FakeLockManager();
  const first = newSession(factory, locks);
  await first.start();
  await first.create(PASSPHRASE);

  const second = newSession(factory, locks);
  assert.equal(await second.start(), "in-use-elsewhere");
  await assert.rejects(second.unlock(PASSPHRASE), VaultSessionStateError);
  await assert.rejects(second.create(PASSPHRASE), VaultSessionStateError);

  first.close();
  assert.equal(await second.start(), "locked");
  await second.unlock(PASSPHRASE);
  assert.equal(second.state, "unlocked");
});

test("VaultSession: closing while unlock is deriving the key leaves no unlocked vault", async () => {
  const factory = new FakeIdbFactory();
  const setup = newSession(factory);
  await setup.start();
  await setup.create(PASSPHRASE);
  setup.close();

  const session = newSession(factory);
  await session.start();
  const unlocking = session.unlock(PASSPHRASE);
  session.close();
  await assert.rejects(unlocking, VaultSessionStateError);
  assert.equal(session.state, "closed");
  assert.throws(() => session.vault, VaultLockedError);
});

test("VaultSession: closing while create is deriving the key writes nothing and leaves no unlocked vault", async () => {
  const factory = new FakeIdbFactory();
  const locks = new FakeLockManager();
  const persistence = idb(factory);
  let session: VaultSession | undefined;
  let loads = 0;
  // The 3rd load is VaultV2.open's own read inside create(), i.e. just before the KDF:
  // close the panel there so the guards after the KDF/recovery setup must catch it.
  const original = persistence.load.bind(persistence);
  persistence.load = async () => {
    if (++loads === 3) session?.close();
    return original();
  };
  session = new VaultSession({ persistence, lockManager: locks, kdfAlgo: "pbkdf2-sha512" });
  await session.start();
  let saves = 0;
  const originalSave = persistence.save.bind(persistence);
  persistence.save = async (data) => {
    saves++;
    return originalSave(data);
  };
  await assert.rejects(session.create(PASSPHRASE), VaultSessionStateError);
  assert.equal(loads, 3);
  assert.equal(saves, 0);
  assert.equal(session.state, "closed");
  assert.throws(() => session.vault, VaultLockedError);
  assert.equal(factory.stored(), undefined, "no vault is written after the Web Lock was released");

  // The next panel finds no vault and can create one.
  const next = newSession(factory, locks);
  assert.equal(await next.start(), "absent");
});

test("VaultSession: refuses to create over data that appeared after start", async () => {
  const factory = new FakeIdbFactory();
  const session = newSession(factory);
  assert.equal(await session.start(), "absent");
  factory.setStored('{"vaultVersion":2,"records":[]}');
  await assert.rejects(session.create(PASSPHRASE), VaultSessionStateError);
  assert.equal(session.state, "locked");
  assert.equal(factory.stored(), '{"vaultVersion":2,"records":[]}');
});

test("VaultSession: a failed save keeps the previous version and the session usable", async () => {
  const factory = new FakeIdbFactory();
  const session = newSession(factory);
  await session.start();
  await session.create(PASSPHRASE);
  session.vault.put("siteAccount", siteAccount("acct-1", "Saved"));
  await session.save();
  const before = factory.stored();

  session.vault.put("siteAccount", siteAccount("acct-1", "Unsaved"));
  factory.nextCommitFailure = new DOMException("quota", "QuotaExceededError");
  await assert.rejects(session.save(), VaultStorageQuotaError);
  assert.equal(factory.stored(), before);
  assert.equal(session.state, "unlocked");
  assert.match(vaultErrorMessage(new VaultStorageQuotaError()), /保存容量/);
});

test("VaultSession: export is recommended after creation and again after many saves", async () => {
  const session = newSession(new FakeIdbFactory());
  await session.start();
  await session.create(PASSPHRASE);
  assert.equal(session.exportRecommended, true);

  const exported = JSON.parse(await session.exportEncrypted()) as EncryptedVaultData;
  assert.equal(exported.vaultVersion, 2);
  assert.ok(exported.recovery, "the export carries the recovery wrap");
  assert.equal(session.exportRecommended, true, "producing the export alone does not clear the reminder");
  session.markExported();
  assert.equal(session.exportRecommended, false);

  for (let i = 1; i < EXPORT_REMINDER_SAVE_COUNT; i++) await session.save();
  assert.equal(session.exportRecommended, false);
  await session.save();
  assert.equal(session.exportRecommended, true);
});

test("DomainService.saveCheckpoint stores resolution stage and a copy of unresolved keys", async () => {
  const vault = await VaultV2.open(idb(new FakeIdbFactory()), PASSPHRASE, "pbkdf2-sha512");
  const domain = new DomainService(vault);
  const keys = ["phone.full"];
  domain.saveCheckpoint({
    workflow: "visibility",
    siteAccountId: "acct-1",
    step: "collect",
    status: "handoff",
    resolutionStage: "tier2",
    unresolvedAttributeKeys: keys,
  });
  keys.push("email");
  const stored = domain.getCheckpoint("visibility", "acct-1");
  assert.equal(stored?.resolutionStage, "tier2");
  assert.deepEqual(stored?.unresolvedAttributeKeys, ["phone.full"]);
});

test("VaultSession: concurrent start() calls share one lock attempt and close() releases it", async () => {
  const factory = new FakeIdbFactory();
  const locks = new FakeLockManager();
  let attempts = 0;
  const counting: VaultLockManager = {
    tryAcquire: () => {
      attempts++;
      return locks.tryAcquire();
    },
  };
  const session = newSession(factory, counting);
  const [a, b] = await Promise.all([session.start(), session.start()]);
  assert.equal(a, "absent");
  assert.equal(b, "absent");
  assert.equal(attempts, 1);
  session.close();
  assert.equal(locks.held, false, "the only handle was released");
});

test("VaultSession: closing while the Web Lock is being acquired releases it", async () => {
  const locks = new FakeLockManager();
  const session = newSession(new FakeIdbFactory(), locks);
  const starting = session.start();
  session.close();
  await assert.rejects(starting, VaultSessionStateError);
  assert.equal(locks.held, false);
});

test("IndexedDB: a version change from another context drops the connection and the next call reopens", async () => {
  const factory = new FakeIdbFactory();
  const persistence = idb(factory);
  assert.equal(await persistence.load(), null);
  const first = factory.connections[0];
  assert.ok(first);
  first.onversionchange?.({});
  assert.equal(first.closed, true);
  const vault = await VaultV2.open(persistence, PASSPHRASE, "pbkdf2-sha512");
  await vault.save();
  assert.equal(factory.connections.length, 2, "reopened lazily");
  assert.equal(typeof factory.stored(), "string");
});

// --- Web Lock adapter ---

test("webLockManager holds the exclusive lock until release and reports a busy lock as null", async () => {
  const requests: Array<{ name: string; options: unknown }> = [];
  let held = false;
  const locks: WebLocksLike = {
    async request(name, options, callback) {
      requests.push({ name, options });
      if (held) return callback(null);
      held = true;
      try {
        return await callback({ name });
      } finally {
        held = false;
      }
    },
  };
  const manager = webLockManager(locks);
  const handle = await manager.tryAcquire();
  assert.ok(handle);
  assert.equal(await manager.tryAcquire(), null);
  handle.release();
  handle.release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(await manager.tryAcquire());
  assert.deepEqual(requests[0], { name: "soroeru-vault", options: { mode: "exclusive", ifAvailable: true } });
});

// --- Messages ---

test("side panel error messages never echo error text", async () => {
  const persistence = idb(new FakeIdbFactory());
  const vault = await VaultV2.open(persistence, PASSPHRASE, "pbkdf2-sha512");
  await vault.save();
  const wrong = await VaultV2.open(persistence, "wrong-passphrase-fake").catch((err: unknown) => err);
  assert.ok(wrong instanceof VaultUnlockError);
  assert.equal(vaultErrorMessage(wrong), "パスフレーズまたはリカバリーキーが正しくありません。");
  const noRecovery = await VaultV2.openWithRecoveryKey(persistence, "AAAA-BBBB").catch((err: unknown) => err);
  assert.ok(noRecovery instanceof VaultNoRecoveryKeyError);
  assert.match(vaultErrorMessage(noRecovery), /リカバリーキーが設定されていません/);
  // A record that fails AES-GCM (tampering) is not reported as merely a wrong passphrase.
  assert.match(vaultErrorMessage(new DOMException("fake", "OperationError")), /破損/);
  assert.match(vaultErrorMessage(new VaultCorruptError("fake-secret-detail")), /読み取れません/);
  assert.doesNotMatch(vaultErrorMessage(new Error("fake-secret-detail")), /fake-secret-detail/);
  assert.match(vaultErrorMessage(new PassphraseTooShortError()), /8文字以上/);
  const refused = importFailureMessage(
    new Error("refusing to overwrite an existing vault (pass { overwrite: true } to replace it)"),
  );
  assert.match(refused, /置き換えの確認がないため/);
  assert.doesNotMatch(refused, /overwrite|fake-secret-detail/);
  assert.match(
    importFailureMessage(new VaultFormatError("fake-secret-detail")),
    /Vault v2 として読み取れない/,
  );
  assert.doesNotMatch(
    importFailureMessage(new VaultCorruptError("fake-secret-detail")),
    /fake-secret-detail/,
  );
});

// --- Manifest / CSP / build ---

test("extension CSP allows WebAssembly for Argon2id but never unsafe-eval; Side Panel is declared", async () => {
  const manifest = JSON.parse(await readFile(join(REPO_ROOT, "extension", "manifest.json"), "utf8")) as {
    permissions: string[];
    side_panel?: { default_path?: string };
    content_security_policy?: { extension_pages?: string };
  };
  const csp = manifest.content_security_policy?.extension_pages ?? "";
  assert.match(csp, /script-src 'self' 'wasm-unsafe-eval'/);
  assert.doesNotMatch(csp, /'unsafe-eval'/);
  assert.doesNotMatch(csp, /https?:/, "no remote script origins");
  assert.equal(manifest.side_panel?.default_path, "sidepanel.html");
  assert.ok(manifest.permissions.includes("unlimitedStorage"));

  const html = await readFile(join(REPO_ROOT, "extension", "sidepanel.html"), "utf8");
  assert.match(html, /<script type="module" src="sidepanel\.js"><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="sidepanel\.css">/);
  assert.doesNotMatch(html, /<script>(?!<)/, "no inline scripts");
  const config = await readFile(join(REPO_ROOT, "extension", "vite.config.mjs"), "utf8");
  assert.match(config, /sidepanel\.tsx/);
  const pkg = JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.match(pkg.scripts["build:extension"] ?? "", /extension\/sidepanel\.html/);
});

test("Visibility host retains unlocked records when lock save fails and allows retry", async () => {
  const { VisibilityHost } = await import("../../extension/panel/visibility-host.js");
  const factory = new FakeIdbFactory();
  const session = newSession(factory);
  await session.start();
  await session.create(PASSPHRASE);
  session.vault.put("siteAccount", siteAccount("unsaved", "Fake unsaved site"));
  const host = new VisibilityHost({
    session,
    leaseClient: {
      onInvalidated: () => () => {},
      releaseLease: async () => {},
      close: () => {},
    } as unknown as import("../../extension/panel/lease-client.js").LeaseClient,
  });
  factory.nextCommitFailure = new DOMException("fake quota", "QuotaExceededError");
  await assert.rejects(() => host.lock(), VaultStorageQuotaError);
  assert.equal(session.state, "unlocked");
  assert.equal(session.vault.get("siteAccount", "unsaved")?.displayName, "Fake unsaved site");
  assert.ok((await session.exportEncrypted()).includes("ciphertext"));
  await host.lock();
  assert.equal(session.state, "locked");
  await session.unlock(PASSPHRASE);
  assert.equal(session.vault.get("siteAccount", "unsaved")?.displayName, "Fake unsaved site");
  await host.shutdown();
});

test("panel shutdown drops plaintext immediately and holds the writer lock until its full snapshot is stored", async () => {
  const { VisibilityHost } = await import("../../extension/panel/visibility-host.js");
  const factory = new FakeIdbFactory();
  const locks = new FakeLockManager();
  const persistence = idb(factory);
  const session = new VaultSession({ persistence, lockManager: locks, kdfAlgo: "pbkdf2-sha512" });
  await session.start();
  await session.create(PASSPHRASE);
  for (let i = 0; i < 3; i++) session.vault.put("siteAccount", siteAccount(`site-${i}`, `Fake ${i}`));
  let entered!: () => void;
  let release!: () => void;
  const storing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const originalSave = persistence.save.bind(persistence);
  persistence.save = async (data) => {
    entered();
    await blocked;
    await originalSave(data);
  };
  const host = new VisibilityHost({
    session,
    leaseClient: {
      onInvalidated: () => () => {},
      releaseLease: async () => {},
      close: () => {},
    } as unknown as import("../../extension/panel/lease-client.js").LeaseClient,
  });
  const closing = host.shutdown();
  try {
    assert.throws(() => session.vault, VaultLockedError);
    await storing;
    assert.equal(locks.held, true);
    release();
    await closing;
    assert.equal(locks.held, false);
    assert.equal(session.state, "closed");
    const next = newSession(factory, locks);
    await next.start();
    await next.unlock(PASSPHRASE);
    assert.equal(next.vault.list("siteAccount").length, 3);
    next.close();
  } finally {
    release();
    await closing;
  }
});

test("overlapping vault saves retain call order and newest records", async () => {
  const factory = new FakeIdbFactory();
  const persistence = idb(factory);
  const vault = await VaultV2.open(persistence, PASSPHRASE, "pbkdf2-sha512");
  let entered!: () => void;
  let release!: () => void;
  const storing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const originalSave = persistence.save.bind(persistence);
  let writes = 0;
  persistence.save = async (data) => {
    if (writes++ === 0) {
      entered();
      await blocked;
    }
    await originalSave(data);
  };
  vault.put("siteAccount", siteAccount("first", "Fake first"));
  const first = vault.save();
  await storing;
  vault.put("siteAccount", siteAccount("second", "Fake second"));
  const second = vault.save();
  try {
    await Promise.resolve();
    assert.equal(writes, 1);
    release();
    await Promise.all([first, second]);
    const reopened = await VaultV2.open(persistence, PASSPHRASE);
    assert.equal(reopened.list("siteAccount").length, 2);
    reopened.lock();
  } finally {
    release();
    await Promise.all([first, second]);
    vault.lock();
  }
});

for (const algo of ["argon2id", "pbkdf2-sha512"]) {
  test(`Electron ${algo} export restores into a separate browser profile with recovery`, async () => {
    const fixture = JSON.parse(
      await readFile(join(REPO_ROOT, "tests", "fixtures", "vault-v2", `legacy-${algo}.json`), "utf8"),
    ) as { vault: EncryptedVaultData; fakeRecoveryKey: string };
    const exported = JSON.stringify(fixture.vault);
    const session = newSession(new FakeIdbFactory());
    try {
      await session.start();
      await session.importEncrypted(exported, FIXTURE_PASSPHRASE);
      assert.equal(session.state, "locked");
      await session.unlock(FIXTURE_PASSPHRASE);
      assert.ok(session.vault.list("personalAttribute").length > 0);
      session.lock();
      await session.unlockWithRecoveryKey(fixture.fakeRecoveryKey);
      assert.equal(session.vault.get("siteAccount", "acct-fixture")?.domain, "shop.example.test");
    } finally {
      session.close();
    }
  });
}

test("failed imports and unconfirmed replacement preserve existing browser ciphertext", async () => {
  const factory = new FakeIdbFactory();
  const session = newSession(factory);
  try {
    await session.start();
    await session.create(PASSPHRASE);
    session.vault.put("siteAccount", siteAccount("original", "Fake original"));
    await session.save();
    const exported = await session.exportEncrypted();
    session.lock();
    const before = await idb(factory).load();
    await assert.rejects(() => session.importEncrypted(exported, PASSPHRASE));
    const data = JSON.parse(exported) as EncryptedVaultData;
    for (const version of [0, 1, 3, "2"]) {
      await assert.rejects(
        () => session.importEncrypted(JSON.stringify({ ...data, vaultVersion: version }), PASSPHRASE, true),
        VaultFormatError,
      );
    }
    for (const schemaVersion of [undefined, 0, RECORD_SCHEMA_VERSIONS.siteAccount + 1]) {
      const invalid = structuredClone(data);
      invalid.records[0]!.schemaVersion = schemaVersion as number;
      await assert.rejects(
        () => session.importEncrypted(JSON.stringify(invalid), PASSPHRASE, true),
        VaultFormatError,
      );
    }
    const futureRecord = structuredClone(data);
    futureRecord.records[0]!.schemaVersion = RECORD_SCHEMA_VERSIONS.siteAccount + 1;
    await assert.rejects(
      () => session.importEncrypted(JSON.stringify(futureRecord), PASSPHRASE, true),
      VaultFormatError,
    );
    await assert.rejects(
      () =>
        session.importEncrypted(
          JSON.stringify({ version: 1, kdf: data.kdf, records: data.records }),
          PASSPHRASE,
          true,
        ),
      VaultFormatError,
    );
    await assert.rejects(() => session.importEncrypted("{broken", PASSPHRASE, true));
    await assert.rejects(() => session.importEncrypted(exported, "fake-wrong-passphrase", true));
    data.records[0]!.ciphertext = "broken";
    await assert.rejects(() => session.importEncrypted(JSON.stringify(data), PASSPHRASE, true));
    factory.nextCommitFailure = new DOMException("fake quota", "QuotaExceededError");
    await assert.rejects(() => session.importEncrypted(exported, PASSPHRASE, true), VaultStorageQuotaError);
    assert.deepEqual(await idb(factory).load(), before);
    assert.equal(session.state, "locked");
    await session.importEncrypted(exported, PASSPHRASE, true);
    await session.unlock(PASSPHRASE);
    assert.equal(session.vault.get("siteAccount", "original")?.displayName, "Fake original");
    await assert.rejects(() => session.importEncrypted(exported, PASSPHRASE, true), VaultSessionStateError);
  } finally {
    session.close();
  }
});

test("closing during import authentication prevents replacement", async () => {
  const factory = new FakeIdbFactory();
  const source = await VaultV2.open(idb(new FakeIdbFactory()), PASSPHRASE, "pbkdf2-sha512");
  const exported = await source.exportEncrypted();
  source.lock();
  const session = newSession(factory);
  await session.start();
  const importing = session.importEncrypted(exported, PASSPHRASE);
  session.close();
  await assert.rejects(() => importing, VaultSessionStateError);
  assert.equal(await idb(factory).load(), null);
  assert.equal(session.state, "closed");
});

test("import is refused when this profile does not hold the vault lock", async () => {
  const session = newSession(new FakeIdbFactory(), { tryAcquire: async () => null });
  assert.equal(await session.start(), "in-use-elsewhere");
  await assert.rejects(() => session.importEncrypted("{}", PASSPHRASE), VaultSessionStateError);
  assert.equal(session.state, "in-use-elsewhere");
});

test("confirmed import replaces unreadable IndexedDB bytes and leaves the session locked", async () => {
  const clean = new FakeIdbFactory();
  const source = newSession(clean);
  await source.start();
  await source.create(PASSPHRASE);
  source.vault.put("siteAccount", siteAccount("restored", "Restored fake"));
  await source.save();
  const exported = await source.exportEncrypted();
  source.close();

  const factory = new FakeIdbFactory();
  factory.setStored("{not json");
  const session = newSession(factory);
  await assert.rejects(session.start(), VaultCorruptError);
  assert.equal(session.state, "locked");
  await assert.rejects(() => session.importEncrypted(exported, PASSPHRASE));
  assert.equal(factory.stored(), "{not json");
  await session.importEncrypted(exported, PASSPHRASE, true);
  assert.equal(session.state, "locked");
  assert.throws(() => session.vault, VaultLockedError);
  await session.unlock(PASSPHRASE);
  assert.equal(session.vault.get("siteAccount", "restored")?.displayName, "Restored fake");
  session.close();
});

test("a Vault v2 file written by the file backend imports into IndexedDB", async () => {
  const dir = await mkdtemp(join(tmpdir(), "soroeru-vault-transfer-"));
  const path = join(dir, "vault.json");
  try {
    const fileVault = await VaultV2.open(new FileVaultPersistence(path), PASSPHRASE, "pbkdf2-sha512");
    fileVault.put("siteAccount", siteAccount("from-file", "Fake file account"));
    await fileVault.save();
    const exported = await readFile(path, "utf8");
    fileVault.lock();
    assert.match(exported, /"vaultVersion":2/);
    assert.doesNotMatch(exported, /Fake file account/);

    const session = newSession(new FakeIdbFactory());
    await session.start();
    await session.importEncrypted(exported, PASSPHRASE);
    await session.unlock(PASSPHRASE);
    assert.equal(session.vault.get("siteAccount", "from-file")?.displayName, "Fake file account");
    session.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

for (const recovery of [false, true]) {
  test(`confirmed import supersedes an overlapping ${recovery ? "recovery" : "passphrase"} unlock`, async () => {
    const factory = new FakeIdbFactory();
    const persistence = idb(factory);
    const source = await VaultV2.open(persistence, PASSPHRASE, "pbkdf2-sha512");
    const recoveryKey = await source.setupRecoveryKey(PASSPHRASE);
    source.put("siteAccount", siteAccount("old", "Fake old"));
    await source.save();
    const replacement = await VaultV2.open(idb(new FakeIdbFactory()), PASSPHRASE, "pbkdf2-sha512");
    replacement.put("siteAccount", siteAccount("imported", "Fake imported"));
    const exported = await replacement.exportEncrypted();
    const session = new VaultSession({ persistence, lockManager: new FakeLockManager() });
    await session.start();
    let entered!: () => void;
    let release!: () => void;
    const loaded = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const load = persistence.load.bind(persistence);
    let first = true;
    persistence.load = async () => {
      const data = await load();
      if (first) {
        first = false;
        entered();
        await blocked;
      }
      return data;
    };
    const unlocking = recovery ? session.unlockWithRecoveryKey(recoveryKey) : session.unlock(PASSPHRASE);
    const rejected = assert.rejects(unlocking, VaultSessionStateError);
    await loaded;
    const importing = session.importEncrypted(exported, PASSPHRASE, true);
    release();
    await Promise.all([rejected, importing]);
    assert.deepEqual(await load(), JSON.parse(exported));
    assert.equal(session.state, "locked");
    assert.throws(() => session.vault, VaultLockedError);
    session.close();
    assert.deepEqual(await load(), JSON.parse(exported));
    source.lock();
    replacement.lock();
  });
}

test("import preserves and opens a supported schema 1 workflow checkpoint", async () => {
  const persistence = idb(new FakeIdbFactory());
  const source = await VaultV2.open(persistence, PASSPHRASE, "pbkdf2-sha512");
  source.put("workflowCheckpoint", {
    id: "visibility:fake",
    workflow: "visibility",
    siteAccountId: "fake",
    step: "collect",
    status: "handoff",
    updatedAt: 1,
  });
  const document = JSON.parse(await source.exportEncrypted()) as EncryptedVaultData;
  document.records[0]!.schemaVersion = 1;
  const factory = new FakeIdbFactory();
  const session = newSession(factory);
  await session.start();
  await session.importEncrypted(JSON.stringify(document), PASSPHRASE);
  assert.deepEqual(await idb(factory).load(), document);
  await session.unlock(PASSPHRASE);
  assert.equal(session.vault.get("workflowCheckpoint", "visibility:fake")?.step, "collect");
  session.close();
  source.lock();
});
