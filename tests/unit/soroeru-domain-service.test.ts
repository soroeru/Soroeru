import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainService } from "../../src/domain/domain-service.js";
import { MOST_SENSITIVE_ATTRIBUTE_KEY } from "../../src/domain/entities.js";
import { normalizedValueHash } from "../../src/domain/normalize.js";
import { VaultV2 } from "../../src/store/vault-v2.js";

const PASSPHRASE = "unit-test-passphrase";

async function openService(): Promise<{ dir: string; service: DomainService; vault: VaultV2 }> {
  const dir = await mkdtemp(join(tmpdir(), "soroeru-domain-"));
  const vault = await VaultV2.open(join(dir, "vault.json"), PASSPHRASE);
  return { dir, service: new DomainService(vault), vault };
}

test("normalizeValue absorbs separators so equal values hash equally", () => {
  assert.equal(normalizedValueHash("phone.full", "090-1234-5678"), normalizedValueHash("phone.full", "09012345678"));
  assert.equal(normalizedValueHash("email", "User@Example.test"), normalizedValueHash("email", "user@example.test"));
  assert.notEqual(normalizedValueHash("email", "a@example.test"), normalizedValueHash("email", "b@example.test"));
});

test("setPersonalAttribute uses the attribute key as id and defaults sensitivity", async () => {
  const { dir, service } = await openService();
  try {
    const cvv = service.setPersonalAttribute({ attributeKey: MOST_SENSITIVE_ATTRIBUTE_KEY, label: "CVV", value: "123" });
    assert.equal(cvv.id, MOST_SENSITIVE_ATTRIBUTE_KEY);
    assert.equal(cvv.sensitivity, "most-sensitive");
    const email = service.setPersonalAttribute({ attributeKey: "email", label: "メール", value: "u@example.test" });
    assert.equal(email.sensitivity, "normal");
    assert.equal(service.getPersonalAttribute("email")?.value, "u@example.test");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("disclosure stale-state: current, stale, and unknown", async () => {
  const { dir, service } = await openService();
  try {
    const site = service.upsertSiteAccount({ domain: "example.com", displayName: "Example" });
    service.setPersonalAttribute({ attributeKey: "phone.full", label: "電話", value: "090-1234-5678" });

    // Matches canonical (after normalization) -> current.
    const current = service.addDisclosure({
      siteAccountId: site.id,
      attributeKey: "phone.full",
      siteHeldValue: "09012345678",
      sourceKind: "form-field",
    });
    assert.equal(current.staleState, "current");

    // Differs from canonical -> stale.
    const stale = service.addDisclosure({
      siteAccountId: site.id,
      attributeKey: "phone.full",
      siteHeldValue: "080-0000-0000",
      sourceKind: "profile-text",
    });
    assert.equal(stale.staleState, "stale");

    // No canonical attribute for this key -> unknown.
    const unknownAttr = service.addDisclosure({
      siteAccountId: site.id,
      attributeKey: "address.full",
      siteHeldValue: "東京都",
      sourceKind: "profile-text",
    });
    assert.equal(unknownAttr.staleState, "unknown");

    // No site-held value -> unknown.
    const unknownValue = service.addDisclosure({
      siteAccountId: site.id,
      attributeKey: "phone.full",
      sourceKind: "user-confirmed",
    });
    assert.equal(unknownValue.staleState, "unknown");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("addDisclosure centralizes collected card and cvv storage policy", async () => {
  const { dir, service } = await openService();
  try {
    const site = service.upsertSiteAccount({ domain: "billing.example.test", displayName: "Billing" });

    const card = service.addDisclosure({
      siteAccountId: site.id,
      attributeKey: "card.number",
      siteHeldValue: "4111 1111 1111 1234",
      sourceKind: "billing-page",
    });
    assert.equal(card.siteHeldValue, "1234");
    assert.equal(card.normalizedValueHash, normalizedValueHash("card.number", "1234"));
    assert.notEqual(card.normalizedValueHash, normalizedValueHash("card.number", "4111 1111 1111 1234"));

    const cvv = service.addDisclosure({
      siteAccountId: site.id,
      attributeKey: "card.cvv",
      siteHeldValue: "999",
      normalizedValueHash: normalizedValueHash("card.cvv", "999"),
      sourceKind: "billing-page",
    });
    assert.equal(cvv.siteHeldValue, undefined);
    assert.equal(cvv.normalizedValueHash, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("card disclosure stale-state compares last 4 digits against the canonical card", async () => {
  const { dir, service } = await openService();
  try {
    const site = service.upsertSiteAccount({ domain: "billing.example.test", displayName: "Billing" });
    service.setPersonalAttribute({
      attributeKey: "card.number",
      label: "カード番号",
      value: "4111111111111234",
      valueType: "card",
      sensitivity: "sensitive",
    });

    const current = service.addDisclosure({
      siteAccountId: site.id,
      attributeKey: "card.number",
      siteHeldValue: "4111 1111 1111 1234",
      sourceKind: "billing-page",
    });
    const stale = service.addDisclosure({
      siteAccountId: site.id,
      attributeKey: "card.number",
      siteHeldValue: "4111 1111 1111 9999",
      sourceKind: "billing-page",
    });

    assert.equal(current.staleState, "current");
    assert.equal(stale.staleState, "stale");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("changing a canonical attribute recomputes stale-state of its disclosures", async () => {
  const { dir, service } = await openService();
  try {
    const site = service.upsertSiteAccount({ domain: "example.com", displayName: "Example" });
    service.setPersonalAttribute({ attributeKey: "email", label: "メール", value: "old@example.test" });
    const disclosure = service.addDisclosure({
      siteAccountId: site.id,
      attributeKey: "email",
      siteHeldValue: "old@example.test",
      sourceKind: "form-field",
    });
    assert.equal(disclosure.staleState, "current");

    // The user updates their canonical email; the existing disclosure is now stale.
    service.setPersonalAttribute({ attributeKey: "email", label: "メール", value: "new@example.test" });
    assert.equal(service.getDisclosure(disclosure.id)?.staleState, "stale");

    // recomputeAllStaleStates is idempotent once derived.
    assert.equal(service.recomputeAllStaleStates(), 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("credentials and disclosures are queryable per site", async () => {
  const { dir, service } = await openService();
  try {
    const site = service.upsertSiteAccount({ domain: "ex.com", displayName: "Ex", url: "https://ex.com/login" });
    service.addCredential({ siteAccountId: site.id, username: "user", password: "fake-pass", source: "csv-import" });
    service.addDisclosure({ siteAccountId: site.id, attributeKey: "email", siteHeldValue: "u@ex.test", sourceKind: "form-field" });
    assert.equal(service.listCredentialsForSite(site.id).length, 1);
    assert.equal(service.listDisclosuresForSite(site.id).length, 1);
    assert.equal(service.getSiteAccount(site.id)?.url, "https://ex.com/login");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("deleteSiteAccount cascades the Soroeru-internal site records without touching other sites", async () => {
  const { dir, service, vault } = await openService();
  try {
    const site = service.upsertSiteAccount({ domain: "gone.example.test", displayName: "Gone" });
    const other = service.upsertSiteAccount({ domain: "kept.example.test", displayName: "Kept" });
    const siteEvidence = service.addEvidence({
      siteAccountId: site.id,
      pageUrl: "https://gone.example.test/account",
      maskedSnippet: "••••",
    });
    const sharedEvidence = service.addEvidence({
      pageUrl: "https://gone.example.test/terms",
      maskedSnippet: "terms hash only",
    });
    const otherEvidence = service.addEvidence({
      siteAccountId: other.id,
      pageUrl: "https://kept.example.test/account",
      maskedSnippet: "••••",
    });

    service.addCredential({ siteAccountId: site.id, username: "user", password: "fake-pass", source: "csv-import" });
    service.addCredential({ siteAccountId: other.id, username: "other", password: "fake-pass-2", source: "csv-import" });
    service.addDisclosure({
      siteAccountId: site.id,
      attributeKey: "email",
      siteHeldValue: "old@example.test",
      sourceKind: "form-field",
      evidenceIds: [siteEvidence.id, sharedEvidence.id],
    });
    service.addDisclosure({
      siteAccountId: other.id,
      attributeKey: "email",
      siteHeldValue: "kept@example.test",
      sourceKind: "form-field",
      evidenceIds: [otherEvidence.id],
    });
    service.addAccountRelationship({
      siteAccountId: site.id,
      kind: "newsletter",
      state: "active",
      evidenceIds: [siteEvidence.id],
    });
    service.addAccountRelationship({
      siteAccountId: other.id,
      kind: "newsletter",
      state: "active",
      evidenceIds: [otherEvidence.id],
    });
    service.addConstraint({
      siteAccountId: site.id,
      kind: "unknown-state",
      detail: "site disappeared",
      evidenceIds: [sharedEvidence.id],
    });
    service.addConstraint({ siteAccountId: other.id, kind: "wall", detail: "MFA", evidenceIds: [otherEvidence.id] });
    vault.put("mandate", { id: "site-mandate", siteAccountId: site.id, operation: "collection", authorizedAt: 1 });
    vault.put("mandate", { id: "other-mandate", siteAccountId: other.id, operation: "collection", authorizedAt: 1 });
    vault.put("mandate", { id: "global-mandate", operation: "policy-expansion", authorizedAt: 1 });

    const result = service.deleteSiteAccount(site.id);

    assert.deepEqual(result, {
      ok: true,
      deleted: {
        siteAccounts: 1,
        credentials: 1,
        disclosures: 1,
        evidence: 2,
        accountRelationships: 1,
        constraints: 1,
        mandates: 1,
      },
    });
    assert.equal(service.getSiteAccount(site.id), undefined);
    assert.equal(service.listCredentialsForSite(site.id).length, 0);
    assert.equal(service.listDisclosuresForSite(site.id).length, 0);
    assert.equal(service.listAccountRelationshipsForSite(site.id).length, 0);
    assert.equal(service.listConstraints().some((constraint) => constraint.siteAccountId === site.id), false);
    assert.equal(service.listEvidence().some((evidence) => evidence.id === siteEvidence.id), false);
    assert.equal(service.listEvidence().some((evidence) => evidence.id === sharedEvidence.id), false);

    assert.equal(service.getSiteAccount(other.id)?.displayName, "Kept");
    assert.equal(service.listCredentialsForSite(other.id).length, 1);
    assert.equal(service.listDisclosuresForSite(other.id).length, 1);
    assert.equal(service.listAccountRelationshipsForSite(other.id).length, 1);
    assert.equal(service.listConstraints().filter((constraint) => constraint.siteAccountId === other.id).length, 1);
    assert.equal(service.listEvidence().some((evidence) => evidence.id === otherEvidence.id), true);
    assert.equal(vault.get("mandate", "site-mandate"), undefined);
    assert.equal(vault.get("mandate", "other-mandate")?.siteAccountId, other.id);
    assert.equal(vault.get("mandate", "global-mandate")?.operation, "policy-expansion");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("deleteSiteAccount reports not-found without deleting anything", async () => {
  const { dir, service } = await openService();
  try {
    const site = service.upsertSiteAccount({ domain: "kept.example.test", displayName: "Kept" });
    service.addCredential({ siteAccountId: site.id, username: "user", password: "fake-pass", source: "csv-import" });

    assert.deepEqual(service.deleteSiteAccount("missing-site"), { ok: false, error: "not-found" });
    assert.equal(service.getSiteAccount(site.id)?.displayName, "Kept");
    assert.equal(service.listCredentialsForSite(site.id).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
