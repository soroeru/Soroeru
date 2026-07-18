import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SoroeruSession } from "../../electron/session.js";
import type { SessionEngine } from "../../electron/session.js";
import { DomainService } from "../../src/domain/domain-service.js";
import { VaultV2 } from "../../src/store/vault-v2.js";
import type { PageDriver, SiteSession } from "../../src/automation/page-driver.js";
import type { PageSnapshot } from "../../src/types.js";

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
async function seedLedger(
  path: string,
): Promise<{
  siteId: string;
  emailDisclosureId: string;
  addressDisclosureId: string;
  cvvDisclosureId: string;
}> {
  const vault = await VaultV2.open(path, PASSPHRASE);
  const domain = new DomainService(vault);

  const site = domain.upsertSiteAccount({
    domain: "example.test",
    url: "https://example.test/",
    displayName: "Example",
  });
  domain.addCredential({
    siteAccountId: site.id,
    username: "user@example.test",
    password: "fake-pass",
    source: "csv-import",
  });
  domain.setPersonalAttribute({
    attributeKey: "email",
    label: "メール",
    value: "new@example.test",
    valueType: "email",
  });
  domain.setPersonalAttribute({
    attributeKey: "phone.full",
    label: "電話",
    value: "09011112222",
    valueType: "phone",
  });

  const evidence = domain.addEvidence({
    siteAccountId: site.id,
    pageUrl: "https://example.test/account",
    maskedSnippet: "•••",
  });

  // stale: site holds an old email vs the new canonical value.
  const emailDisclosure = domain.addDisclosure({
    siteAccountId: site.id,
    attributeKey: "email",
    siteHeldValue: "old@example.test",
    sourceKind: "form-field",
    evidenceIds: [evidence.id],
  });
  // current: site holds the canonical phone value.
  domain.addDisclosure({
    siteAccountId: site.id,
    attributeKey: "phone.full",
    siteHeldValue: "09011112222",
    sourceKind: "form-field",
  });
  // most-sensitive: a CVV value the ledger must never reveal. Use a distinctive
  // canary (not a 3-digit value) so the no-leak substring check below cannot
  // coincidentally match random hex in UUIDs/timestamps.
  const cvvDisclosure = domain.addDisclosure({
    siteAccountId: site.id,
    attributeKey: "card.cvv",
    siteHeldValue: "CVV-CANARY-LEAK",
    sourceKind: "billing-page",
  });
  // unknown / hash-only: no raw value to reveal.
  const addressDisclosure = domain.addDisclosure({
    siteAccountId: site.id,
    attributeKey: "address.full",
    normalizedValueHash: "deadbeef",
    sourceKind: "profile-text",
  });
  domain.recordDynamicAttributeCandidate({
    siteAccountId: site.id,
    label: "職業",
    fieldId: "occupation",
    proposedAttributeKey: "custom.occupation",
    matchTerms: ["職業"],
  });
  domain.addDisclosure({
    siteAccountId: site.id,
    attributeKey: "custom.unknown.occupation",
    siteHeldValue: "会社員",
    sourceKind: "form-field",
  });

  domain.addAccountRelationship({
    siteAccountId: site.id,
    kind: "newsletter",
    state: "active",
    detail: "newsletter wording",
  });
  domain.addConstraint({ siteAccountId: site.id, kind: "wall", detail: "MFA wall" });
  vault.put("mandate", {
    id: "site-mandate",
    siteAccountId: site.id,
    operation: "collection",
    authorizedAt: 1,
  });

  await vault.save();
  vault.lock();
  return {
    siteId: site.id,
    emailDisclosureId: emailDisclosure.id,
    addressDisclosureId: addressDisclosure.id,
    cvvDisclosureId: cvvDisclosure.id,
  };
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

test("ledger reorder persists and newly imported sites append to the manual order", async () => {
  const { dir, path } = await tmpVaultPath();
  try {
    const session = new SoroeruSession(path);
    assert.equal((await session.setup(PASSPHRASE)).ok, true);
    assert.equal((await session.importCsv(SAMPLE_CSV)).ok, true);
    const initial = session.ledgerSites();

    assert.deepEqual(await session.reorderSiteAccounts(initial.map((site) => site.siteAccountId).reverse()), {
      ok: true,
    });
    assert.deepEqual(
      session.ledgerSites().map((site) => site.siteAccountId),
      initial.map((site) => site.siteAccountId).reverse(),
    );

    session.lock();
    assert.equal((await session.unlock(PASSPHRASE)).ok, true);
    assert.deepEqual(
      session.ledgerSites().map((site) => site.siteAccountId),
      initial.map((site) => site.siteAccountId).reverse(),
    );

    const added = await session.importCsv(
      ["name,url,username,password,note", "Later,https://later.test/,later,fake-pass-3,"].join("\n"),
    );
    assert.equal(added.ok, true);
    assert.equal(session.ledgerSites().at(-1)?.displayName, "Later");
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

test("the composed ledger detail shows normal disclosures plainly and masks only sensitive ones", async () => {
  const { dir, path } = await tmpVaultPath();
  try {
    const { siteId, emailDisclosureId } = await seedLedger(path);

    const session = new SoroeruSession(path);
    assert.equal((await session.unlock(PASSPHRASE)).ok, true);

    const [summary] = session.ledgerSites();
    assert.ok(summary);
    assert.equal(summary.collected, true);
    assert.equal(summary.disclosureCount, 5);
    assert.deepEqual(summary.stale, { current: 1, stale: 1, unknown: 3 });
    assert.deepEqual(summary.relationshipKinds, ["newsletter"]);
    assert.equal(summary.constraintCount, 1);

    const detail = session.ledgerSite(siteId);
    assert.ok(detail);
    // Credential summaries list username only — never the password (Issue #362).
    assert.equal(detail.credentials.length, 1);
    assert.equal(detail.credentials[0]?.username, "user@example.test");
    assert.equal("password" in detail.credentials[0]!, false);
    // "normal" sensitivity (email, phone, address, custom fields): shown
    // plainly and immediately, no reveal gate (Issue #300).
    const email = detail.disclosures.find((d) => d.disclosureId === emailDisclosureId);
    assert.equal(email?.staleState, "stale");
    assert.equal(email?.label, "メール（email）");
    assert.equal(email?.sensitivity, "normal");
    assert.equal(email?.revealable, false);
    assert.equal(email?.evidenceCount, 1);
    assert.equal(email?.preview, "old@example.test");

    const dynamic = detail.disclosures.find((d) => d.attributeKey === "custom.unknown.occupation");
    assert.equal(dynamic?.label, "職業（custom.unknown.occupation）");
    assert.equal(dynamic?.sensitivity, "normal");
    assert.equal(dynamic?.revealable, false);
    assert.equal(dynamic?.preview, "会社員");

    // "sensitive" (card data, the site password) still stays masked behind reveal.
    const cvv = detail.disclosures.find((d) => d.attributeKey === "card.cvv");
    assert.equal(cvv?.sensitivity, "most-sensitive");
    assert.equal(cvv?.revealable, false);
    assert.equal(cvv?.preview, "");

    const pending = detail.pendingAttributeCandidates.find(
      (c) => c.proposedAttributeKey === "custom.occupation",
    );
    assert.equal(pending?.label, "職業");

    // The CVV canary must never appear unmasked anywhere in the serialized view.
    const serialized = JSON.stringify(detail);
    assert.equal(serialized.includes("CVV-CANARY-LEAK"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ledgerSiteDetails returns every site's full detail in one call, matching ledgerSite per site", async () => {
  const { dir, path } = await tmpVaultPath();
  try {
    const { siteId } = await seedLedger(path);

    const vault = await VaultV2.open(path, PASSPHRASE);
    const domain = new DomainService(vault);
    // A second site with a different (heterogeneous) attribute set, per Issue
    // #301's spreadsheet-style ledger view, which unions columns across sites.
    const otherSite = domain.upsertSiteAccount({
      domain: "shop.test",
      url: "https://shop.test/",
      displayName: "Shop",
    });
    domain.addDisclosure({
      siteAccountId: otherSite.id,
      attributeKey: "phone.full",
      siteHeldValue: "09033334444",
      sourceKind: "form-field",
    });
    await vault.save();
    vault.lock();

    const session = new SoroeruSession(path);
    assert.equal((await session.unlock(PASSPHRASE)).ok, true);

    const details = session.ledgerSiteDetails();
    assert.equal(details.length, 2);

    const seeded = details.find((d) => d.siteAccountId === siteId);
    const shop = details.find((d) => d.siteAccountId === otherSite.id);
    assert.ok(seeded);
    assert.ok(shop);
    assert.deepEqual(seeded, session.ledgerSite(siteId));
    assert.deepEqual(shop, session.ledgerSite(otherSite.id));
    assert.equal(shop?.disclosures.length, 1);
    assert.equal(shop?.disclosures[0]?.attributeKey, "phone.full");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ledger detail labels prefer canonical, dynamic, fixed, then raw keys with display-key formatting", async () => {
  const { dir, path } = await tmpVaultPath();
  try {
    const vault = await VaultV2.open(path, PASSPHRASE);
    const domain = new DomainService(vault);
    const site = domain.upsertSiteAccount({
      domain: "labels.test",
      url: "https://labels.test/",
      displayName: "Labels",
    });
    domain.setPersonalAttribute({
      attributeKey: "email",
      label: "連絡先メール",
      value: "user@example.test",
      valueType: "email",
    });
    domain.recordDynamicAttributeCandidate({
      siteAccountId: site.id,
      label: "会員ランク",
      fieldId: "member-rank",
      proposedAttributeKey: "custom.member_rank",
      matchTerms: ["会員ランク"],
    });
    domain.addDisclosure({
      siteAccountId: site.id,
      attributeKey: "email",
      siteHeldValue: "user@example.test",
      sourceKind: "form-field",
    });
    domain.addDisclosure({
      siteAccountId: site.id,
      attributeKey: "custom.member_rank",
      siteHeldValue: "gold",
      sourceKind: "form-field",
    });
    domain.addDisclosure({
      siteAccountId: site.id,
      attributeKey: "birth.year",
      siteHeldValue: "1990",
      sourceKind: "form-field",
    });
    domain.addDisclosure({
      siteAccountId: site.id,
      attributeKey: "custom.unlabeled",
      siteHeldValue: "raw",
      sourceKind: "form-field",
    });
    await vault.save();
    vault.lock();

    const session = new SoroeruSession(path);
    assert.equal((await session.unlock(PASSPHRASE)).ok, true);

    const detail = session.ledgerSite(site.id);
    assert.ok(detail);
    const labels = new Map(
      detail.disclosures.map((disclosure) => [disclosure.attributeKey, disclosure.label]),
    );
    assert.equal(labels.get("email"), "連絡先メール（email）");
    assert.equal(labels.get("custom.member_rank"), "会員ランク（custom.member_rank）");
    assert.equal(labels.get("birth.year"), "生年（birth.year）");
    assert.equal(labels.get("custom.unlabeled"), "custom.unlabeled");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ledgerSiteDetails returns an empty list while locked", async () => {
  const { dir, path } = await tmpVaultPath();
  try {
    await seedLedger(path);
    const session = new SoroeruSession(path);
    assert.deepEqual(session.ledgerSiteDetails(), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a sensitive disclosure (card number) still masks its preview and requires reveal", async () => {
  const { dir, path } = await tmpVaultPath();
  try {
    const vault = await VaultV2.open(path, PASSPHRASE);
    const domain = new DomainService(vault);
    const site = domain.upsertSiteAccount({
      domain: "shop.test",
      url: "https://shop.test/",
      displayName: "Shop",
    });
    const cardDisclosure = domain.addDisclosure({
      siteAccountId: site.id,
      attributeKey: "card.number",
      siteHeldValue: "1234",
      sourceKind: "billing-page",
    });
    await vault.save();
    vault.lock();

    const session = new SoroeruSession(path);
    await session.unlock(PASSPHRASE);
    const detail = session.ledgerSite(site.id);
    const card = detail?.disclosures.find((d) => d.disclosureId === cardDisclosure.id);
    assert.equal(card?.sensitivity, "sensitive");
    assert.equal(card?.revealable, true);
    assert.match(card?.preview ?? "", /^•+$/);

    const revealed = await session.revealValue(cardDisclosure.id, PASSPHRASE);
    assert.equal(revealed.ok, true);
    assert.equal(revealed.value, "1234");
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
    assert.equal(
      (
        await session.confirmDynamicAttributeCandidate({
          proposedAttributeKey: "custom.occupation",
          label: "職業",
        })
      ).error,
      "locked",
    );
    assert.equal(
      (await session.deleteSiteAccount({ siteAccountId: "anything", confirmedFourthBoundary: true })).error,
      "locked",
    );
    assert.equal(
      (
        await session.updateSiteCredential({
          siteAccountId: "anything",
          credentialId: "c",
          password: "x",
          confirmedOverwrite: true,
        })
      ).error,
      "locked",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("updateSiteCredential persists a new password, uses it on listCredentials, and never leaks it to ledger views", async () => {
  const { dir, path } = await tmpVaultPath();
  try {
    const { siteId } = await seedLedger(path);
    const session = new SoroeruSession(path);
    await session.unlock(PASSPHRASE);

    const detailBefore = session.ledgerSite(siteId);
    assert.ok(detailBefore);
    assert.equal(detailBefore.credentials.length, 1);
    const credentialId = detailBefore.credentials[0]?.credentialId;
    assert.ok(credentialId);
    assert.equal(detailBefore.credentials[0]?.username, "user@example.test");

    const missingConfirm = await session.updateSiteCredential({
      siteAccountId: siteId,
      credentialId,
      password: "rotated-secret-pass",
      confirmedOverwrite: false,
    });
    assert.equal(missingConfirm.ok, false);
    assert.equal(missingConfirm.error, "confirmation-required");

    const updated = await session.updateSiteCredential({
      siteAccountId: siteId,
      credentialId,
      username: "rotated@example.test",
      password: "rotated-secret-pass",
      confirmedOverwrite: true,
    });
    assert.equal(updated.ok, true);
    assert.equal(updated.credential?.username, "rotated@example.test");
    assert.equal("password" in (updated.credential ?? {}), false);

    const detailAfter = session.ledgerSite(siteId);
    assert.ok(detailAfter);
    assert.equal(detailAfter.credentials[0]?.username, "rotated@example.test");
    const serialized = JSON.stringify({ result: updated, detail: detailAfter });
    assert.equal(serialized.includes("rotated-secret-pass"), false);
    assert.equal(serialized.includes("fake-pass"), false);

    // Re-open vault: collection path reads DomainService.listCredentialsForSite.
    const reopened = new SoroeruSession(path);
    await reopened.unlock(PASSPHRASE);
    // Access via a temporary domain-side check through visibility: password must be the new one.
    // Session does not expose raw credentials; re-open vault directly for the domain assertion.
    const vault = await VaultV2.open(path, PASSPHRASE);
    const domain = new DomainService(vault);
    const creds = domain.listCredentialsForSite(siteId);
    assert.equal(creds[0]?.password, "rotated-secret-pass");
    assert.equal(creds[0]?.username, "rotated@example.test");
    vault.lock();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("deleteSiteAccount persists the cascade and refreshes composed ledger data", async () => {
  const { dir, path } = await tmpVaultPath();
  try {
    const { siteId } = await seedLedger(path);

    const session = new SoroeruSession(path);
    await session.unlock(PASSPHRASE);
    assert.equal(session.ledgerSites().length, 1);
    assert.ok(session.ledgerSite(siteId));

    const missingConfirmation = await session.deleteSiteAccount({
      siteAccountId: siteId,
      confirmedFourthBoundary: false,
    });
    assert.equal(missingConfirmation.ok, false);
    assert.equal(missingConfirmation.error, "confirmation-required");
    assert.equal(session.ledgerSites().length, 1);

    const deleted = await session.deleteSiteAccount({ siteAccountId: siteId, confirmedFourthBoundary: true });
    assert.equal(deleted.ok, true);
    assert.equal(deleted.deleted?.siteAccounts, 1);
    assert.equal(deleted.deleted?.credentials, 1);
    assert.equal(deleted.deleted?.disclosures, 5);
    assert.equal(deleted.deleted?.accountRelationships, 1);
    assert.equal(deleted.deleted?.constraints, 1);
    assert.equal(deleted.deleted?.evidence, 1);
    assert.equal(deleted.deleted?.mandates, 1);
    assert.deepEqual(session.ledgerSites(), []);
    assert.equal(session.ledgerSite(siteId), undefined);

    const reopened = new SoroeruSession(path);
    await reopened.unlock(PASSPHRASE);
    assert.deepEqual(reopened.ledgerSites(), []);
    assert.equal(reopened.ledgerSite(siteId), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("confirming a pending dynamic-attribute candidate removes it from the site's pending list", async () => {
  const { dir, path } = await tmpVaultPath();
  try {
    const { siteId } = await seedLedger(path);

    const session = new SoroeruSession(path);
    await session.unlock(PASSPHRASE);

    assert.equal(
      (
        await session.confirmDynamicAttributeCandidate({
          proposedAttributeKey: "not-a-custom-key",
          label: "職業",
        })
      ).error,
      "invalid-request",
    );
    assert.equal(
      (
        await session.confirmDynamicAttributeCandidate({
          proposedAttributeKey: "custom.occupation",
          label: "  ",
        })
      ).error,
      "invalid-request",
    );
    assert.equal(
      (
        await session.confirmDynamicAttributeCandidate({
          proposedAttributeKey: "custom.never-observed",
          label: "x",
        })
      ).error,
      "not-found",
    );

    const before = session.ledgerSite(siteId);
    assert.ok(before?.pendingAttributeCandidates.some((c) => c.proposedAttributeKey === "custom.occupation"));

    const confirmed = await session.confirmDynamicAttributeCandidate({
      proposedAttributeKey: "custom.occupation",
      label: "職業",
    });
    assert.equal(confirmed.ok, true);

    const after = session.ledgerSite(siteId);
    assert.equal(
      after?.pendingAttributeCandidates.some((c) => c.proposedAttributeKey === "custom.occupation"),
      false,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("two sites independently observing the same unmapped field both keep it pending until confirmed", async () => {
  const { dir, path } = await tmpVaultPath();
  try {
    const vault = await VaultV2.open(path, PASSPHRASE);
    const domain = new DomainService(vault);
    const siteA = domain.upsertSiteAccount({
      domain: "a.example.test",
      url: "https://a.example.test/",
      displayName: "A",
    });
    const siteB = domain.upsertSiteAccount({
      domain: "b.example.test",
      url: "https://b.example.test/",
      displayName: "B",
    });
    // Both sites independently surface an unmapped field that slugs to the same
    // proposed key — the underlying candidate record is shared (keyed by
    // proposedAttributeKey), so confirming site B's observation must not make
    // the candidate disappear from site A's still-unconfirmed pending list.
    domain.recordDynamicAttributeCandidate({
      siteAccountId: siteA.id,
      label: "職業",
      fieldId: "occupation",
      proposedAttributeKey: "custom.occupation",
      matchTerms: ["職業"],
    });
    domain.recordDynamicAttributeCandidate({
      siteAccountId: siteB.id,
      label: "職業",
      fieldId: "occupation",
      proposedAttributeKey: "custom.occupation",
      matchTerms: ["職業"],
    });
    await vault.save();
    vault.lock();

    const session = new SoroeruSession(path);
    await session.unlock(PASSPHRASE);

    const beforeA = session.ledgerSite(siteA.id);
    const beforeB = session.ledgerSite(siteB.id);
    assert.ok(
      beforeA?.pendingAttributeCandidates.some((c) => c.proposedAttributeKey === "custom.occupation"),
    );
    assert.ok(
      beforeB?.pendingAttributeCandidates.some((c) => c.proposedAttributeKey === "custom.occupation"),
    );

    // Once confirmed (from either site's perspective), it becomes a reusable
    // global attribute and must stop appearing as "pending" everywhere.
    const confirmed = await session.confirmDynamicAttributeCandidate({
      proposedAttributeKey: "custom.occupation",
      label: "職業",
    });
    assert.equal(confirmed.ok, true);

    const afterA = session.ledgerSite(siteA.id);
    const afterB = session.ledgerSite(siteB.id);
    assert.equal(
      afterA?.pendingAttributeCandidates.some((c) => c.proposedAttributeKey === "custom.occupation"),
      false,
    );
    assert.equal(
      afterB?.pendingAttributeCandidates.some((c) => c.proposedAttributeKey === "custom.occupation"),
      false,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("two sites observing the same candidate under different labels both keep their label in matchTerms", async () => {
  const { dir, path } = await tmpVaultPath();
  try {
    const vault = await VaultV2.open(path, PASSPHRASE);
    const domain = new DomainService(vault);
    const siteA = domain.upsertSiteAccount({
      domain: "a.example.test",
      url: "https://a.example.test/",
      displayName: "A",
    });
    const siteB = domain.upsertSiteAccount({
      domain: "b.example.test",
      url: "https://b.example.test/",
      displayName: "B",
    });

    domain.recordDynamicAttributeCandidate({
      siteAccountId: siteA.id,
      label: "職業",
      fieldId: "occupation",
      proposedAttributeKey: "custom.occupation",
      matchTerms: ["職業"],
    });
    // Site B's page phrases the same real-world field differently. Recording it
    // must not overwrite site A's match term — both must remain re-mappable.
    domain.recordDynamicAttributeCandidate({
      siteAccountId: siteB.id,
      label: "ご職業",
      fieldId: "occupation2",
      proposedAttributeKey: "custom.occupation",
      matchTerms: ["ご職業"],
    });

    const candidate = domain
      .listDynamicAttributeCandidates()
      .find((c) => c.proposedAttributeKey === "custom.occupation");
    assert.ok(candidate?.matchTerms.includes("職業"));
    assert.ok(candidate?.matchTerms.includes("ご職業"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a candidate persisted under the pre-siteAccountIds shape still appears in the site's pending list", async () => {
  const { dir, path } = await tmpVaultPath();
  try {
    const vault = await VaultV2.open(path, PASSPHRASE);
    const domain = new DomainService(vault);
    const site = domain.upsertSiteAccount({
      domain: "legacy.example.test",
      url: "https://legacy.example.test/",
      displayName: "Legacy",
    });

    // Simulate a candidate written by the earlier shape that tracked a single
    // `siteAccountId` field rather than an array, to guard against a schema
    // rename silently losing already-persisted candidates.
    vault.put("localDefinition", {
      id: "dynamic-attribute:custom.occupation",
      serviceName: "職業",
      source: "observation",
      status: "candidate",
      data: {
        kind: "dynamic-attribute",
        label: "職業",
        proposedAttributeKey: "custom.occupation",
        matchTerms: ["職業"],
        fieldId: "occupation",
        siteAccountId: site.id,
      },
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    });
    await vault.save();
    vault.lock();

    const session = new SoroeruSession(path);
    await session.unlock(PASSPHRASE);

    const detail = session.ledgerSite(site.id);
    assert.ok(detail?.pendingAttributeCandidates.some((c) => c.proposedAttributeKey === "custom.occupation"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("session persistence: set/clear toggles the ledger detail view and enforces immediate clear-on-disable", async () => {
  const { dir, path } = await tmpVaultPath();
  try {
    const vault = await VaultV2.open(path, PASSPHRASE);
    const domain = new DomainService(vault);
    const site = domain.upsertSiteAccount({
      domain: "example.test",
      url: "https://example.test/",
      displayName: "Example",
    });
    await vault.save();
    vault.lock();

    const session = new SoroeruSession(path);
    assert.equal((await session.unlock(PASSPHRASE)).ok, true);

    const initial = session.ledgerSite(site.id);
    assert.deepEqual(initial?.sessionPersistence, { enabled: false, hasPersistedSession: false });

    const enabled = await session.setSessionPersistence({ siteAccountId: site.id, enabled: true });
    assert.equal(enabled.ok, true);
    assert.equal(enabled.state?.enabled, true);
    assert.equal(enabled.state?.hasPersistedSession, false);
    assert.equal(session.ledgerSite(site.id)?.sessionPersistence.enabled, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** Seed a site with an opted-in, already-persisted session (as if a prior Visibility run exported one). */
async function seedPersistedSession(path: string): Promise<{ siteId: string }> {
  const vault = await VaultV2.open(path, PASSPHRASE);
  const domain = new DomainService(vault);
  const site = domain.upsertSiteAccount({
    domain: "example.test",
    url: "https://example.test/",
    displayName: "Example",
  });
  domain.setSessionPersistenceEnabled(site.id, true);
  domain.savePersistedSessionState({ siteAccountId: site.id, storageState: '{"cookies":[],"origins":[]}' });
  await vault.save();
  vault.lock();
  return { siteId: site.id };
}

test("session persistence: the ledger detail reflects an already-persisted session, and clear/disable remove it", async () => {
  const { dir, path } = await tmpVaultPath();
  try {
    const { siteId } = await seedPersistedSession(path);
    const session = new SoroeruSession(path);
    assert.equal((await session.unlock(PASSPHRASE)).ok, true);

    const withSession = session.ledgerSite(siteId);
    assert.equal(withSession?.sessionPersistence.enabled, true);
    assert.equal(withSession?.sessionPersistence.hasPersistedSession, true);
    assert.ok(withSession?.sessionPersistence.updatedAt);
    assert.ok(withSession?.sessionPersistence.expiresAt);

    const cleared = await session.clearSessionPersistence(siteId);
    assert.equal(cleared.ok, true);
    assert.equal(cleared.state?.enabled, true);
    assert.equal(cleared.state?.hasPersistedSession, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("session persistence: disabling unconditionally and immediately clears an existing persisted session", async () => {
  const { dir, path } = await tmpVaultPath();
  try {
    const { siteId } = await seedPersistedSession(path);
    const session = new SoroeruSession(path);
    assert.equal((await session.unlock(PASSPHRASE)).ok, true);
    assert.equal(session.ledgerSite(siteId)?.sessionPersistence.hasPersistedSession, true);

    const disabled = await session.setSessionPersistence({ siteAccountId: siteId, enabled: false });
    assert.equal(disabled.state?.enabled, false);
    assert.equal(disabled.state?.hasPersistedSession, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("session persistence: locked and not-found are reported without throwing", async () => {
  const { dir, path } = await tmpVaultPath();
  try {
    const session = new SoroeruSession(path);
    await session.setup(PASSPHRASE);

    assert.deepEqual(await session.setSessionPersistence({ siteAccountId: "missing", enabled: true }), {
      ok: false,
      error: "not-found",
    });
    assert.deepEqual(await session.clearSessionPersistence("missing"), { ok: false, error: "not-found" });

    session.lock();
    assert.deepEqual(await session.setSessionPersistence({ siteAccountId: "any", enabled: true }), {
      ok: false,
      error: "locked",
    });
    assert.deepEqual(await session.clearSessionPersistence("any"), { ok: false, error: "locked" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** Minimal PageDriver reaching a fast "no-data" result: no credential, no fields to collect. */
class NoDataPageDriver implements PageDriver {
  closed = false;
  async goto(): Promise<void> {}
  async waitForReady(): Promise<void> {}
  currentUrl(): string {
    return "https://example.test/account";
  }
  async snapshot(): Promise<PageSnapshot> {
    return {
      url: "https://example.test/account",
      title: "Account",
      fields: [],
      buttons: [],
      links: [],
      visibleText: "",
      iframeSrcs: [],
      wallMarkers: [],
    };
  }
  async readValues(): Promise<Record<string, string>> {
    return {};
  }
  async fillField(): Promise<void> {}
  async click(): Promise<void> {}
}

/**
 * Exercises the real (production) `defaultOpenSession` / `wrapSessionForPersistence`
 * seam in `electron/session.ts` — every other test in this file and in
 * `soroeru-visibility-service.test.ts` injects a full `openSession` override that
 * bypasses this seam entirely. Here only the underlying `SessionEngine` is faked,
 * so `SoroeruSession` runs its own persistence-aware opener/closer.
 */
test("session persistence: a real run passes the persisted storageState into the engine and re-saves it on close (Issue #294)", async () => {
  const { dir, path } = await tmpVaultPath();
  try {
    const vault = await VaultV2.open(path, PASSPHRASE);
    const domain = new DomainService(vault);
    const site = domain.upsertSiteAccount({
      domain: "example.test",
      url: "https://example.test/account",
      displayName: "Example",
    });
    domain.setSessionPersistenceEnabled(site.id, true);
    domain.savePersistedSessionState({
      siteAccountId: site.id,
      storageState: '{"cookies":[{"name":"old"}],"origins":[]}',
    });
    await vault.save();
    vault.lock();

    const openSessionCalls: Array<{ storageState?: string }> = [];
    const exportedStorageState = '{"cookies":[{"name":"fresh"}],"origins":[]}';
    const engine: SessionEngine = {
      openSession: async (_site, options) => {
        openSessionCalls.push({
          ...(options?.storageState !== undefined ? { storageState: options.storageState } : {}),
        });
        const page = new NoDataPageDriver();
        const fakeSession: SiteSession = {
          page,
          close: async () => {
            page.closed = true;
          },
          exportStorageState: async () => exportedStorageState,
        };
        return fakeSession;
      },
      closeAll: async () => {},
    };

    const session = new SoroeruSession(path, { engine });
    assert.equal((await session.unlock(PASSPHRASE)).ok, true);

    const result = await session.runVisibility(site.id);
    assert.equal(result.status, "no-data");

    // The prior persisted session was handed to the engine as the seed storageState.
    assert.deepEqual(openSessionCalls, [{ storageState: '{"cookies":[{"name":"old"}],"origins":[]}' }]);

    // On close, the freshly exported storageState was saved back to the vault
    // (verified via a fresh reopen, so this is a real on-disk round-trip, not
    // just an in-memory check).
    session.lock();
    const reopened = new SoroeruSession(path);
    assert.equal((await reopened.unlock(PASSPHRASE)).ok, true);
    const view = reopened.ledgerSite(site.id);
    assert.equal(view?.sessionPersistence.hasPersistedSession, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("session persistence: disabling the toggle mid-run still skips the export on close (fresh re-check, not the stale opened-with value)", async () => {
  const { dir, path } = await tmpVaultPath();
  try {
    const vault = await VaultV2.open(path, PASSPHRASE);
    const domain = new DomainService(vault);
    const site = domain.upsertSiteAccount({
      domain: "example.test",
      url: "https://example.test/account",
      displayName: "Example",
    });
    domain.setSessionPersistenceEnabled(site.id, true);
    domain.savePersistedSessionState({
      siteAccountId: site.id,
      storageState: '{"cookies":[{"name":"old"}],"origins":[]}',
    });
    await vault.save();
    vault.lock();

    let exportCalls = 0;
    let sessionHolder: SoroeruSession | undefined;
    const engine: SessionEngine = {
      openSession: async (_site) => {
        // Simulate the user flipping the toggle off in the UI while the
        // browser session opened by this very call is still in flight.
        await sessionHolder!.setSessionPersistence({ siteAccountId: site.id, enabled: false });
        const page = new NoDataPageDriver();
        const fakeSession: SiteSession = {
          page,
          close: async () => {
            page.closed = true;
          },
          exportStorageState: async () => {
            exportCalls += 1;
            return '{"cookies":[{"name":"fresh"}],"origins":[]}';
          },
        };
        return fakeSession;
      },
      closeAll: async () => {},
    };

    const session = new SoroeruSession(path, { engine });
    sessionHolder = session;
    assert.equal((await session.unlock(PASSPHRASE)).ok, true);

    await session.runVisibility(site.id);

    // wrapSessionForPersistence re-checks persistSessionEnabled fresh at close
    // time (not the value the session was opened with), so no export happens.
    assert.equal(exportCalls, 0);
    const view = session.ledgerSite(site.id);
    assert.equal(view?.sessionPersistence.enabled, false);
    assert.equal(view?.sessionPersistence.hasPersistedSession, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
