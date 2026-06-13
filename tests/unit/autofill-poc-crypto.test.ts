import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decryptRecord,
  deriveKey,
  encryptRecord,
  newKdfParams,
} from "../../poc/autofill-agent/src/store/crypto.js";
import { PocStore } from "../../poc/autofill-agent/src/store/store.js";

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
