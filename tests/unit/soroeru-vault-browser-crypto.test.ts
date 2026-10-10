// Issue #556 (design #554 §6.1–§6.2): the vault and its crypto run on
// `globalThis.crypto` + `hash-wasm` only, behind an injected `VaultPersistence`,
// and still decrypt vaults written by the earlier node:crypto/Buffer code.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decryptRecord, deriveKey, encryptRecord, newKdfParams } from "../../src/store/crypto.js";
import { webCryptoRuntime, type CryptoRuntime } from "../../src/store/crypto-runtime.js";
import { base64ToBytes, bytesEqual, bytesToBase64 } from "../../src/store/encoding.js";
import { FileVaultPersistence } from "../../src/store/file-vault-persistence.js";
import {
  VaultCorruptError,
  VaultFormatError,
  VaultV2,
  type EncryptedVaultData,
  type VaultPersistence,
} from "../../src/store/vault-v2.js";

// dist/compiled/tests/unit/<this file> -> repo root is four levels up.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

test("REPO_ROOT resolves to the repository root (compiled test layout)", async () => {
  await stat(join(REPO_ROOT, "package.json"));
  await stat(join(REPO_ROOT, "src", "store", "vault-v2.ts"));
});

// Fake data only (docs/testing.md).
const FIXTURE_PASSPHRASE = "fixture-passphrase-fake";
const PASSPHRASE = "unit-test-passphrase";

/** In-memory backend: proves VaultV2 needs no file system. Stores a JSON copy like a real backend. */
class MemoryVaultPersistence implements VaultPersistence {
  saves = 0;
  constructor(public stored: string | null = null) {}
  async load(): Promise<EncryptedVaultData | null> {
    return this.stored === null ? null : (JSON.parse(this.stored) as EncryptedVaultData);
  }
  async save(data: EncryptedVaultData): Promise<void> {
    this.saves++;
    this.stored = JSON.stringify(data);
  }
  async clear(): Promise<void> {
    this.stored = null;
  }
}

interface LegacyFixture {
  fakeRecoveryKey: string;
  vault: EncryptedVaultData;
}

async function loadFixture(name: string): Promise<LegacyFixture> {
  const text = await readFile(join(REPO_ROOT, "tests", "fixtures", "vault-v2", name), "utf8");
  return JSON.parse(text) as LegacyFixture;
}

for (const name of ["legacy-argon2id.json", "legacy-pbkdf2-sha512.json"]) {
  test(`decrypts a Vault v2 fixture written by the Node implementation (${name})`, async () => {
    const fixture = await loadFixture(name);
    const persistence = new MemoryVaultPersistence(JSON.stringify(fixture.vault));

    const vault = await VaultV2.open(persistence, FIXTURE_PASSPHRASE);
    assert.equal(vault.get("personalAttribute", "email")?.value, "taro.fixture@example.test");
    assert.equal(vault.get("siteAccount", "acct-fixture")?.displayName, "Fixture Shop 🛒");
    assert.equal(vault.hasRecoveryKey, true);
    assert.equal(await vault.verifyPassphrase(FIXTURE_PASSPHRASE), true);
    assert.equal(await vault.verifyPassphrase("wrong-passphrase-fake"), false);
    assert.equal(await vault.verifyRecoveryKey(fixture.fakeRecoveryKey), true);

    const recovered = await VaultV2.openWithRecoveryKey(persistence, fixture.fakeRecoveryKey);
    assert.equal(recovered.get("personalAttribute", "email")?.value, "taro.fixture@example.test");

    // Re-saving with the new implementation keeps the format readable both ways.
    await vault.save();
    const reopened = await VaultV2.open(persistence, FIXTURE_PASSPHRASE);
    assert.equal(reopened.get("siteAccount", "acct-fixture")?.domain, "shop.example.test");
    const saved = JSON.parse(persistence.stored ?? "null") as EncryptedVaultData;
    assert.deepEqual(saved.kdf, fixture.vault.kdf);
    assert.deepEqual(saved.recovery, fixture.vault.recovery);
  });
}

test("a legacy fixture rejects a wrong passphrase", async () => {
  const fixture = await loadFixture("legacy-pbkdf2-sha512.json");
  await assert.rejects(VaultV2.open(new MemoryVaultPersistence(JSON.stringify(fixture.vault)), "wrong-passphrase-fake"));
});

test("create, save, and reopen through an injected in-memory persistence", async () => {
  const persistence = new MemoryVaultPersistence();
  const vault = await VaultV2.open(persistence, PASSPHRASE, "pbkdf2-sha512");
  vault.put("siteAccount", {
    id: "acct-1",
    domain: "example.test",
    displayName: "Example",
    createdAt: 1,
    updatedAt: 1,
  });
  await vault.save();
  assert.equal(persistence.saves, 1);
  assert.doesNotMatch(persistence.stored ?? "", /Example/);

  const reopened = await VaultV2.open(persistence, PASSPHRASE);
  assert.equal(reopened.get("siteAccount", "acct-1")?.displayName, "Example");
});

