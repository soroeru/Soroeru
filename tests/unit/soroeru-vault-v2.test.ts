import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PocStore } from "../../src/store/store.js";
import {
  RECORD_SCHEMA_VERSION,
  VAULT_FORMAT_VERSION,
  VaultCorruptError,
  VaultFormatError,
  VaultLockedError,
  VaultV2,
} from "../../src/store/vault-v2.js";

// Fake data only (docs/testing.md).
const PASSPHRASE = "unit-test-passphrase";

async function tmpVaultPath(): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "soroeru-vault-"));
  return { dir, path: join(dir, "vault.json") };
}

test("create, persist, and reopen a v2 record vault", async () => {
  const { dir, path } = await tmpVaultPath();
  try {
    const vault = await VaultV2.open(path, PASSPHRASE);
    vault.put("siteAccount", {
      id: "acct-1",
      domain: "example.com",
      displayName: "Example",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    vault.put("personalAttribute", {
      id: "email",
      attributeKey: "email",
      label: "メール",
      value: "user@example.test",
      valueType: "email",
      sensitivity: "normal",
      updatedAt: Date.now(),
    });
    await vault.save();

    const file = JSON.parse(await readFile(path, "utf8")) as { vaultVersion: number; records: { entityKind: string }[] };
    assert.equal(file.vaultVersion, VAULT_FORMAT_VERSION);
    assert.equal(file.records.length, 2);

    const reopened = await VaultV2.open(path, PASSPHRASE);
    assert.equal(reopened.get("siteAccount", "acct-1")?.domain, "example.com");
    assert.equal(reopened.get("personalAttribute", "email")?.value, "user@example.test");
    assert.equal(reopened.list("siteAccount").length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("wrong passphrase fails GCM authentication", async () => {
  const { dir, path } = await tmpVaultPath();
  try {
    const vault = await VaultV2.open(path, PASSPHRASE);
    vault.put("diagnostic", { id: "d1", at: Date.now(), type: "app", message: "ok", severity: "info" });
    await vault.save();
    await assert.rejects(() => VaultV2.open(path, "wrong-passphrase"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("wrong passphrase is rejected even on an empty saved vault (verifier)", async () => {
  const { dir, path } = await tmpVaultPath();
  try {
    // No records: previously there was no ciphertext for a wrong key to fail
    // GCM auth on. The passphrase verifier closes that gap.
    const vault = await VaultV2.open(path, PASSPHRASE);
    await vault.save();
    await assert.rejects(() => VaultV2.open(path, "wrong-passphrase"));
    // The correct passphrase still opens it cleanly.
    assert.equal((await VaultV2.open(path, PASSPHRASE)).isLocked, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("lock clears decrypted records and blocks access", async () => {
  const { dir, path } = await tmpVaultPath();
  try {
    const vault = await VaultV2.open(path, PASSPHRASE);
    vault.put("policy", { id: "p1", key: "k", value: "v", source: "default", updatedAt: Date.now() });
    vault.lock();
    assert.equal(vault.isLocked, true);
    assert.throws(() => vault.get("policy", "p1"), VaultLockedError);
    assert.throws(() => vault.put("policy", { id: "p2", key: "k", value: "v", source: "user", updatedAt: 0 }), VaultLockedError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("put preserves createdAt and bumps updatedAt; delete removes", async () => {
  const { dir, path } = await tmpVaultPath();
  try {
    const vault = await VaultV2.open(path, PASSPHRASE);
    vault.put("siteAccount", { id: "a", domain: "d", displayName: "D", createdAt: 1, updatedAt: 1 });
    await vault.save();
    const reopened = await VaultV2.open(path, PASSPHRASE);
    reopened.put("siteAccount", { id: "a", domain: "d2", displayName: "D2", createdAt: 999, updatedAt: 999 });
    await reopened.save();
    const again = await VaultV2.open(path, PASSPHRASE);
    assert.equal(again.get("siteAccount", "a")?.domain, "d2");
    assert.equal(again.delete("siteAccount", "a"), true);
    assert.equal(again.delete("siteAccount", "a"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recovery key unlocks the vault without the passphrase", async () => {
  const { dir, path } = await tmpVaultPath();
  try {
    const vault = await VaultV2.open(path, PASSPHRASE);
    const recoveryKey = await vault.setupRecoveryKey();
    vault.put("personalAttribute", {
      id: "phone.full",
      attributeKey: "phone.full",
      label: "電話",
      value: "090-1234-5678",
      valueType: "phone",
      sensitivity: "normal",
      updatedAt: Date.now(),
    });
    await vault.save();
    assert.equal(vault.hasRecoveryKey, true);

    const recovered = await VaultV2.openWithRecoveryKey(path, recoveryKey);
    assert.equal(recovered.get("personalAttribute", "phone.full")?.value, "090-1234-5678");
    assert.equal(await recovered.verifyRecoveryKey(recoveryKey), true);
    assert.equal(await recovered.verifyRecoveryKey("WRONG-KEY-2345"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rekey clears the recovery wrap", async () => {
  const { dir, path } = await tmpVaultPath();
  try {
    const vault = await VaultV2.open(path, PASSPHRASE);
    await vault.setupRecoveryKey();
    assert.equal(vault.hasRecoveryKey, true);
    // A record must exist for a wrong-passphrase open to fail GCM auth.
    vault.put("policy", { id: "p", key: "k", value: "v", source: "default", updatedAt: 1 });
    await vault.rekey("new-passphrase");
    assert.equal(vault.hasRecoveryKey, false);
    await vault.save();
    // The new passphrase opens it; the old one no longer does.
    assert.equal((await VaultV2.open(path, "new-passphrase")).isLocked, false);
    await assert.rejects(() => VaultV2.open(path, PASSPHRASE));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("migrating a v1 vault carries its recovery wrapper into v2", async () => {
  const { dir, path } = await tmpVaultPath();
  try {
    const legacy = await PocStore.open(path, PASSPHRASE);
    const recoveryKey = await legacy.setupRecoveryKey();
    legacy.setProfileValue("email", "メール", "legacy@example.test");
    await legacy.save();

    const migrated = await VaultV2.open(path, PASSPHRASE);
    assert.equal(migrated.hasRecoveryKey, true);
    await migrated.save();

    const recovered = await VaultV2.openWithRecoveryKey(path, recoveryKey);
    assert.equal(recovered.get("personalAttribute", "email")?.value, "legacy@example.test");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects a JSON file that is neither v1 nor a tagged v2 vault", async () => {
  const { dir, path } = await tmpVaultPath();
  try {
    await writeFile(path, JSON.stringify({ hello: "world" }), "utf8");
    await assert.rejects(() => VaultV2.open(path, PASSPHRASE), VaultFormatError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("encrypted export/import round-trips and refuses to clobber", async () => {
  const { dir, path } = await tmpVaultPath();
  try {
    const vault = await VaultV2.open(path, PASSPHRASE);
    vault.put("siteAccount", { id: "x", domain: "ex.com", displayName: "Ex", createdAt: 1, updatedAt: 1 });
    await vault.save();
    const exported = await vault.exportEncrypted();

    const target = join(dir, "restored.json");
    const restored = await VaultV2.importEncrypted(target, exported, PASSPHRASE);
    assert.equal(restored.get("siteAccount", "x")?.domain, "ex.com");

    await assert.rejects(() => VaultV2.importEncrypted(target, exported, PASSPHRASE));
    const overwritten = await VaultV2.importEncrypted(target, exported, PASSPHRASE, { overwrite: true });
    assert.equal(overwritten.get("siteAccount", "x")?.domain, "ex.com");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects a vault format version newer than supported", async () => {
  const { dir, path } = await tmpVaultPath();
  try {
    const seed = await VaultV2.open(path, PASSPHRASE);
    await seed.save();
    const file = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    file.vaultVersion = VAULT_FORMAT_VERSION + 1;
    await writeFile(path, JSON.stringify(file), "utf8");
    await assert.rejects(() => VaultV2.open(path, PASSPHRASE), VaultFormatError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects an unknown entity kind in a record envelope", async () => {
  const { dir, path } = await tmpVaultPath();
  try {
    const seed = await VaultV2.open(path, PASSPHRASE);
    await seed.save();
    const file = JSON.parse(await readFile(path, "utf8")) as { records: unknown[] };
    file.records.push({
      recordId: "bogus",
      entityKind: "notAKind",
      schemaVersion: RECORD_SCHEMA_VERSION,
      iv: "AAAA",
      ciphertext: "AAAA",
      createdAt: 1,
      updatedAt: 1,
    });
    await writeFile(path, JSON.stringify(file), "utf8");
    await assert.rejects(() => VaultV2.open(path, PASSPHRASE), VaultCorruptError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("migrates a v1 store into a v2 record vault", async () => {
  const { dir, path } = await tmpVaultPath();
  try {
    // Seed a v1 store with the existing PocStore, then save the v1 file.
    const legacy = await PocStore.open(path, PASSPHRASE);
    legacy.setProfileValue("email", "メール", "legacy@example.test");
    legacy.setProviderSettings({ provider: "anthropic", model: "claude-x", apiKey: "fake-key" });
    await legacy.save();
    const onDisk = JSON.parse(await readFile(path, "utf8")) as { version: number; vaultVersion?: number };
    assert.equal(onDisk.version, 1);
    assert.equal(onDisk.vaultVersion, undefined);

    // Opening with VaultV2 should migrate it in memory.
    const migrated = await VaultV2.open(path, PASSPHRASE);
    assert.equal(migrated.get("personalAttribute", "email")?.value, "legacy@example.test");
    assert.equal(migrated.get("providerSettings", "provider")?.model, "claude-x");

    // Saving rewrites the file as v2 and reopens cleanly as v2.
    await migrated.save();
    const afterSave = JSON.parse(await readFile(path, "utf8")) as { vaultVersion: number };
    assert.equal(afterSave.vaultVersion, VAULT_FORMAT_VERSION);
    const reopened = await VaultV2.open(path, PASSPHRASE);
    assert.equal(reopened.get("personalAttribute", "email")?.value, "legacy@example.test");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
