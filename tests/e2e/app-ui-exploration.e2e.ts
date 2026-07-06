// Electron app UI exploration E2E harness (Issue #251): the genuinely
// end-to-end complement to tests/unit/soroeru-exploration-collection.test.ts /
// soroeru-page-explorer.test.ts, which already verify multi-page collection
// and wall pause→resume against a FakePageDriver. This test drives the real
// Electron app's own UI (Issue #303's _electron.launch() pattern) through a
// real multi-page fixture site (sites/server.ts's /explore-flow/*) with a
// wall on one sub-page, proving the exploration + hand-off/resume wiring
// works through the real UI, real browser, and real vault — not a fake.
//
// Local-only (docs/testing.md): not wired into CI. Uses fake data only and
// the local PoC test-site server; no real site is touched. The headed
// automation browser Soroeru itself opens during collection is deliberately
// NOT driven here — same as tests/e2e/app-ui.e2e.ts.

import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { _electron, type ElectronApplication } from "playwright";
import { startPocServer } from "../../sites/server.js";
import { DomainService } from "../../src/domain/domain-service.js";
import { VaultV2 } from "../../src/store/vault-v2.js";

const PASSPHRASE = "app-ui-exploration-e2e-passphrase";
const SITE_NAME = "探索テスト商店";

// Must match the fixed fictional account in sites/server.ts's
// exploreFlowFixture() — that fixture has no /register endpoint, so the
// account is always already "registered".
const EXPLORE_FLOW_EMAIL = "explore-user@example.test";
const EXPLORE_FLOW_PASSWORD = "Explore-Fake-Passw0rd!";
const EXPLORE_FLOW_CARD_CVV = "321";
const EXPLORE_FLOW_CARD_NUMBER = "4111 1111 1111 5678";
const EXPLORE_FLOW_CARD_LAST4 = "5678";

test("Electron app UI: multi-page exploration collects from profile/address/payment, pausing and resuming on a wall", async (t) => {
  const stateRoot = resolve("state", "soroeru-poc", "e2e-app-ui-exploration", String(Date.now()));
  await mkdir(stateRoot, { recursive: true });

  const site = await startPocServer(0);
  let electronApp: ElectronApplication | undefined;
  try {
    const loginUrl = `${site.url}/explore-flow/login`;
    const csvPath = join(stateRoot, "import.csv");
    // Chrome Password Manager export shape; fake values only.
    await writeFile(
      csvPath,
      ["name,url,username,password,note", `${SITE_NAME},${loginUrl},${EXPLORE_FLOW_EMAIL},${EXPLORE_FLOW_PASSWORD},`].join(
        "\n",
      ),
      "utf8",
    );

    electronApp = await _electron.launch({
      args: [resolve("dist", "compiled", "electron", "main.js")],
      env: appEnv(stateRoot),
    });
    const page = await electronApp.firstWindow();

    // 1. First launch shows the vault-setup gate; create and unlock.
    await page.locator("#passphrase").fill(PASSPHRASE);
    await page.getByRole("button", { name: "作成して解錠" }).click();
    await page.getByRole("button", { name: "サイト管理" }).waitFor();

    // 2. Import the CSV through the hidden file input behind 「ファイルを選択」.
    await page.locator('input[type="file"][accept=".csv,text/csv"]').setInputFiles(csvPath);
    await page.getByText("取り込んだ認証情報").waitFor();

    // 3. Select the imported site and start collection.
    const siteCheckbox = page.getByRole("checkbox", { name: new RegExp(SITE_NAME) });
    await siteCheckbox.check();
    await page.getByRole("button", { name: "選択したサイトを収集" }).click();

    // 4. Exploration reaches /explore-flow/profile and /address (collecting
    //    from both), then hits the CAPTCHA-style wall on /explore-flow/payment
    //    and pauses — wait for the real hand-off banner.
    await page.getByText("ウォールの解決が必要です").waitFor({ timeout: 120_000 });

    // 5. Resolve the hand-off: the fixture's second GET of /explore-flow/payment
    //    (triggered by PageExplorer.resume()'s re-navigation) now returns the
    //    card fields instead of the wall.
    await page.getByRole("button", { name: "解決して再開" }).click();

    // 6. Exploration completes; the ledger now reflects all three pages.
    const collectedStatus = page.getByText(/収集済み（開示 \d+）/);
    await collectedStatus.waitFor({ timeout: 120_000 });
    const statusText = (await collectedStatus.textContent()) ?? "";
    const disclosureCount = Number(/収集済み（開示 (\d+)）/.exec(statusText)?.[1] ?? "0");
    assert.ok(disclosureCount >= 3, `UI must report disclosures from all 3 pages, got: ${statusText}`);
  } finally {
    await electronApp?.close().catch(() => {});
    await site.close();
  }

  // 7. Reopen the vault fresh from disk: multi-page sourcing and card
  //    sanitization must have actually reached the vault, not just the UI.
  const vaultPath = join(stateRoot, "vault.json");
  const reopened = await VaultV2.open(vaultPath, PASSPHRASE);
  try {
    const domain = new DomainService(reopened);
    const sites = domain.listSiteAccounts();
    assert.equal(sites.length, 1, "exactly the one imported site must be on disk");
    const disclosures = domain.listDisclosuresForSite(sites[0]!.id);
    assert.ok(disclosures.length >= 3, "disclosures from all 3 pages must be persisted to vault.json");

    const sourcePages = new Set(disclosures.map((d) => d.sourcePageUrl));
    for (const suffix of ["/explore-flow/profile", "/explore-flow/address", "/explore-flow/payment"]) {
      assert.ok(
        [...sourcePages].some((url) => url?.endsWith(suffix)),
        `expected a disclosure sourced from a page ending in ${suffix}, got sources: ${[...sourcePages].join(", ")}`,
      );
    }

    const cardDisclosure = disclosures.find((d) => d.attributeKey.startsWith("card."));
    assert.ok(cardDisclosure, "expected a card.* disclosure from the payment page");
    assert.equal(cardDisclosure?.siteHeldValue, EXPLORE_FLOW_CARD_LAST4, "card disclosure must be last-4 only");
  } finally {
    reopened.lock();
  }

  // 8. Plaintext-never-persisted checks: password, CVV, and the full card
  //    number must never appear raw in vault.json (only the last 4 digits may).
  const rawVault = await readFile(vaultPath, "utf8");
  assert.ok(!rawVault.includes(EXPLORE_FLOW_PASSWORD), "vault.json must not contain the raw password");
  assert.ok(!rawVault.includes(EXPLORE_FLOW_CARD_CVV), "vault.json must not contain the CVV");
  assert.ok(!rawVault.includes(EXPLORE_FLOW_CARD_NUMBER), "vault.json must not contain the full card number");

  await t.diagnostic(`app UI exploration E2E state root (kept for debugging): ${stateRoot}`);
});

/**
 * Environment for the launched app: the current env minus the Vite dev-server
 * pointer (so main.ts loads dist/renderer/index.html directly), with the vault
 * isolated under the per-run state root — the real user vault is never touched.
 */
function appEnv(stateRoot: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  delete env["VITE_DEV_SERVER_URL"];
  env["SOROERU_STATE_ROOT"] = stateRoot;
  return env;
}
