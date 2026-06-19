// Recovery key + encrypted export/import (RFC-001 v3 §9, SEC-003 / #44).
// Fake data only (docs/testing.md).

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeRecoveryKey } from "../../src/store/recovery.js";
import { PocStore } from "../../src/store/store.js";

const PASSPHRASE = "unit-test-passphrase";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "af-poc-recovery-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("recovery key roundtrip: setupRecoveryKey -> save -> openWithRecoveryKey", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "store.json");
    const store = await PocStore.open(file, PASSPHRASE, "pbkdf2-sha512");
    store.setProfileValue("email", "メール", "dummy@example.com");
    const recoveryKey = await store.setupRecoveryKey();
    assert.match(recoveryKey, /^([A-Z2-7]{4}-){12}[A-Z2-7]{4}$/);
    await store.save();

    const reopened = await PocStore.openWithRecoveryKey(file, recoveryKey);
    assert.equal(reopened.getValue("email"), "dummy@example.com");
    assert.equal(reopened.hasRecoveryKey, true);
  });
});

test("normalizeRecoveryKey ignores hyphens, whitespace, and case", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "store.json");
    const store = await PocStore.open(file, PASSPHRASE, "pbkdf2-sha512");
    store.setProfileValue("email", "メール", "dummy@example.com");
    const recoveryKey = await store.setupRecoveryKey();
    await store.save();

    const messy = ` ${recoveryKey.toLowerCase().split("-").join(" ")} `;
    assert.equal(normalizeRecoveryKey(messy), normalizeRecoveryKey(recoveryKey));

    const reopened = await PocStore.openWithRecoveryKey(file, messy);
    assert.equal(reopened.getValue("email"), "dummy@example.com");
  });
});

test("openWithRecoveryKey rejects a wrong recovery key", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "store.json");
    const store = await PocStore.open(file, PASSPHRASE, "pbkdf2-sha512");
    await store.setupRecoveryKey();
    await store.save();

    await assert.rejects(() => PocStore.openWithRecoveryKey(file, "WRONG-WRONG-WRONG-WRONG-WRONG-WRONG-WRONG-WRONG"));
  });
});

test("openWithRecoveryKey rejects when no recovery key is configured", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "store.json");
    const store = await PocStore.open(file, PASSPHRASE, "pbkdf2-sha512");
    await store.save();

    await assert.rejects(() => PocStore.openWithRecoveryKey(file, "AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA"));
  });
});

test("verifyRecoveryKey returns true for the configured key and false otherwise", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "store.json");
    const store = await PocStore.open(file, PASSPHRASE, "pbkdf2-sha512");
    assert.equal(await store.verifyRecoveryKey("anything"), false, "no recovery key configured yet");

    const recoveryKey = await store.setupRecoveryKey();
    assert.equal(await store.verifyRecoveryKey(recoveryKey), true);
    assert.equal(await store.verifyRecoveryKey("WRONG-WRONG-WRONG-WRONG-WRONG-WRONG-WRONG-WRONG"), false);
  });
});

test("removeRecoveryKey clears hasRecoveryKey and the persisted wrap", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "store.json");
    const store = await PocStore.open(file, PASSPHRASE, "pbkdf2-sha512");
    const recoveryKey = await store.setupRecoveryKey();
    await store.save();

    store.removeRecoveryKey();
    assert.equal(store.hasRecoveryKey, false);
    await store.save();

    await assert.rejects(() => PocStore.openWithRecoveryKey(file, recoveryKey));
    const reopened = await PocStore.open(file, PASSPHRASE);
    assert.equal(reopened.hasRecoveryKey, false);
  });
});

test("rekey changes the passphrase and invalidates any existing recovery wrap", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "store.json");
    const store = await PocStore.open(file, PASSPHRASE, "pbkdf2-sha512");
    store.setProfileValue("email", "メール", "dummy@example.com");
    const oldRecoveryKey = await store.setupRecoveryKey();
    await store.save();

    await store.rekey("new-unit-test-passphrase");
    assert.equal(store.hasRecoveryKey, false);
    await store.save();

    await assert.rejects(() => PocStore.open(file, PASSPHRASE), "old passphrase must no longer work");
    await assert.rejects(() => PocStore.openWithRecoveryKey(file, oldRecoveryKey), "old recovery key wraps the old key");

    const reopened = await PocStore.open(file, "new-unit-test-passphrase");
    assert.equal(reopened.getValue("email"), "dummy@example.com");
    assert.equal(reopened.hasRecoveryKey, false);
  });
});

