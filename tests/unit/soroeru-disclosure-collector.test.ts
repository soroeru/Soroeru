import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectDisclosures } from "../../src/automation/disclosure-collector.js";
import { DomainService } from "../../src/domain/domain-service.js";
import { FileVaultPersistence } from "../../src/store/file-vault-persistence.js";
import { VaultV2 } from "../../src/store/vault-v2.js";
import type { FormField, PageSnapshot } from "../../src/types.js";

const PASSPHRASE = "collector-test-passphrase";

test("disclosure collector records manual-import disclosures and skips empty template fields", async () => {
  const dir = await mkdtemp(join(tmpdir(), "soroeru-collector-"));
  try {
    const vault = await VaultV2.open(new FileVaultPersistence(join(dir, "vault.json")), PASSPHRASE);
    const domain = new DomainService(vault);
    const site = domain.upsertSiteAccount({
      domain: "shop.example.test",
      url: "https://shop.example.test/account",
      displayName: "Shop",
    });

    const fields = [
      field("zip", { name: "address[zip]" }),
      field("city", { name: "address[city]" }),
      field("empty", { name: "address-[zip]" }),
      field("unknown-empty", { required: true }),
    ];
    const result = collectDisclosures({
      domain,
      siteAccount: site,
      snapshot: snapshot(fields),
      fields,
      values: {
        zip: "100-0001",
        city: "千代田区",
        empty: "",
        "unknown-empty": "",
      },
      sourceKind: "manual-import",
      now: () => 1_700_000_000_000,
    });

    assert.equal(result.disclosures, 2);
    const disclosures = domain.listDisclosuresForSite(site.id);
    assert.equal(disclosures.length, 2);
    assert.ok(disclosures.every((disclosure) => disclosure.sourceKind === "manual-import"));
    assert.equal(disclosures.find((disclosure) => disclosure.attributeKey === "postal.full")?.siteHeldValue, "100-0001");
    assert.equal(disclosures.find((disclosure) => disclosure.attributeKey === "address.city")?.siteHeldValue, "千代田区");
    assert.equal(disclosures.find((disclosure) => disclosure.attributeKey === "postal.full")?.sourcePageUrl, "https://shop.example.test/account");

    const evidenceJson = JSON.stringify(domain.listEvidence());
    assert.equal(evidenceJson.includes("100-0001"), false);
    assert.equal(evidenceJson.includes("千代田区"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("disclosure collector stores revealable values while reducing card numbers and excluding cvv", async () => {
  const dir = await mkdtemp(join(tmpdir(), "soroeru-collector-"));
  try {
    const vault = await VaultV2.open(new FileVaultPersistence(join(dir, "vault.json")), PASSPHRASE);
    const domain = new DomainService(vault);
    const site = domain.upsertSiteAccount({
      domain: "billing.example.test",
      url: "https://billing.example.test/account",
      displayName: "Billing",
    });

    const fields = [
      field("email", { autocomplete: "email", labels: ["メールアドレス"] }),
      field("card", { autocomplete: "cc-number", labels: ["カード番号"] }),
      field("cvv", { autocomplete: "cc-csc", labels: ["セキュリティコード"] }),
    ];
    const result = collectDisclosures({
      domain,
      siteAccount: site,
      snapshot: snapshot(fields),
      fields,
      values: {
        email: "member@example.test",
        card: "4111 1111 1111 1234",
        cvv: "999",
      },
      now: () => 1_700_000_000_000,
    });

    assert.equal(result.disclosures, 2);
    const disclosures = domain.listDisclosuresForSite(site.id);
    assert.equal(disclosures.find((disclosure) => disclosure.attributeKey === "email")?.siteHeldValue, "member@example.test");
    assert.equal(disclosures.find((disclosure) => disclosure.attributeKey === "card.number")?.siteHeldValue, "1234");
    assert.equal(disclosures.some((disclosure) => disclosure.attributeKey === "card.cvv"), false);

    const evidence = domain.listEvidence();
    assert.equal(JSON.stringify(disclosures.map((disclosure) => disclosure.siteHeldValue)).includes("4111"), false);
    assert.equal(JSON.stringify(disclosures.map((disclosure) => disclosure.siteHeldValue)).includes("999"), false);
    assert.equal(JSON.stringify(evidence.map((entry) => entry.maskedSnippet)).includes("4111"), false);
    assert.equal(JSON.stringify(evidence.map((entry) => entry.maskedSnippet)).includes("999"), false);
    assert.equal(evidence.some((entry) => entry.fieldLabel === "セキュリティコード"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("disclosure collector creates a labeled dynamic attribute candidate for unknown required values", async () => {
  const dir = await mkdtemp(join(tmpdir(), "soroeru-collector-"));
  try {
    const vault = await VaultV2.open(new FileVaultPersistence(join(dir, "vault.json")), PASSPHRASE);
    const domain = new DomainService(vault);
    const site = domain.upsertSiteAccount({
      domain: "profile.example.test",
      url: "https://profile.example.test/account",
      displayName: "Profile",
    });

    const fields = [field("occupation", { required: true, labels: ["職業"] })];
    const result = collectDisclosures({
      domain,
      siteAccount: site,
      snapshot: snapshot(fields),
      fields,
      values: { occupation: "会社員" },
      now: () => 1_700_000_000_000,
    });

    assert.equal(result.disclosures, 0);
    assert.equal(result.dynamicCandidates, 1);
    assert.equal(domain.listDisclosuresForSite(site.id).length, 0);

    const candidate = domain.listDynamicAttributeCandidates()[0];
    assert.equal(candidate?.status, "candidate");
    assert.equal(candidate?.label, "職業");
    // The label ("職業") has no ASCII letters, so the key is a stable hash of
    // the label rather than the field's id — see the slug-stability test below.
    assert.match(candidate?.proposedAttributeKey ?? "", /^custom\.field_[0-9a-z]+$/);
    assert.deepEqual(candidate?.matchTerms, ["職業"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("disclosure collector derives the dynamic-attribute key from the label, not the unstable field id/name", async () => {
  const dir = await mkdtemp(join(tmpdir(), "soroeru-collector-"));
  try {
    const vault = await VaultV2.open(new FileVaultPersistence(join(dir, "vault.json")), PASSPHRASE);
    const domain = new DomainService(vault);
    const site = domain.upsertSiteAccount({
      domain: "profile.example.test",
      url: "https://profile.example.test/account",
      displayName: "Profile",
    });

    // Simulates the same real-world field observed across two collection runs
    // where a framework assigns a different autogenerated id/name each time
    // (e.g. React/ASP.NET-style ids) but the human-visible label is stable.
    const firstRun = [field("f-a3x9k2", { required: true, name: "ctl00_field_a3x9k2", labels: ["職業"] })];
    collectDisclosures({
      domain,
      siteAccount: site,
      snapshot: snapshot(firstRun),
      fields: firstRun,
      values: { "f-a3x9k2": "会社員" },
      now: () => 1_700_000_000_000,
    });
    const secondRun = [field("f-q7z1m4", { required: true, name: "ctl00_field_q7z1m4", labels: ["職業"] })];
    collectDisclosures({
      domain,
      siteAccount: site,
      snapshot: snapshot(secondRun),
      fields: secondRun,
      values: { "f-q7z1m4": "会社員" },
      now: () => 1_700_000_100_000,
    });

    // Both runs must upsert the same candidate rather than creating two.
    assert.equal(domain.listDynamicAttributeCandidates().length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("disclosure collector keeps distinct labels that share an ASCII gloss as separate candidates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "soroeru-collector-"));
  try {
    const vault = await VaultV2.open(new FileVaultPersistence(join(dir, "vault.json")), PASSPHRASE);
    const domain = new DomainService(vault);
    const site = domain.upsertSiteAccount({
      domain: "profile.example.test",
      url: "https://profile.example.test/account",
      displayName: "Profile",
    });

    // Two genuinely different, unclassifiable fields that happen to share an
    // English gloss in parentheses must not collapse onto the same key just
    // because stripping non-ASCII characters would leave the same "info"
    // substring for both.
    const fields = [
      field("occupation", { required: true, labels: ["職業 (Info)"] }),
      field("hobby", { required: true, labels: ["趣味 (Info)"] }),
    ];
    collectDisclosures({
      domain,
      siteAccount: site,
      snapshot: snapshot(fields),
      fields,
      values: { occupation: "会社員", hobby: "読書" },
      now: () => 1_700_000_000_000,
    });

    const candidates = domain.listDynamicAttributeCandidates();
    assert.equal(candidates.length, 2);
    assert.notEqual(candidates[0]?.proposedAttributeKey, candidates[1]?.proposedAttributeKey);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("disclosure collector reuses confirmed dynamic attributes on later collections", async () => {
  const dir = await mkdtemp(join(tmpdir(), "soroeru-collector-"));
  try {
    const vault = await VaultV2.open(new FileVaultPersistence(join(dir, "vault.json")), PASSPHRASE);
    const domain = new DomainService(vault);
    const site = domain.upsertSiteAccount({
      domain: "profile.example.test",
      url: "https://profile.example.test/account",
      displayName: "Profile",
    });
    domain.confirmDynamicAttributeCandidate({
      label: "職業",
      attributeKey: "custom.occupation",
      matchTerms: ["職業"],
      now: () => 1_700_000_000_000,
    });

    const fields = [field("job", { required: true, labels: ["職業"] })];
    collectDisclosures({
      domain,
      siteAccount: site,
      snapshot: snapshot(fields),
      fields,
      values: { job: "会社員" },
      now: () => 1_700_000_000_000,
    });

    const disclosure = domain.listDisclosuresForSite(site.id)[0];
    assert.equal(disclosure?.attributeKey, "custom.occupation");
    assert.equal(disclosure?.siteHeldValue, "会社員");
    assert.equal(domain.listDynamicAttributeCandidates().filter((candidate) => candidate.status === "candidate").length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function snapshot(fields: FormField[]): PageSnapshot {
  return {
    url: "https://shop.example.test/account",
    title: "Account",
    fields,
    buttons: [],
    links: [],
    visibleText: "",
    iframeSrcs: [],
    wallMarkers: [],
  };
}

function field(fieldId: string, overrides: Partial<FormField>): FormField {
  return {
    fieldId,
    tag: "input",
    type: "text",
    name: "",
    id: fieldId,
    autocomplete: "",
    required: false,
    placeholder: "",
    labels: [],
    nearbyText: "",
    ...overrides,
  };
}
