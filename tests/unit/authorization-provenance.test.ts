import assert from "node:assert/strict";
import test from "node:test";
import { VaultV2 } from "../../src/store/vault-v2.js";
import type { EncryptedVaultData, VaultPersistence } from "../../src/store/vault-persistence.js";
import { DomainService } from "../../src/domain/domain-service.js";
import { ConsequenceApprovals, consequenceDigest } from "../../src/domain/consequence-approval.js";
import { deriveKey, encryptRecord } from "../../src/store/crypto.js";
import { VisibilityHost } from "../../extension/panel/visibility-host.js";
import { VaultSession } from "../../src/store/vault-session.js";
import type { LeaseClient } from "../../extension/panel/lease-client.js";

const passphrase = "fake-authorization-passphrase";
function memory(): VaultPersistence & { data: EncryptedVaultData | null; fail: boolean } {
  return { data: null, fail: false, async load() { return structuredClone(this.data); }, async save(data) { if (this.fail) throw new Error("quota"); this.data = structuredClone(data); }, async clear() { this.data = null; } };
}
async function fixture() {
  const persistence = memory();
  const vault = await VaultV2.open(persistence, passphrase, "pbkdf2-sha512");
  const domain = new DomainService(vault);
  const site = domain.upsertSiteAccount({ id: "fake-site", domain: "example.test", displayName: "Fake" });
  return { persistence, vault, domain, site };
}

test("manual replacement invalidates verified provenance and recomputes disclosure comparisons", async () => {
  const { vault, domain, site } = await fixture();
  const initial = domain.setPersonalAttribute({ attributeKey: "email", label: "Email", value: "old@example.test" });
  vault.put("personalAttribute", { ...initial, provenance: { source: "identity-verification", verification: "verified", method: "jpki", verifiedAt: 1, evidenceId: "fake-evidence" } });
  domain.addDisclosure({ siteAccountId: site.id, attributeKey: "email", siteHeldValue: "old@example.test", observedAt: 1, sourceKind: "profile-text", confidence: 1 });
  assert.equal(domain.listDisclosures()[0]!.staleState, "current");
  const edited = domain.setPersonalAttribute({ attributeKey: "email", label: "Email", value: "new@example.test" });
  assert.deepEqual(edited.provenance, { source: "user-entered", verification: "unverified" });
  assert.equal(domain.listDisclosures()[0]!.staleState, "stale");
  assert.throws(() => domain.setPersonalAttribute({ attributeKey: "custom.fake", label: "PIN", value: "0000" }));
  assert.throws(() => domain.setPersonalAttribute({ attributeKey: "email", label: "Email", value: "123456789012" }));
});

test("an unchanged manual edit keeps the verified provenance", async () => {
  const { vault, domain } = await fixture();
  const initial = domain.setPersonalAttribute({ attributeKey: "email", label: "Email", value: "old@example.test" });
  vault.put("personalAttribute", { ...initial, provenance: { source: "identity-verification", verification: "verified", method: "jpki", verifiedAt: 1, evidenceId: "fake-evidence" } });
  const same = domain.setPersonalAttribute({ attributeKey: "email", label: "Email", value: "old@example.test" });
  assert.equal(same.provenance.verification, "verified");
  assert.equal(same.provenance.source, "identity-verification");
});

test("explicit L1 enforces operation/account/attribute and revokes stale same-clock grants", async () => {
  const { domain, site } = await fixture();
  const enabled = domain.enableCapability({ operation: "collection", scope: { siteAccountIds: [site.id], attributeKeys: ["email", "phone.full"] }, policyVersion: 1 });
  const context = { operation: "collection" as const, siteAccountId: site.id, attributeKeys: ["email"], actionId: "run-1", revision: enabled.revision, policyVersion: 1 };
  assert.equal(domain.authorizeOperation(context).kind, "permitted");
  assert.equal(domain.authorizeOperation({ ...context, siteAccountId: "another" }).kind, "stopped");
  assert.equal(domain.authorizeOperation({ ...context, attributeKeys: ["card.number"] }).kind, "stopped");
  assert.notEqual(domain.authorizeOperation({ ...context, operation: "ai-assisted-discovery" }).kind, "permitted");
  domain.reduceCapability({ operation: "collection", scope: { siteAccountIds: [site.id], attributeKeys: ["email"] } });
  assert.equal(domain.authorizeOperation(context).kind, "stopped");
  const reduced = domain.getCapability("collection")!;
  assert.ok(reduced.revision > enabled.revision);
  domain.reduceCapability({ operation: "collection" });
  assert.equal(domain.authorizeOperation({ ...context, revision: domain.getCapability("collection")!.revision }).kind, "review-required");
});

