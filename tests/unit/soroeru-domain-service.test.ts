import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainService } from "../../src/domain/domain-service.js";
import { MOST_SENSITIVE_ATTRIBUTE_KEY } from "../../src/domain/entities.js";
import { normalizedValueHash } from "../../src/domain/normalize.js";
import { FileVaultPersistence } from "../../src/store/file-vault-persistence.js";
import { VaultV2 } from "../../src/store/vault-v2.js";

const PASSPHRASE = "unit-test-passphrase";

async function openService(): Promise<{ dir: string; service: DomainService; vault: VaultV2 }> {
  const dir = await mkdtemp(join(tmpdir(), "soroeru-domain-"));
  const vault = await VaultV2.open(new FileVaultPersistence(join(dir, "vault.json")), PASSPHRASE);
  return { dir, service: new DomainService(vault), vault };
}

test("normalizeValue absorbs separators so equal values hash equally", () => {
  assert.equal(
    normalizedValueHash("phone.full", "090-1234-5678"),
    normalizedValueHash("phone.full", "09012345678"),
  );
  assert.equal(
    normalizedValueHash("email", "User@Example.test"),
    normalizedValueHash("email", "user@example.test"),
  );
  assert.notEqual(
    normalizedValueHash("email", "a@example.test"),
    normalizedValueHash("email", "b@example.test"),
  );
});