test("fails closed on unreadable or tampered stored data", async () => {
  const fixture = await loadFixture("legacy-pbkdf2-sha512.json");

  class RawPersistence extends MemoryVaultPersistence {
    constructor(private readonly raw: unknown) {
      super();
    }
    override async load(): Promise<EncryptedVaultData | null> {
      return this.raw as EncryptedVaultData;
    }
  }
  for (const raw of [[], "vault", 42]) {
    await assert.rejects(VaultV2.open(new RawPersistence(raw), PASSPHRASE), VaultCorruptError);
  }
  await assert.rejects(VaultV2.open(new RawPersistence({ hello: "world" }), PASSPHRASE), VaultFormatError);
  await assert.rejects(
    VaultV2.open(new RawPersistence({ ...fixture.vault, records: undefined }), FIXTURE_PASSPHRASE),
    VaultFormatError,
  );

  const tampered = structuredClone(fixture.vault);
  const record = tampered.records[0];
  assert.ok(record);
  const ct = base64ToBytes(record.ciphertext);
  ct[0] = (ct[0] ?? 0) ^ 0xff;
  record.ciphertext = bytesToBase64(ct);
  await assert.rejects(VaultV2.open(new MemoryVaultPersistence(JSON.stringify(tampered)), FIXTURE_PASSPHRASE));

  const badBase64 = structuredClone(fixture.vault);
  const badRecord = badBase64.records[0];
  assert.ok(badRecord);
  badRecord.iv = "not base64!";
  await assert.rejects(VaultV2.open(new MemoryVaultPersistence(JSON.stringify(badBase64)), FIXTURE_PASSPHRASE));
});

test("openWithRecoveryKey fails closed on unrecognized, newer, or legacy v1 data", async () => {
  const fixture = await loadFixture("legacy-pbkdf2-sha512.json");
  const key = fixture.fakeRecoveryKey;
  const withData = (data: unknown) => new MemoryVaultPersistence(JSON.stringify(data));

  await assert.rejects(
    VaultV2.openWithRecoveryKey(withData({ ...fixture.vault, records: undefined }), key),
    VaultFormatError,
  );
  await assert.rejects(
    VaultV2.openWithRecoveryKey(withData({ ...fixture.vault, vaultVersion: 99 }), key),
    VaultFormatError,
  );
  // A v1 store carries a recovery wrap but no vaultVersion: it must be migrated via open(), not here.
  const v1 = { version: 1, kdf: fixture.vault.kdf, records: [], recovery: fixture.vault.recovery };
  await assert.rejects(VaultV2.openWithRecoveryKey(withData(v1), key), VaultFormatError);
});

test("FileVaultPersistence: corrupt JSON and unreadable paths fail closed without overwriting", async () => {
  const dir = await mkdtemp(join(tmpdir(), "soroeru-vault-file-"));
  try {
    const path = join(dir, "vault.json");
    await writeFile(path, "{not json");
    await assert.rejects(VaultV2.open(new FileVaultPersistence(path), PASSPHRASE), VaultCorruptError);
    await assert.rejects(
      VaultV2.importEncrypted(new FileVaultPersistence(path), JSON.stringify({ vaultVersion: 2, records: [] }), PASSPHRASE),
      /refusing to overwrite/,
    );
    assert.equal(await readFile(path, "utf8"), "{not json");

    // JSON `null` must not read as "no vault yet" (which would let save() overwrite it).
    for (const contents of ["null", "[]", "42"]) {
      await writeFile(path, contents);
      await assert.rejects(new FileVaultPersistence(path).load(), VaultCorruptError);
      await assert.rejects(VaultV2.open(new FileVaultPersistence(path), PASSPHRASE), VaultCorruptError);
      assert.equal(await readFile(path, "utf8"), contents);
    }

    // A path that exists but cannot be read as a file must not be treated as "no vault yet".
    const dirPath = join(dir, "is-a-directory");
    await mkdir(dirPath);
    await assert.rejects(VaultV2.open(new FileVaultPersistence(dirPath), PASSPHRASE));
    assert.equal((await stat(dirPath)).isDirectory(), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("FileVaultPersistence: save writes owner-only, load round-trips, clear removes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "soroeru-vault-file-"));
  try {
    const persistence = new FileVaultPersistence(join(dir, "nested", "vault.json"));
    assert.equal(await persistence.load(), null);
    const fixture = await loadFixture("legacy-pbkdf2-sha512.json");
    await persistence.save(fixture.vault);
    assert.deepEqual(await persistence.load(), fixture.vault);
    if (process.platform !== "win32") {
      assert.equal((await stat(persistence.filePath)).mode & 0o777, 0o600);
    }
    await persistence.clear();
    assert.equal(await persistence.load(), null);
    await persistence.clear(); // idempotent
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("base64 helpers match the previous Buffer encoding byte for byte", () => {
  for (const length of [0, 1, 2, 3, 12, 16, 32, 255, 70_000]) {
    // getRandomValues caps a single call at 65,536 bytes; a byte pattern covers the larger case.
    const bytes =
      length <= 65_536
        ? webCryptoRuntime.getRandomValues(new Uint8Array(length))
        : Uint8Array.from({ length }, (_, i) => (i * 31) & 0xff);
    const encoded = bytesToBase64(bytes);
    assert.equal(encoded, Buffer.from(bytes).toString("base64"));
    assert.deepEqual(base64ToBytes(encoded), new Uint8Array(bytes));
  }
  assert.throws(() => base64ToBytes("not base64!"));
  assert.throws(() => base64ToBytes("AQID BA=="), "whitespace is rejected");
  assert.throws(() => base64ToBytes("AQIDBA"), "missing padding is rejected");
  assert.equal(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2])), true);
  assert.equal(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3])), false);
  assert.equal(bytesEqual(new Uint8Array([1]), new Uint8Array([1, 0])), false);
});