async function legacyFixture() {
  const f = await fixture();
  f.domain.setPersonalAttribute({ attributeKey: "email", label: "Email", value: "fake@example.test" });
  const recoveryKey = await f.vault.setupRecoveryKey();
  await f.vault.save();
  const doc = f.persistence.data!;
  const key = await deriveKey(passphrase, doc.kdf);
  const oldAttribute = { ...f.domain.getPersonalAttribute("email")!, provenance: undefined };
  const oldCapability = { id: "collection", operationType: "collection", level: "L1", understandingCheckPassedAt: 1, updatedAt: 1 };
  for (const [kind, payload] of [["personalAttribute", oldAttribute], ["capability", oldCapability]] as const) {
    const encrypted = await encryptRecord(key, JSON.stringify(payload));
    doc.records = doc.records.filter(r => r.entityKind !== kind);
    doc.records.push({ recordId: payload.id, entityKind: kind, schemaVersion: 1, iv: encrypted.iv, ciphertext: encrypted.ct, createdAt: 1, updatedAt: 1 });
  }
  return { ...f, recoveryKey };
}

test("legacy attributes and quiz L1 migrate durably without invented assurance or authority", async () => {
  const { persistence } = await legacyFixture();
  const migrated = await VaultV2.open(persistence, passphrase);
  assert.deepEqual(migrated.get("personalAttribute", "email")!.provenance, { source: "legacy-unknown", verification: "unverified" });
  assert.equal(migrated.get("capability", "collection")!.level, "L0");
  assert.equal(migrated.get("capability", "collection")!.scope, undefined);
  assert.equal(persistence.data!.records.find(r => r.entityKind === "capability")!.schemaVersion, 2);
  const ciphertext = structuredClone(persistence.data);
  await VaultV2.open(persistence, passphrase);
  assert.deepEqual(persistence.data, ciphertext, "reopen is idempotent");
  const imported = await VaultV2.importEncrypted(memory(), await migrated.exportEncrypted(), passphrase);
  assert.equal(imported.get("personalAttribute", "email")!.value, "fake@example.test");
});

test("recovery-key unlock migrates legacy attributes and quiz L1 without promotion", async () => {
  const { persistence, recoveryKey } = await legacyFixture();
  const opened = await VaultV2.openWithRecoveryKey(persistence, recoveryKey);
  assert.equal(opened.get("personalAttribute", "email")!.value, "fake@example.test");
  assert.deepEqual(opened.get("personalAttribute", "email")!.provenance, { source: "legacy-unknown", verification: "unverified" });
  assert.equal(opened.get("capability", "collection")!.level, "L0");
  assert.equal(opened.get("capability", "collection")!.scope, undefined);
});

test("a newer attribute schema does not replace the stored vault", async () => {
  const { persistence, vault, domain } = await fixture();
  domain.setPersonalAttribute({ attributeKey: "email", label: "Email", value: "fake@example.test" });
  await vault.save();
  const record = persistence.data!.records.find((item) => item.entityKind === "personalAttribute");
  assert.ok(record);
  record.schemaVersion = 99;
  const planted = structuredClone(persistence.data);
  await assert.rejects(VaultV2.open(persistence, passphrase), /schema version 99/);
  assert.deepEqual(persistence.data, planted);
});

test("migration failure preserves ciphertext and retry never promotes legacy L1", async () => {
  const { persistence } = await legacyFixture();
  const before = structuredClone(persistence.data);
  persistence.fail = true;
  await assert.rejects(VaultV2.open(persistence, passphrase), /quota/);
  assert.deepEqual(persistence.data, before);
  persistence.fail = false;
  assert.equal((await VaultV2.open(persistence, passphrase)).get("capability", "collection")!.level, "L0");
});

test("current malformed provenance and authority are rejected before persistence", async () => {
  const { vault, domain } = await fixture();
  const attribute = domain.setPersonalAttribute({ attributeKey: "email", label: "Email", value: "fake@example.test" });
  assert.throws(() => vault.put("personalAttribute", { ...attribute, provenance: { source: "user-entered", verification: "verified" } } as never));
  assert.throws(() => vault.put("capability", { id: "collection", operationType: "collection", level: "L1", revision: 1, updatedAt: 1 }));
  (attribute.provenance as unknown as { verification: string }).verification = "verified";
  await assert.rejects(vault.save(), /invalid provenance/);
});

