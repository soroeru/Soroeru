import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SoroeruSession } from "../../electron/session.js";
import { DomainService } from "../../src/domain/domain-service.js";
import { VaultV2 } from "../../src/store/vault-v2.js";

// Fake data only (docs/testing.md). Covers issue #160's trusted-layer behavior:
// CSV import counts, the composed per-site Disclosure ledger with stale flags,
// the re-authenticated reveal (incl. most-sensitive refusal), and recovery-key
// setup/unlock. Raw values must never leak into a sanitized ledger view.
const PASSPHRASE = "ledger-test-passphrase";

const SAMPLE_CSV = [
  "name,url,username,password,note",
  "Example,https://example.test/login,user@example.test,fake-pass,",
  "Shop,https://shop.test/,shopper,fake-pass-2,memo",
].join("\n");

async function tmpVaultPath(): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "soroeru-ledger-"));
  return { dir, path: join(dir, "vault.json") };
}

/** Seed a vault on disk with one site and a mix of disclosures, then lock it. */
async function seedLedger(path: string): Promise<{ siteId: string; emailDisclosureId: string; addressDisclosureId: string; cvvDisclosureId: string }> {
  const vault = await VaultV2.open(path, PASSPHRASE);
  const domain = new DomainService(vault);

  const site = domain.upsertSiteAccount({ domain: "example.test", url: "https://example.test/", displayName: "Example" });
  domain.addCredential({ siteAccountId: site.id, username: "user@example.test", password: "fake-pass", source: "csv-import" });
  domain.setPersonalAttribute({ attributeKey: "email", label: "メール", value: "new@example.test", valueType: "email" });
  domain.setPersonalAttribute({ attributeKey: "phone.full", label: "電話", value: "09011112222", valueType: "phone" });

  const evidence = domain.addEvidence({ siteAccountId: site.id, pageUrl: "https://example.test/account", maskedSnippet: "•••" });

  // stale: site holds an old email vs the new canonical value.
  const emailDisclosure = domain.addDisclosure({
    siteAccountId: site.id,
    attributeKey: "email",
    siteHeldValue: "old@example.test",
    sourceKind: "form-field",
    evidenceIds: [evidence.id],
  });
  // current: site holds the canonical phone value.
  domain.addDisclosure({ siteAccountId: site.id, attributeKey: "phone.full", siteHeldValue: "09011112222", sourceKind: "form-field" });
  // most-sensitive: a CVV value the ledger must never reveal.
  const cvvDisclosure = domain.addDisclosure({ siteAccountId: site.id, attributeKey: "card.cvv", siteHeldValue: "123", sourceKind: "billing-page" });
  // unknown / hash-only: no raw value to reveal.
  const addressDisclosure = domain.addDisclosure({ siteAccountId: site.id, attributeKey: "address.full", normalizedValueHash: "deadbeef", sourceKind: "profile-text" });

  domain.addAccountRelationship({ siteAccountId: site.id, kind: "newsletter", state: "active", detail: "newsletter wording" });
  domain.addConstraint({ siteAccountId: site.id, kind: "wall", detail: "MFA wall" });

  await vault.save();
  vault.lock();
  return { siteId: site.id, emailDisclosureId: emailDisclosure.id, addressDisclosureId: addressDisclosure.id, cvvDisclosureId: cvvDisclosure.id };
}

