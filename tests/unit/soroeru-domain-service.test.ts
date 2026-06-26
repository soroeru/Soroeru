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