test("approval deduplicates identical consequences but changed amounts and interruptions require a new decision", async () => {
  let prompts = 0, evidence = 0;
  const approvals = new ConsequenceApprovals("run", async () => { evidence++; });
  const identity = { actionId: "run", operation: "registration" as const, targetIds: ["fake"], scopeRevision: 1, policyVersion: 1, consequenceDigest: await consequenceDigest({ amount: 100, recipient: "fake", terms: 1 }) };
  const prompt = async () => { prompts++; return { approved: true }; };
  await approvals.decide(identity, prompt);
  await approvals.decide(identity, prompt);
  assert.equal(prompts, 1); assert.equal(evidence, 1);
  await approvals.decide({ ...identity, consequenceDigest: await consequenceDigest({ amount: 200, recipient: "fake", terms: 1 }) }, prompt);
  assert.equal(prompts, 2);
  approvals.interrupt();
  await approvals.decide(identity, prompt);
  assert.equal(prompts, 3);
  await approvals.decide(identity, prompt, true);
  assert.equal(prompts, 4, "individual identity decisions are never reused");
});

test("failed approval evidence prevents consequential execution", async () => {
  const approvals = new ConsequenceApprovals("run", async () => { throw new Error("quota"); });
  let executed = false;
  await assert.rejects(async () => {
    await approvals.decide({ actionId: "run", operation: "withdrawal", targetIds: ["fake"], scopeRevision: 0, policyVersion: 1, consequenceDigest: await consequenceDigest("delete fake") }, async () => ({ approved: true }));
    executed = true;
  });
  assert.equal(executed, false);
});

async function hostFixture() {
  const persistence = memory();
  const session = new VaultSession({ persistence, kdfAlgo: "pbkdf2-sha512", lockManager: { tryAcquire: async () => ({ release() {} }) } });
  await session.start(); await session.create(passphrase);
  const host = new VisibilityHost({ session, leaseClient: { onInvalidated() {}, isLeaseActive: () => false, releaseLease: async () => {}, close() {} } as unknown as LeaseClient });
  const domain = new DomainService(session.vault);
  const site = domain.upsertSiteAccount({ id: "fake-site", domain: "example.test", displayName: "Fake" });
  return { persistence, session, host, domain, site };
}

test("canonical save failure restores the committed value and disclosure status", async () => {
  const { persistence, host, domain, site, session } = await hostFixture();
  try {
    await host.saveCanonicalAttribute({ attributeKey: "email", label: "Email", value: "old@example.test" });
    domain.addDisclosure({ siteAccountId: site.id, attributeKey: "email", siteHeldValue: "old@example.test", observedAt: 1, sourceKind: "profile-text", confidence: 1 });
    persistence.fail = true;
    await assert.rejects(host.saveCanonicalAttribute({ attributeKey: "email", label: "Email", value: "new@example.test" }));
    assert.equal(host.listCanonicalAttributes()[0]!.value, "old@example.test");
    assert.equal(domain.listDisclosures()[0]!.staleState, "current");
  } finally { session.close(); }
});

test("failed L1 expansion grants nothing; failed revocation blocks further execution until retry", async () => {
  const { persistence, host, site, session } = await hostFixture();
  try {
    persistence.fail = true;
    await assert.rejects(host.enableCollectionScope({ siteAccountIds: [site.id], attributeKeys: ["email"] }));
    assert.equal(new DomainService(session.vault).getCapability("collection"), undefined);
    persistence.fail = false;
    await host.enableCollectionScope({ siteAccountIds: [site.id], attributeKeys: ["email"] });
    persistence.fail = true;
    const saving = host.reduceCollectionScope();
    assert.equal(host.collectionCapability?.level, "L0", "immediate revocation precedes persistence");
    await assert.rejects(saving);
    await assert.rejects(host.run(site), /unsaved authorization/);
    persistence.fail = false;
    await host.retryAuthorizationSave();
    assert.equal(host.collectionCapability?.level, "L0");
  } finally { session.close(); }
});

test("a site outside the L1 scope still runs as an L0 collection reviewed by the 収集 gesture", async () => {
  const { host, domain, site, session } = await hostFixture();
  const other = domain.upsertSiteAccount({ id: "fake-other", domain: "other.example.test", displayName: "Other" });
  const opened: string[] = [];
  (host as unknown as { openSession: (s: { id: string }) => Promise<never> }).openSession = async (s) => {
    opened.push(s.id);
    throw new Error("fake session unavailable");
  };
  try {
    await host.enableCollectionScope({ siteAccountIds: [site.id], attributeKeys: ["email"] });
    await host.run(other).catch(() => undefined);
    assert.deepEqual(opened, [other.id]);
  } finally { session.close(); }
});
