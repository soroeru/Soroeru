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

// --- Session state (persisted storageState, Issue #294) ---

test("savePersistedSessionState round-trips through vault encryption and save/reload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "soroeru-domain-"));
  const path = join(dir, "vault.json");
  try {
    const vault = await VaultV2.open(path, PASSPHRASE);
    const service = new DomainService(vault);
    const site = service.upsertSiteAccount({ domain: "example.test", displayName: "Example" });
    service.setSessionPersistenceEnabled(site.id, true);
    service.savePersistedSessionState({ siteAccountId: site.id, storageState: '{"cookies":[],"origins":[]}' });
    await vault.save();
    vault.lock();

    const reopened = await VaultV2.open(path, PASSPHRASE);
    const reopenedService = new DomainService(reopened);
    const state = reopenedService.getPersistedSessionState(site.id);
    assert.equal(state?.storageState, '{"cookies":[],"origins":[]}');
    assert.equal(reopenedService.getSiteAccount(site.id)?.persistSessionEnabled, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("getPersistedSessionState treats an expired record as absent and discards it", async () => {
  const { dir, service } = await openService();
  try {
    const site = service.upsertSiteAccount({ domain: "example.test", displayName: "Example" });
    service.setSessionPersistenceEnabled(site.id, true);
    const now = Date.now();
    service.savePersistedSessionState({ siteAccountId: site.id, storageState: "{}", now });

    // Still valid just before the 30-day mark.
    assert.ok(service.getPersistedSessionState(site.id, now + 29 * 24 * 60 * 60 * 1000));
    // Expired at/after the 30-day mark: treated as absent and discarded.
    assert.equal(service.getPersistedSessionState(site.id, now + 30 * 24 * 60 * 60 * 1000 + 1), undefined);
    assert.equal(service.getPersistedSessionState(site.id), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("peekPersistedSessionState reports expiry without discarding the expired record (unlike getPersistedSessionState)", async () => {
  const { dir, service } = await openService();
  try {
    const site = service.upsertSiteAccount({ domain: "example.test", displayName: "Example" });
    service.setSessionPersistenceEnabled(site.id, true);
    const now = Date.now();
    service.savePersistedSessionState({ siteAccountId: site.id, storageState: "{}", now });
    const stillValidAt = now + 29 * 24 * 60 * 60 * 1000;
    const expiredAt = now + 30 * 24 * 60 * 60 * 1000 + 1;

    assert.ok(service.peekPersistedSessionState(site.id, stillValidAt));
    // Peeking past expiry reports absent but must not mutate the vault.
    assert.equal(service.peekPersistedSessionState(site.id, expiredAt), undefined);
    assert.ok(service.getPersistedSessionState(site.id, stillValidAt), "peek must not have discarded the record");
    // The mutating getPersistedSessionState does discard it once actually read as expired.
    assert.equal(service.getPersistedSessionState(site.id, expiredAt), undefined);
    assert.equal(service.getPersistedSessionState(site.id, stillValidAt), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("savePersistedSessionState slides expiresAt forward on every re-export", async () => {
  const { dir, service } = await openService();
  try {
    const site = service.upsertSiteAccount({ domain: "example.test", displayName: "Example" });
    service.setSessionPersistenceEnabled(site.id, true);
    const first = Date.now();
    service.savePersistedSessionState({ siteAccountId: site.id, storageState: "{}", now: first });
    const later = first + 10 * 24 * 60 * 60 * 1000;
    const refreshed = service.savePersistedSessionState({ siteAccountId: site.id, storageState: "{}", now: later });
    assert.equal(refreshed.expiresAt, later + 30 * 24 * 60 * 60 * 1000);
    assert.equal(refreshed.createdAt, first);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("setSessionPersistenceEnabled(false) unconditionally and immediately clears the persisted state", async () => {
  const { dir, service } = await openService();
  try {
    const site = service.upsertSiteAccount({ domain: "example.test", displayName: "Example" });
    service.setSessionPersistenceEnabled(site.id, true);
    service.savePersistedSessionState({ siteAccountId: site.id, storageState: "{}" });
    assert.ok(service.getPersistedSessionState(site.id));

    const updated = service.setSessionPersistenceEnabled(site.id, false);
    assert.equal(updated?.persistSessionEnabled, false);
    assert.equal(service.getPersistedSessionState(site.id), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("clearPersistedSessionState removes a session while persistence stays enabled", async () => {
  const { dir, service } = await openService();
  try {
    const site = service.upsertSiteAccount({ domain: "example.test", displayName: "Example" });
    service.setSessionPersistenceEnabled(site.id, true);
    service.savePersistedSessionState({ siteAccountId: site.id, storageState: "{}" });

    assert.equal(service.clearPersistedSessionState(site.id), true);
    assert.equal(service.getPersistedSessionState(site.id), undefined);
    assert.equal(service.getSiteAccount(site.id)?.persistSessionEnabled, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("deleteSiteAccount also removes any persisted session state for that site", async () => {
  const { dir, service } = await openService();
  try {
    const site = service.upsertSiteAccount({ domain: "example.test", displayName: "Example" });
    service.setSessionPersistenceEnabled(site.id, true);
    service.savePersistedSessionState({ siteAccountId: site.id, storageState: "{}" });

    assert.equal(service.deleteSiteAccount(site.id).ok, true);
    assert.equal(service.getPersistedSessionState(site.id), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Dynamic-attribute candidates (docs/design/visibility-exploration.md §5): a
// site-unit vs. global-unit view of the same candidate schema. Exploration
// Phase 4/5 can surface the same proposed key from more than one page on a
// site, or from more than one site, before the user confirms it (Issue #250).
test("recordDynamicAttributeCandidate merges observations of the same proposed key across sites", async () => {
  const { dir, service } = await openService();
  try {
    const siteA = service.upsertSiteAccount({ domain: "a.example.test", displayName: "A" });
    const siteB = service.upsertSiteAccount({ domain: "b.example.test", displayName: "B" });

    service.recordDynamicAttributeCandidate({
      siteAccountId: siteA.id,
      label: "職業",
      fieldId: "job-a",
      proposedAttributeKey: "custom.occupation",
      matchTerms: ["職業"],
      now: () => 1_700_000_000_000,
    });
    // A second page on the same site observes the identical field again: this
    // must not create a duplicate candidate.
    service.recordDynamicAttributeCandidate({
      siteAccountId: siteA.id,
      label: "職業",
      fieldId: "job-a-2",
      proposedAttributeKey: "custom.occupation",
      matchTerms: ["職業"],
      now: () => 1_700_000_100_000,
    });
    service.recordDynamicAttributeCandidate({
      siteAccountId: siteB.id,
      label: "ご職業",
      fieldId: "job-b",
      proposedAttributeKey: "custom.occupation",
      matchTerms: ["ご職業"],
      now: () => 1_700_000_200_000,
    });

    const candidates = service.listDynamicAttributeCandidates();
    assert.equal(candidates.length, 1);
    const candidate = candidates[0];
    assert.equal(candidate?.status, "candidate");
    assert.equal(candidate?.createdAt, 1_700_000_000_000);
    assert.equal(candidate?.updatedAt, 1_700_000_200_000);
    assert.deepEqual(new Set(candidate?.siteAccountIds), new Set([siteA.id, siteB.id]));
    assert.deepEqual(new Set(candidate?.matchTerms), new Set(["職業", "ご職業"]));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("deleteSiteAccount drops only the deleted site from a still-pending multi-site candidate", async () => {
  const { dir, service } = await openService();
  try {
    const siteA = service.upsertSiteAccount({ domain: "a.example.test", displayName: "A" });
    const siteB = service.upsertSiteAccount({ domain: "b.example.test", displayName: "B" });
    service.recordDynamicAttributeCandidate({
      siteAccountId: siteA.id,
      label: "職業",
      fieldId: "job-a",
      proposedAttributeKey: "custom.occupation",
    });
    service.recordDynamicAttributeCandidate({
      siteAccountId: siteB.id,
      label: "職業",
      fieldId: "job-b",
      proposedAttributeKey: "custom.occupation",
    });

    assert.equal(service.deleteSiteAccount(siteA.id).ok, true);

    const candidates = service.listDynamicAttributeCandidates();
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]?.status, "candidate");
    assert.deepEqual(candidates[0]?.siteAccountIds, [siteB.id]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("deleteSiteAccount removes a pending candidate entirely once its only observing site is gone", async () => {
  const { dir, service } = await openService();
  try {
    const site = service.upsertSiteAccount({ domain: "solo.example.test", displayName: "Solo" });
    service.recordDynamicAttributeCandidate({
      siteAccountId: site.id,
      label: "職業",
      fieldId: "job",
      proposedAttributeKey: "custom.occupation",
    });

    assert.equal(service.deleteSiteAccount(site.id).ok, true);

    assert.equal(service.listDynamicAttributeCandidates().length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("deleteSiteAccount never touches an already-confirmed (validated) dynamic attribute", async () => {
  const { dir, service } = await openService();
  try {
    const site = service.upsertSiteAccount({ domain: "solo.example.test", displayName: "Solo" });
    service.recordDynamicAttributeCandidate({
      siteAccountId: site.id,
      label: "職業",
      fieldId: "job",
      proposedAttributeKey: "custom.occupation",
    });
    service.confirmDynamicAttributeCandidate({
      label: "職業",
      attributeKey: "custom.occupation",
      matchTerms: ["職業"],
    });

    assert.equal(service.deleteSiteAccount(site.id).ok, true);

    const candidates = service.listDynamicAttributeCandidates();
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]?.status, "validated");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