test("setPersonalAttribute uses the attribute key as id and defaults sensitivity", async () => {
  const { dir, service } = await openService();
  try {
    const cvv = service.setPersonalAttribute({
      attributeKey: MOST_SENSITIVE_ATTRIBUTE_KEY,
      label: "CVV",
      value: "123",
    });
    assert.equal(cvv.id, MOST_SENSITIVE_ATTRIBUTE_KEY);
    assert.equal(cvv.sensitivity, "most-sensitive");
    const email = service.setPersonalAttribute({
      attributeKey: "email",
      label: "メール",
      value: "u@example.test",
    });
    assert.equal(email.sensitivity, "normal");
    assert.equal(service.getPersonalAttribute("email")?.value, "u@example.test");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("site accounts receive stable append-only manual sort orders", async () => {
  const { dir, service } = await openService();
  try {
    const first = service.upsertSiteAccount({ id: "first", domain: "z.test", displayName: "Z" });
    const second = service.upsertSiteAccount({ id: "second", domain: "a.test", displayName: "A" });
    const updated = service.upsertSiteAccount({ id: first.id, domain: "z.test", displayName: "Zed" });

    assert.equal(first.sortOrder, 0);
    assert.equal(second.sortOrder, 1);
    assert.equal(updated.sortOrder, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy site accounts migrate from display-name order and reorder atomically", async () => {
  const { dir, service, vault } = await openService();
  try {
    vault.put("siteAccount", { id: "z", domain: "z.test", displayName: "Zulu", createdAt: 1, updatedAt: 1 });
    vault.put("siteAccount", { id: "a", domain: "a.test", displayName: "Alpha", createdAt: 2, updatedAt: 2 });

    assert.equal(service.ensureSiteAccountSortOrders(), true);
    assert.deepEqual(
      service.listSiteAccountsInManualOrder().map((site) => [site.id, site.sortOrder]),
      [
        ["a", 0],
        ["z", 1],
      ],
    );
    assert.deepEqual(service.reorderSiteAccounts(["z", "a"]), { ok: true });
    assert.deepEqual(
      service.listSiteAccountsInManualOrder().map((site) => site.id),
      ["z", "a"],
    );

    assert.deepEqual(service.reorderSiteAccounts(["a"]), { ok: false, error: "invalid-order" });
    assert.deepEqual(
      service.listSiteAccountsInManualOrder().map((site) => site.id),
      ["z", "a"],
    );
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

test("addDisclosure aggregates repeated observations of the same site-held value", async () => {
  const { dir, service } = await openService();
  try {
    const site = service.upsertSiteAccount({ domain: "example.com", displayName: "Example" });

    const first = service.addDisclosure({
      siteAccountId: site.id,
      attributeKey: "account.id",
      siteHeldValue: "user@example.test",
      observedAt: 100,
      sourceKind: "form-field",
      confidence: 0.7,
      sourcePageUrl: "https://example.com/login",
      evidenceIds: ["evidence-1"],
    });
    const repeated = service.addDisclosure({
      siteAccountId: site.id,
      attributeKey: "account.id",
      siteHeldValue: "user@example.test",
      observedAt: 200,
      sourceKind: "profile-text",
      confidence: 0.9,
      sourcePageUrl: "https://example.com/profile",
      evidenceIds: ["evidence-1", "evidence-2"],
    });
    const outOfOrder = service.addDisclosure({
      siteAccountId: site.id,
      attributeKey: "account.id",
      siteHeldValue: "user@example.test",
      observedAt: 150,
      sourceKind: "user-confirmed",
      confidence: 1,
      sourcePageUrl: "https://example.com/older-observation",
      evidenceIds: ["evidence-3"],
    });

    assert.equal(repeated.id, first.id);
    assert.equal(outOfOrder.observedAt, 200);
    assert.equal(outOfOrder.sourceKind, "profile-text");
    assert.equal(outOfOrder.confidence, 0.9);
    assert.equal(outOfOrder.sourcePageUrl, "https://example.com/profile");
    assert.deepEqual(outOfOrder.evidenceIds, ["evidence-1", "evidence-2", "evidence-3"]);
    assert.equal(service.listDisclosuresForSite(site.id).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("addDisclosure preserves changed site-held values as separate history rows", async () => {
  const { dir, service } = await openService();
  try {
    const site = service.upsertSiteAccount({ domain: "example.com", displayName: "Example" });

    const previous = service.addDisclosure({
      siteAccountId: site.id,
      attributeKey: "account.id",
      siteHeldValue: "previous@example.test",
      sourceKind: "form-field",
    });
    const changed = service.addDisclosure({
      siteAccountId: site.id,
      attributeKey: "account.id",
      siteHeldValue: "changed@example.test",
      sourceKind: "form-field",
    });

    assert.notEqual(changed.id, previous.id);
    assert.equal(service.listDisclosuresForSite(site.id).length, 2);
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
    const site = service.upsertSiteAccount({
      domain: "ex.com",
      displayName: "Ex",
      url: "https://ex.com/login",
    });
    service.addCredential({
      siteAccountId: site.id,
      username: "user",
      password: "fake-pass",
      source: "csv-import",
    });
    service.addDisclosure({
      siteAccountId: site.id,
      attributeKey: "email",
      siteHeldValue: "u@ex.test",
      sourceKind: "form-field",
    });
    assert.equal(service.listCredentialsForSite(site.id).length, 1);
    assert.equal(service.listDisclosuresForSite(site.id).length, 1);
    assert.equal(service.getSiteAccount(site.id)?.url, "https://ex.com/login");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("updateCredential overwrites password and username without leaving the old secret", async () => {
  const { dir, service } = await openService();
  try {
    const site = service.upsertSiteAccount({ domain: "ex.com", displayName: "Ex" });
    const created = service.addCredential({
      siteAccountId: site.id,
      username: "old-user",
      password: "old-secret-pass",
      source: "csv-import",
    });
    const before = created.updatedAt;

    const updated = service.updateCredential({
      credentialId: created.id,
      username: "  new-user  ",
      password: "new-secret-pass",
    });
    assert.equal(updated.ok, true);
    if (!updated.ok) return;
    assert.equal(updated.credential.username, "new-user");
    assert.equal(updated.credential.password, "new-secret-pass");
    assert.equal(updated.credential.source, "user");
    assert.ok(updated.credential.updatedAt >= before);

    // Visibility picks listCredentialsForSite(...)[0] — must see the new secret.
    const listed = service.listCredentialsForSite(site.id);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.password, "new-secret-pass");
    assert.equal(listed[0]?.username, "new-user");
    assert.equal(service.getCredential(created.id)?.password, "new-secret-pass");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("markSiteCredentialsPasswordStale flags passwords and updateCredential clears the flag (Issue #416)", async () => {
  const { dir, service } = await openService();
  try {
    const site = service.upsertSiteAccount({ domain: "reset.example.test", displayName: "Reset" });
    const other = service.upsertSiteAccount({ domain: "other.example.test", displayName: "Other" });
    const primary = service.addCredential({
      siteAccountId: site.id,
      username: "user@example.test",
      password: "old-pass",
      source: "csv-import",
    });
    service.addCredential({
      siteAccountId: other.id,
      username: "other@example.test",
      password: "other-pass",
      source: "csv-import",
    });

    const marked = service.markSiteCredentialsPasswordStale(site.id, 1_700_000_000_000);
    assert.equal(marked.length, 1);
    assert.equal(marked[0]?.id, primary.id);
    assert.equal(marked[0]?.passwordStale, true);
    assert.equal(marked[0]?.password, "old-pass");
    assert.equal(marked[0]?.source, "csv-import");
    assert.equal(marked[0]?.updatedAt, 1_700_000_000_000);
    // Other sites are untouched.
    assert.equal(service.listCredentialsForSite(other.id)[0]?.passwordStale, undefined);

    // Idempotent: already-stale rows are returned without rewriting source/password.
    const again = service.markSiteCredentialsPasswordStale(site.id, 1_700_000_000_100);
    assert.equal(again.length, 1);
    assert.equal(again[0]?.passwordStale, true);
    assert.equal(again[0]?.updatedAt, 1_700_000_000_000);

    const usernameOnly = service.updateCredential({
      credentialId: primary.id,
      username: "new-user@example.test",
    });
    assert.equal(usernameOnly.ok, true);
    if (usernameOnly.ok) {
      // Username-only edit keeps the stale signal — password was not replaced.
      assert.equal(usernameOnly.credential.passwordStale, true);
    }

    const passwordUpdate = service.updateCredential({
      credentialId: primary.id,
      password: "new-pass-after-reset",
    });
    assert.equal(passwordUpdate.ok, true);
    if (passwordUpdate.ok) {
      assert.equal(passwordUpdate.credential.password, "new-pass-after-reset");
      assert.equal(passwordUpdate.credential.passwordStale, undefined);
    }
    assert.equal(service.getCredential(primary.id)?.passwordStale, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("updateCredential rejects empty changes and missing ids", async () => {
  const { dir, service } = await openService();
  try {
    const site = service.upsertSiteAccount({ domain: "ex.com", displayName: "Ex" });
    const created = service.addCredential({
      siteAccountId: site.id,
      username: "user",
      password: "fake-pass",
      source: "csv-import",
    });

    assert.deepEqual(service.updateCredential({ credentialId: "missing" }), {
      ok: false,
      error: "not-found",
    });
    assert.deepEqual(service.updateCredential({ credentialId: created.id }), {
      ok: false,
      error: "invalid-request",
    });
    assert.deepEqual(service.updateCredential({ credentialId: created.id, username: "   ", password: "" }), {
      ok: false,
      error: "invalid-request",
    });
    // Same username with no password is a no-op, not a source flip.
    assert.deepEqual(service.updateCredential({ credentialId: created.id, username: "user" }), {
      ok: false,
      error: "invalid-request",
    });
    assert.deepEqual(service.updateCredential({ credentialId: created.id, password: "   " }), {
      ok: false,
      error: "invalid-request",
    });
    assert.equal(service.getCredential(created.id)?.source, "csv-import");
    assert.equal(service.getCredential(created.id)?.password, "fake-pass");
    // Unchanged password field alone with blank username is invalid; password-only works.
    const passwordOnly = service.updateCredential({ credentialId: created.id, password: "only-new-pass" });
    assert.equal(passwordOnly.ok, true);
    if (passwordOnly.ok) assert.equal(passwordOnly.credential.password, "only-new-pass");
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

    service.addCredential({
      siteAccountId: site.id,
      username: "user",
      password: "fake-pass",
      source: "csv-import",
    });
    service.addCredential({
      siteAccountId: other.id,
      username: "other",
      password: "fake-pass-2",
      source: "csv-import",
    });
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
    service.addConstraint({
      siteAccountId: other.id,
      kind: "wall",
      detail: "MFA",
      evidenceIds: [otherEvidence.id],
    });
    vault.put("mandate", {
      id: "site-mandate",
      siteAccountId: site.id,
      operation: "collection",
      authorizedAt: 1,
    });
    vault.put("mandate", {
      id: "other-mandate",
      siteAccountId: other.id,
      operation: "collection",
      authorizedAt: 1,
    });
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
    assert.equal(
      service.listConstraints().some((constraint) => constraint.siteAccountId === site.id),
      false,
    );
    assert.equal(
      service.listEvidence().some((evidence) => evidence.id === siteEvidence.id),
      false,
    );
    assert.equal(
      service.listEvidence().some((evidence) => evidence.id === sharedEvidence.id),
      false,
    );

    assert.equal(service.getSiteAccount(other.id)?.displayName, "Kept");
    assert.equal(service.listCredentialsForSite(other.id).length, 1);
    assert.equal(service.listDisclosuresForSite(other.id).length, 1);
    assert.equal(service.listAccountRelationshipsForSite(other.id).length, 1);
    assert.equal(
      service.listConstraints().filter((constraint) => constraint.siteAccountId === other.id).length,
      1,
    );
    assert.equal(
      service.listEvidence().some((evidence) => evidence.id === otherEvidence.id),
      true,
    );
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
    service.addCredential({
      siteAccountId: site.id,
      username: "user",
      password: "fake-pass",
      source: "csv-import",
    });

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
    const vault = await VaultV2.open(new FileVaultPersistence(path), PASSPHRASE);
    const service = new DomainService(vault);
    const site = service.upsertSiteAccount({ domain: "example.test", displayName: "Example" });
    service.setSessionPersistenceEnabled(site.id, true);
    service.savePersistedSessionState({
      siteAccountId: site.id,
      storageState: '{"cookies":[],"origins":[]}',
    });
    await vault.save();
    vault.lock();

    const reopened = await VaultV2.open(new FileVaultPersistence(path), PASSPHRASE);
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
    assert.ok(
      service.getPersistedSessionState(site.id, stillValidAt),
      "peek must not have discarded the record",
    );
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
    const refreshed = service.savePersistedSessionState({
      siteAccountId: site.id,
      storageState: "{}",
      now: later,
    });
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

for (const collectionTier of [
  undefined,
  "deterministic",
  "ai-driven",
] as const) {
  test(`CVV storage and comparison follow explicit tier: ${collectionTier ?? "legacy"}`, async () => {
    const { dir, service, vault } = await openService();
    try {
      service.setPersonalAttribute({
        attributeKey: "card.cvv",
        label: "CVV",
        value: "123",
      });
      const row = service.addDisclosure({
        siteAccountId: "fake-site",
        attributeKey: "card.cvv",
        siteHeldValue: "123",
        normalizedValueHash: normalizedValueHash("card.cvv", "123"),
        sourceKind: "billing-page",
        collectionTier,
      });
      const allowed = collectionTier === "ai-driven";
      assert.equal(row.siteHeldValue, allowed ? "123" : undefined);
      assert.equal(
        row.normalizedValueHash,
        allowed ? normalizedValueHash("card.cvv", "123") : undefined,
      );
      assert.equal(row.staleState, allowed ? "current" : "unknown");
      const hashOnly = service.addDisclosure({
        siteAccountId: "another-fake-site",
        attributeKey: "card.cvv",
        normalizedValueHash: normalizedValueHash("card.cvv", "123"),
        sourceKind: "billing-page",
        collectionTier,
      });
      assert.equal(hashOnly.staleState, allowed ? "current" : "unknown");
      service.setPersonalAttribute({
        attributeKey: "card.cvv",
        label: "CVV",
        value: "456",
      });
      assert.equal(
        service.getDisclosure(row.id)?.staleState,
        allowed ? "stale" : "unknown",
      );
      await vault.save();
      vault.lock();
      const reopened = await VaultV2.open(new FileVaultPersistence(join(dir, "vault.json")), PASSPHRASE);
      assert.equal(
        reopened.get("disclosure", row.id)?.siteHeldValue,
        allowed ? "123" : undefined,
      );
      reopened.lock();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("full PAN comparisons survive reload, distinguish same suffix, and retain deterministic semantics", async () => {
  const { dir, service, vault } = await openService();
  try {
    service.setPersonalAttribute({
      attributeKey: "card.number",
      label: "Card",
      value: "4111111111111234",
    });
    const input = {
      siteAccountId: "fake-site",
      attributeKey: "card.number",
      siteHeldValue: "4111 1111 1111 1234",
      sourceKind: "billing-page" as const,
    };
    const ai = service.addDisclosure({ ...input, collectionTier: "ai-driven" });
    const deterministic = service.addDisclosure(input);
    assert.equal(ai.siteHeldValue, input.siteHeldValue);
    assert.equal(ai.staleState, "current");
    assert.equal(deterministic.siteHeldValue, "1234");
    assert.notEqual(ai.id, deterministic.id);
    assert.equal(
      service.addDisclosure({
        ...input,
        collectionTier: "ai-driven",
        observedAt: ai.observedAt + 1,
      }).id,
      ai.id,
    );
    await vault.save();
    vault.lock();
    const reopened = await VaultV2.open(new FileVaultPersistence(join(dir, "vault.json")), PASSPHRASE);
    const next = new DomainService(reopened);
    next.setPersonalAttribute({
      attributeKey: "card.number",
      label: "Card",
      value: "5555555555551234",
    });
    assert.equal(next.getDisclosure(ai.id)?.staleState, "stale");
    assert.equal(next.getDisclosure(deterministic.id)?.staleState, "current");
    const other = next.addDisclosure({
      ...input,
      siteHeldValue: "5555-5555-5555-1234",
      collectionTier: "ai-driven",
    });
    assert.notEqual(other.id, ai.id);
    assert.equal(other.staleState, "current");
    reopened.lock();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("saveCheckpoint strips query and fragment from resumeData.url and discardCheckpoint removes it", async () => {
  const { dir, service } = await openService();
  try {
    const checkpoint = service.saveCheckpoint({
      workflow: "visibility",
      siteAccountId: "site-1",
      step: "login",
      status: "in-progress",
      resumeData: { url: "https://example.test/account/profile?token=fake#frag", pages: 2 },
    });
    assert.equal(checkpoint.resumeData?.url, "https://example.test/account/profile");
    assert.equal(checkpoint.resumeData?.pages, 2);
    const invalid = service.saveCheckpoint({
      workflow: "visibility",
      siteAccountId: "site-2",
      step: "login",
      status: "in-progress",
      resumeData: { url: "not a url?x=1" },
    });
    assert.equal(invalid.resumeData?.url, undefined);
    service.discardCheckpoint("visibility", "site-1");
    assert.equal(service.getCheckpoint("visibility", "site-1"), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