test("importCsv seeds sites and the composed ledger lists them as not-yet-collected", async () => {
  const { dir, path } = await tmpVaultPath();
  try {
    const session = new SoroeruSession(path);
    assert.equal((await session.setup(PASSPHRASE)).ok, true);

    const result = await session.importCsv(SAMPLE_CSV);
    assert.equal(result.ok, true);
    assert.equal(result.summary?.sitesCreated, 2);
    assert.equal(result.summary?.importedCredentials, 2);
    assert.equal(result.summary?.recommendSourceDeletion, true);

    const sites = session.ledgerSites();
    assert.equal(sites.length, 2);
    for (const site of sites) {
      assert.equal(site.credentialCount, 1);
      assert.equal(site.disclosureCount, 0);
      assert.equal(site.collected, false);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("importCsv reports a sanitized reason for a malformed CSV", async () => {
  const { dir, path } = await tmpVaultPath();
  try {
    const session = new SoroeruSession(path);
    await session.setup(PASSPHRASE);
    const result = await session.importCsv("not,the,right,header\n1,2,3,4");
    assert.equal(result.ok, false);
    assert.equal(result.error, "bad-header");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the composed ledger summary and detail expose stale flags and masked previews only", async () => {
  const { dir, path } = await tmpVaultPath();
  try {
    const { siteId, emailDisclosureId } = await seedLedger(path);

    const session = new SoroeruSession(path);
    assert.equal((await session.unlock(PASSPHRASE)).ok, true);

    const [summary] = session.ledgerSites();
    assert.ok(summary);
    assert.equal(summary.collected, true);
    assert.equal(summary.disclosureCount, 4);
    assert.deepEqual(summary.stale, { current: 1, stale: 1, unknown: 2 });
    assert.deepEqual(summary.relationshipKinds, ["newsletter"]);
    assert.equal(summary.constraintCount, 1);

    const detail = session.ledgerSite(siteId);
    assert.ok(detail);
    const email = detail.disclosures.find((d) => d.disclosureId === emailDisclosureId);
    assert.equal(email?.staleState, "stale");
    assert.equal(email?.label, "メール");
    assert.equal(email?.revealable, true);
    assert.equal(email?.evidenceCount, 1);
    assert.match(email?.preview ?? "", /^•+$/);

    const cvv = detail.disclosures.find((d) => d.attributeKey === "card.cvv");
    assert.equal(cvv?.sensitivity, "most-sensitive");
    assert.equal(cvv?.revealable, false);

    // No raw value may appear anywhere in the serialized detail view.
    const serialized = JSON.stringify(detail);
    assert.equal(serialized.includes("old@example.test"), false);
    assert.equal(serialized.includes("123"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reveal requires correct re-auth, returns the raw value, and refuses the CVV", async () => {
  const { dir, path } = await tmpVaultPath();
  try {
    const { emailDisclosureId, addressDisclosureId, cvvDisclosureId } = await seedLedger(path);

    const session = new SoroeruSession(path);
    await session.unlock(PASSPHRASE);

    const wrong = await session.revealValue(emailDisclosureId, "wrong-passphrase");
    assert.equal(wrong.ok, false);
    assert.equal(wrong.error, "reauth-failed");
    assert.equal(wrong.value, undefined);

    const right = await session.revealValue(emailDisclosureId, PASSPHRASE);
    assert.equal(right.ok, true);
    assert.equal(right.value, "old@example.test");

    // CVV is refused outright — before any passphrase check would matter.
    const cvv = await session.revealValue(cvvDisclosureId, PASSPHRASE);
    assert.equal(cvv.ok, false);
    assert.equal(cvv.error, "reveal-not-permitted");

    // A hash-only disclosure has nothing to reveal even with correct re-auth.
    const noRaw = await session.revealValue(addressDisclosureId, PASSPHRASE);
    assert.equal(noRaw.ok, false);
    assert.equal(noRaw.error, "no-raw-value");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recovery key generation enables a recovery-key unlock on a fresh session", async () => {
  const { dir, path } = await tmpVaultPath();
  try {
    const setupSession = new SoroeruSession(path);
    await setupSession.setup(PASSPHRASE);
    assert.equal((await setupSession.status()).hasRecoveryKey, false);

    const generated = await setupSession.generateRecoveryKey();
    assert.equal(generated.ok, true);
    assert.equal(typeof generated.recoveryKey, "string");
    assert.equal((await setupSession.status()).hasRecoveryKey, true);

    const recoveryKey = generated.recoveryKey as string;
    const fresh = new SoroeruSession(path);
    assert.equal((await fresh.unlockWithRecoveryKey("WRONG-RECOVERY-KEY")).ok, false);
    assert.equal((await fresh.unlockWithRecoveryKey(recoveryKey)).ok, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ledger and import refuse to operate while locked", async () => {
  const { dir, path } = await tmpVaultPath();
  try {
    const session = new SoroeruSession(path);
    assert.deepEqual(session.ledgerSites(), []);
    assert.equal(session.ledgerSite("anything"), undefined);
    assert.equal((await session.importCsv(SAMPLE_CSV)).error, "locked");
    assert.equal((await session.revealValue("x", PASSPHRASE)).error, "locked");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
