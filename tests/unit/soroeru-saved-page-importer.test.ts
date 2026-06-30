import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
    const email = domain.listDisclosuresForSite(siteAccount.id).find((disclosure) => disclosure.attributeKey === "email");
    assert.equal(email?.normalizedValueHash, normalizedValueHash("email", "original@example.test"));
    assert.notEqual(email?.normalizedValueHash, normalizedValueHash("email", "mutated@example.test"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