test("crypto primitives draw randomness and SubtleCrypto from the injected runtime", async () => {
  let randomCalls = 0;
  let argonCalls = 0;
  const runtime: CryptoRuntime = {
    getRandomValues: (bytes) => {
      randomCalls++;
      return webCryptoRuntime.getRandomValues(bytes);
    },
    randomUUID: () => webCryptoRuntime.randomUUID(),
    subtle: webCryptoRuntime.subtle,
    argon2id: (params) => {
      argonCalls++;
      return webCryptoRuntime.argon2id(params);
    },
  };
  const params = newKdfParams("argon2id", runtime);
  assert.equal(base64ToBytes(params.salt).length, 16);
  const key = await deriveKey("fake-passphrase", params, runtime);
  assert.equal(argonCalls, 1);
  const record = await encryptRecord(key, "fake plaintext", runtime);
  assert.equal(base64ToBytes(record.iv).length, 12);
  assert.equal(randomCalls, 2);
  assert.equal(await decryptRecord(key, record, runtime), "fake plaintext");
});

// --- Static check: the portable vault code never imports node: or uses Buffer ---

/** Node-only modules allowed in src/store. Everything else there must be portable. */
const NODE_ONLY_STORE_MODULES = new Set([
  "atomic-write.ts", // file-backed persistence helper
  "file-vault-persistence.ts", // FileVaultPersistence (Electron, tests)
  "store.ts", // legacy v1 PoC store (Node CLI path)
  "vault.ts", // Electron vault path / existence helpers
]);

// Heuristic, deliberately strict: it may flag a harmless `process.` or `Buffer`
// token, and the comment stripper ignores string/template context. Both are
// acceptable for this small, reviewed set of files.
// Import/export-from lines are also checked on the raw source, so comment
// stripping can never hide a real `node:` import.
const RAW_NODE_IMPORT = /^\s*(?:import|export)\b[^\n]*["']node:/m;

const NODE_API = /\bfrom\s+["']node:|\bimport\(\s*["']node:|\brequire\(\s*["']node:|\bBuffer\b|\bprocess\./;

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1");
}

test("src/store: only the listed Node-only modules use node: imports or Buffer", async () => {
  const storeDir = join(REPO_ROOT, "src", "store");
  const offenders: string[] = [];
  for (const name of await readdir(storeDir)) {
    if (!name.endsWith(".ts") || NODE_ONLY_STORE_MODULES.has(name)) continue;
    const raw = await readFile(join(storeDir, name), "utf8");
    if (RAW_NODE_IMPORT.test(raw) || NODE_API.test(stripComments(raw))) offenders.push(name);
  }
  assert.deepEqual(offenders, []);
});

test("VaultV2 and everything it imports are free of node: imports and Buffer", async () => {
  const seen = new Set<string>();
  const offenders: string[] = [];
  const queue = [join(REPO_ROOT, "src", "store", "vault-v2.ts")];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const raw = await readFile(file, "utf8");
    const source = stripComments(raw);
    if (RAW_NODE_IMPORT.test(raw) || NODE_API.test(source)) offenders.push(file.slice(REPO_ROOT.length + 1));
    for (const match of source.matchAll(/\bfrom\s+["'](\.{1,2}\/[^"']+)\.js["']/g)) {
      queue.push(resolve(dirname(file), `${match[1]}.ts`));
    }
  }
  assert.ok(seen.size >= 5, "walked the vault import graph");
  assert.deepEqual(offenders, []);
});
