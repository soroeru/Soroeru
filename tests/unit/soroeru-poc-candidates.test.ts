// Local candidate site definitions (#80, PRIV-003): encrypted, per-vault,
// validated before storage. Fake data only (docs/testing.md).

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CandidateValidationError, PocStore } from "../../src/store/store.js";
import type { LocalCandidateDefinition } from "../../src/types.js";

const PASSPHRASE = "unit-test-passphrase";

function candidate(id: string, partial: Partial<LocalCandidateDefinition> = {}): LocalCandidateDefinition {
  const now = 1000;
  return {
    id,
    serviceName: `候補サイト ${id}`,
    match: { urlPatterns: [`/site/${id}/`] },
    source: "observation",
    status: "candidate",
    createdAt: now,
    updatedAt: now,
    ...partial,
  };
}

test("local candidate definitions are upserted, listed, and deleted through the store", async () => {
  const dir = await mkdtemp(join(tmpdir(), "af-poc-candidates-"));
  const file = join(dir, "store.json");
  try {
    const store = await PocStore.open(file, PASSPHRASE, "pbkdf2-sha512");
    store.upsertLocalCandidate(candidate("alpha"));
    store.upsertLocalCandidate(candidate("beta"));
    await store.save();

    const reopened = await PocStore.open(file, PASSPHRASE);
    assert.equal(reopened.listLocalCandidates().length, 2);
    assert.equal(reopened.getLocalCandidate("alpha")?.serviceName, "候補サイト alpha");
    assert.equal(reopened.deleteLocalCandidate("alpha"), true);
    assert.equal(reopened.deleteLocalCandidate("alpha"), false);
    assert.equal(reopened.getLocalCandidate("alpha"), undefined);
    assert.equal(reopened.listLocalCandidates().length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("upsertLocalCandidate rejects an invalid candidate and never stores it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "af-poc-candidates-"));
  const file = join(dir, "store.json");
  try {
    const store = await PocStore.open(file, PASSPHRASE, "pbkdf2-sha512");
    const invalid = candidate("bad", { match: {} });
    assert.throws(() => store.upsertLocalCandidate(invalid), CandidateValidationError);
    assert.equal(store.listLocalCandidates().length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("upsertLocalCandidate rejects a candidate that embeds a raw personal value", async () => {
  const dir = await mkdtemp(join(tmpdir(), "af-poc-candidates-"));
  const file = join(dir, "store.json");
  try {
    const store = await PocStore.open(file, PASSPHRASE, "pbkdf2-sha512");
    const withRawValue = candidate("leaky", { notes: "owner: someone@example.com" });
    assert.throws(() => store.upsertLocalCandidate(withRawValue), CandidateValidationError);
    assert.equal(store.listLocalCandidates().length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("lock() clears local candidates from memory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "af-poc-candidates-"));
  const file = join(dir, "store.json");
  try {
    const store = await PocStore.open(file, PASSPHRASE, "pbkdf2-sha512");
    store.upsertLocalCandidate(candidate("alpha"));
    store.lock();
    assert.throws(() => store.listLocalCandidates());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("exportEncrypted/importEncrypted roundtrip restores local candidates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "af-poc-candidates-"));
  try {
    const srcFile = join(dir, "store.json");
    const store = await PocStore.open(srcFile, PASSPHRASE, "pbkdf2-sha512");
    store.upsertLocalCandidate(candidate("alpha"));
    await store.save();

    const exported = await store.exportEncrypted();
    const destFile = join(dir, "imported", "store.json");
    const imported = await PocStore.importEncrypted(destFile, exported, PASSPHRASE);
    assert.equal(imported.listLocalCandidates().length, 1);
    assert.equal(imported.getLocalCandidate("alpha")?.serviceName, "候補サイト alpha");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("submitted local candidate status persists through the encrypted store", async () => {
  const dir = await mkdtemp(join(tmpdir(), "af-poc-candidates-"));
  const file = join(dir, "store.json");
  try {
    const store = await PocStore.open(file, PASSPHRASE, "pbkdf2-sha512");
    store.upsertLocalCandidate(candidate("submitted", { status: "submitted" }));
    await store.save();

    const reopened = await PocStore.open(file, PASSPHRASE);
    assert.equal(reopened.getLocalCandidate("submitted")?.status, "submitted");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
