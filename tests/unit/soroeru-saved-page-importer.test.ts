import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { importSavedPage } from "../../src/automation/saved-page-importer.js";
import { DomainService } from "../../src/domain/domain-service.js";
import { normalizedValueHash } from "../../src/domain/normalize.js";
import { VaultV2 } from "../../src/store/vault-v2.js";

const PASSPHRASE = "saved-page-importer-test-passphrase";

async function tmpVaultPath(): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "soroeru-saved-page-importer-"));
  return { dir, path: join(dir, "vault.json") };
}

test("saved page import ignores inline scripts before collecting values", async () => {
  const { dir, path } = await tmpVaultPath();
  try {
    const vault = await VaultV2.open(path, PASSPHRASE);
    const domain = new DomainService(vault);
    const siteAccount = domain.upsertSiteAccount({
      domain: "example.test",
      url: "https://example.test/account",
      displayName: "Example",
    });
    const html = [
      "<!doctype html><html><body>",
      '<label for="email">メールアドレス</label>',
      '<input id="email" name="email" autocomplete="email" value="original@example.test">',
      "<script>document.getElementById('email').value = 'mutated@example.test';</script>",
      "</body></html>",
    ].join("");

    const result = await importSavedPage({
      domain,
      siteAccount,
      fileName: "account.html",
      data: new TextEncoder().encode(html),
      now: () => 1_700_000_000_000,
    });

    assert.equal(result.disclosures, 1);
    const email = domain
      .listDisclosuresForSite(siteAccount.id)
      .find((disclosure) => disclosure.attributeKey === "email");
    assert.equal(email?.normalizedValueHash, normalizedValueHash("email", "original@example.test"));
    assert.notEqual(email?.normalizedValueHash, normalizedValueHash("email", "mutated@example.test"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("saved page import saves a done checkpoint when only a dynamic-attribute candidate is found", async () => {
  const { dir, path } = await tmpVaultPath();
  try {
    const vault = await VaultV2.open(path, PASSPHRASE);
    const domain = new DomainService(vault);
    const siteAccount = domain.upsertSiteAccount({
      domain: "unknownfield.example.test",
      url: "https://unknownfield.example.test/account",
      displayName: "UnknownField",
    });
    const html = [
      "<!doctype html><html><body>",
      '<label for="occupation">職業</label>',
      '<input id="occupation" name="occupation" required value="会社員">',
      "</body></html>",
    ].join("");

    const result = await importSavedPage({
      domain,
      siteAccount,
      fileName: "account.html",
      data: new TextEncoder().encode(html),
      now: () => 1_700_000_000_000,
    });

    assert.equal(result.disclosures, 0);
    assert.equal(domain.getCheckpoint("visibility", siteAccount.id)?.status, "done");
    const candidate = domain.listDynamicAttributeCandidates()[0];
    assert.equal(candidate?.label, "職業");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("saved page import collects disclosures from 住所_fixture.html", async () => {
  const { dir, path } = await tmpVaultPath();
  try {
    const vault = await VaultV2.open(path, PASSPHRASE);
    const domain = new DomainService(vault);
    const siteAccount = domain.upsertSiteAccount({
      domain: "yoyostorerewind.com",
      url: "https://yoyostorerewind.com/account/addresses",
      displayName: "Rewind",
    });

    const fileData = await readFile("tests/fixtures/住所_fixture.html");
    const result = await importSavedPage({
      domain,
      siteAccount,
      fileName: "住所_fixture.html",
      data: fileData,
      now: () => 1_700_000_000_000,
    });

    // It should collect disclosures (including address and potentially others)
    assert.ok(result.disclosures > 0, `Expected some disclosures, got ${result.disclosures}`);
    const disclosures = domain.listDisclosuresForSite(siteAccount.id);
    const address = disclosures.find((d) => d.attributeKey === "address.full");
    assert.ok(address, "Expected address.full disclosure to be collected");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