test("exportEncrypted/importEncrypted roundtrip restores profile, site records, and mandates", async () => {
  await withTempDir(async (dir) => {
    const srcFile = join(dir, "store.json");
    const store = await PocStore.open(srcFile, PASSPHRASE, "pbkdf2-sha512");
    store.setProfileValue("email", "メール", "dummy@example.com");
    store.setProfileValue("card.cvv", "セキュリティコード", "123");
    store.upsertSiteRecord({
      origin: "https://example.test",
      siteId: "example-test",
      serviceName: "Example",
      registeredAt: 1,
      filledFields: [],
      accountState: "registered",
      status: "registered",
      lastCheckedAt: 1,
      nextAction: "reviewInventory",
    });
    store.addMandate({
      origin: "https://example.test",
      authorizedAt: 1,
      submittedFieldKeys: ["email"],
      highRiskFlags: [],
      attestationsApproved: [],
      result: "registered",
    });
    await store.setupRecoveryKey();
    await store.save();

    const exported = await store.exportEncrypted();
    assert.ok(!exported.includes("dummy@example.com"), "export must not contain plaintext profile values");
    // '"' is not a base64 character, so '"value":"123"' cannot appear in encrypted output
    assert.ok(!exported.includes('"value":"123"'), "export must not contain plaintext CVV");

    const parsed = JSON.parse(exported) as { version: number; kdf: unknown; recovery?: unknown };
    assert.ok(parsed.version >= 1);
    assert.ok(parsed.kdf);
    assert.ok(parsed.recovery, "export carries the recovery wrap");

    const destFile = join(dir, "imported", "store.json");
    const imported = await PocStore.importEncrypted(destFile, exported, PASSPHRASE);
    assert.equal(imported.getValue("email"), "dummy@example.com");
    assert.equal(imported.getValueForFill("card.cvv"), "123");
    assert.equal(imported.listSiteRecords().length, 1);
    assert.equal(imported.listMandates().length, 1);
    assert.equal(imported.hasRecoveryKey, true);

    const onDisk = await readFile(destFile, "utf8");
    assert.ok(!onDisk.includes("dummy@example.com"));
  });
});

test("importEncrypted refuses to overwrite an existing file without { overwrite: true }", async () => {
  await withTempDir(async (dir) => {
    const srcFile = join(dir, "store.json");
    const store = await PocStore.open(srcFile, PASSPHRASE, "pbkdf2-sha512");
    store.setProfileValue("email", "メール", "src@example.com");
    await store.save();
    const exported = await store.exportEncrypted();

    const destFile = join(dir, "dest", "store.json");
    const existing = await PocStore.open(destFile, "dest-passphrase", "pbkdf2-sha512");
    existing.setProfileValue("email", "メール", "dest@example.com");
    await existing.save();

    await assert.rejects(() => PocStore.importEncrypted(destFile, exported, PASSPHRASE), /refusing to overwrite/);

    const overwritten = await PocStore.importEncrypted(destFile, exported, PASSPHRASE, { overwrite: true });
    assert.equal(overwritten.getValue("email"), "src@example.com");
  });
});

test("importEncrypted rejects an export with an unsupported store format version", async () => {
  await withTempDir(async (dir) => {
    const srcFile = join(dir, "store.json");
    const store = await PocStore.open(srcFile, PASSPHRASE, "pbkdf2-sha512");
    await store.save();
    const exported = JSON.parse(await store.exportEncrypted()) as { version: number };
    exported.version = exported.version + 1;

    const destFile = join(dir, "dest", "store.json");
    await assert.rejects(() => PocStore.importEncrypted(destFile, JSON.stringify(exported), PASSPHRASE), /newer than supported/);
    await assert.rejects(() => readFile(destFile, "utf8"));
  });
});

test("importEncrypted rejects corrupt JSON before writing destination", async () => {
  await withTempDir(async (dir) => {
    const destFile = join(dir, "dest", "store.json");
    await assert.rejects(() => PocStore.importEncrypted(destFile, "{not json", PASSPHRASE));
    await assert.rejects(() => readFile(destFile, "utf8"));
  });
});
