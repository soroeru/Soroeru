import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import {
  decryptRecord,
  deriveKey,
  encryptRecord,
  newKdfParams,
} from "../../poc/autofill-agent/src/store/crypto.js";
import { PocStore, StoreLockedError, STORE_FORMAT_VERSION } from "../../poc/autofill-agent/src/store/store.js";

// Fake data only (docs/testing.md).
const PASSPHRASE = "unit-test-passphrase";

test("argon2id + AES-256-GCM roundtrip", async () => {
  const params = newKdfParams("argon2id");
  const key = await deriveKey(PASSPHRASE, params);
  const record = await encryptRecord(key, "テストの平文 / dummy plaintext");
  assert.notEqual(record.ct, "");
  assert.equal(await decryptRecord(key, record), "テストの平文 / dummy plaintext");
});

test("pbkdf2-sha512 fallback roundtrip", async () => {
  const params = newKdfParams("pbkdf2-sha512");
  assert.ok(params.iterations >= 600_000);
  const key = await deriveKey(PASSPHRASE, params);
  const record = await encryptRecord(key, "fallback");
  assert.equal(await decryptRecord(key, record), "fallback");
});

test("each record gets a fresh random IV", async () => {
  const key = await deriveKey(PASSPHRASE, newKdfParams("argon2id"));
  const a = await encryptRecord(key, "same plaintext");
  const b = await encryptRecord(key, "same plaintext");
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ct, b.ct);
});

test("wrong passphrase fails GCM authentication", async () => {
  const params = newKdfParams("argon2id");
  const key = await deriveKey(PASSPHRASE, params);
  const record = await encryptRecord(key, "secret");
  const wrongKey = await deriveKey("wrong-passphrase", params);
  await assert.rejects(() => decryptRecord(wrongKey, record));
});

test("ciphertext tampering is detected", async () => {
  const key = await deriveKey(PASSPHRASE, newKdfParams("argon2id"));
  const record = await encryptRecord(key, "integrity");
  const tampered = Buffer.from(record.ct, "base64");
  tampered[0] = (tampered[0] ?? 0) ^ 0xff;
  await assert.rejects(() => decryptRecord(key, { iv: record.iv, ct: tampered.toString("base64") }));
});

test("store persists encrypted and reloads with the right passphrase", async () => {
  const dir = await mkdtemp(join(tmpdir(), "af-poc-store-"));
  const file = join(dir, "store.json");
  try {
    const store = await PocStore.open(file, PASSPHRASE, "pbkdf2-sha512");
    store.setProfileValue("email", "メールアドレス", "dummy@example.com");
    await store.save();

    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(file, "utf8");
    assert.ok(!raw.includes("dummy@example.com"), "plaintext must never reach disk");

    const reopened = await PocStore.open(file, PASSPHRASE);
    assert.equal(reopened.getValue("email"), "dummy@example.com");

    await assert.rejects(() => PocStore.open(file, "wrong-passphrase"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("provider settings (incl. API key) persist encrypted and reload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "af-poc-store-"));
  const file = join(dir, "store.json");
  try {
    const store = await PocStore.open(file, PASSPHRASE, "pbkdf2-sha512");
    store.setProviderSettings({ provider: "anthropic", model: "claude-test", apiKey: "sk-fake-test-key" });
    await store.save();

    const raw = await readFile(file, "utf8");
    assert.ok(!raw.includes("sk-fake-test-key"), "API key must never reach disk as plaintext");

    const reopened = await PocStore.open(file, PASSPHRASE);
    assert.deepEqual(reopened.getSettings(), {
      provider: "anthropic",
      model: "claude-test",
      apiKey: "sk-fake-test-key",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("profileView excludes the most-sensitive field but getValueForFill reads it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "af-poc-store-"));
  const file = join(dir, "store.json");
  try {
    const store = await PocStore.open(file, PASSPHRASE, "pbkdf2-sha512");
    store.setProfileValue("email", "メール", "dummy@example.com");
    store.setProfileValue("card.cvv", "セキュリティコード", "123");

    const view = store.profileView();
    assert.equal(view.get("email"), "dummy@example.com");
    assert.equal(view.has("card.cvv"), false, "CVV must not appear in the shared transform view");
    assert.equal(store.getValueForFill("card.cvv"), "123");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("lock clears in-memory secrets and blocks further access", async () => {
  const dir = await mkdtemp(join(tmpdir(), "af-poc-store-"));
  const file = join(dir, "store.json");
  try {
    const store = await PocStore.open(file, PASSPHRASE, "pbkdf2-sha512");
    store.setProfileValue("email", "メール", "dummy@example.com");
    store.lock();
    assert.equal(store.isLocked, true);
    assert.equal(store.profile.size, 0);
    assert.throws(() => store.getValue("email"), StoreLockedError);
    await assert.rejects(() => store.save(), StoreLockedError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("opening a newer store format version is rejected, not mis-read", async () => {
  const dir = await mkdtemp(join(tmpdir(), "af-poc-store-"));
  const file = join(dir, "store.json");
  try {
    const store = await PocStore.open(file, PASSPHRASE, "pbkdf2-sha512");
    await store.save();
    const parsed = JSON.parse(await readFile(file, "utf8")) as { version: number };
    parsed.version = STORE_FORMAT_VERSION + 1;
    await writeFile(file, JSON.stringify(parsed), "utf8");

    await assert.rejects(() => PocStore.open(file, PASSPHRASE), /newer than supported/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
