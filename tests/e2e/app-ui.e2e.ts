// Electron app UI E2E harness (Issue #303): build the dev app, launch it with
// Playwright's built-in Electron support, and drive the renderer UI through the
// Visibility happy path — vault setup → CSV import → collection on a local fake
// site → disclosure ledger reflected in the UI and persisted to disk.
//
// Local-only (docs/testing.md): not wired into CI. Uses fake data only and the
// local PoC test-site server; no real site is touched. The headed automation
// browser Soroeru itself opens during collection is deliberately NOT driven
// here — the renderer UI (fed by visibility IPC events) is the observed truth.

import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { _electron, type ElectronApplication } from "playwright";
import { startPocServer } from "../../sites/server.js";
import { DomainService } from "../../src/domain/domain-service.js";
import { VaultV2 } from "../../src/store/vault-v2.js";

const PASSPHRASE = "app-ui-e2e-passphrase";
const FAKE_EMAIL = "e2e-user@example.test";
const FAKE_PASSWORD = "E2e-Fake-Passw0rd!";
const TARGET_SITE_ID = "01-basic";
const TARGET_SITE_NAME = "ベーシック商店";

test("Electron app UI: vault setup → CSV import → Visibility collection → persisted ledger", async (t) => {
  const stateRoot = resolve("state", "soroeru-poc", "e2e-app-ui", String(Date.now()));
  await mkdir(stateRoot, { recursive: true });

  const site = await startPocServer(0);
  let electronApp: ElectronApplication | undefined;
  try {
    // The fake site's login succeeds only for an already-registered account,
    // so seed one whose email matches the CSV credential below.
    await seedRegisteredAccount(site.siteUrl(TARGET_SITE_ID));

    const loginUrl = `${site.siteUrl(TARGET_SITE_ID)}login`;
    const csvPath = join(stateRoot, "import.csv");
    // Chrome Password Manager export shape; fake values only.
    await writeFile(
      csvPath,
      ["name,url,username,password,note", `${TARGET_SITE_NAME},${loginUrl},${FAKE_EMAIL},${FAKE_PASSWORD},`].join("\n"),
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
    const siteCheckbox = page.getByRole("checkbox", { name: new RegExp(TARGET_SITE_NAME) });
    await siteCheckbox.check();
    await page.getByRole("button", { name: "選択したサイトを収集" }).click();

    // 4. The run drives a real headed browser against the local fake site;
    //    wait (auto-waiting only, no fixed sleeps) for the ledger status.
    const collectedStatus = page.getByText(/収集済み（開示 \d+）/);
    await collectedStatus.waitFor({ timeout: 120_000 });
    const statusText = (await collectedStatus.textContent()) ?? "";
    const disclosureCount = Number(/収集済み（開示 (\d+)）/.exec(statusText)?.[1] ?? "0");
    assert.ok(disclosureCount >= 1, `UI must report at least one disclosure, got: ${statusText}`);
  } finally {
    await electronApp?.close().catch(() => {});
    await site.close();
  }

  // 5. Persistence regression check (the Issue #303 bug fix): reopen the vault
  //    fresh from disk after the app exited — the collected disclosures must
  //    have been saved, and no raw credential may sit in the file as plaintext.
  const vaultPath = join(stateRoot, "vault.json");
  const reopened = await VaultV2.open(vaultPath, PASSPHRASE);
  try {
    const domain = new DomainService(reopened);
    const sites = domain.listSiteAccounts();
    assert.equal(sites.length, 1, "exactly the one imported site must be on disk");
    const disclosures = domain.listDisclosuresForSite(sites[0]!.id);
    assert.ok(disclosures.length >= 1, "collected disclosures must be persisted to vault.json");
  } finally {
    reopened.lock();
  }
  const rawVault = await readFile(vaultPath, "utf8");
  assert.ok(!rawVault.includes(FAKE_PASSWORD), "vault.json must not contain the raw password");
  assert.ok(!rawVault.includes(FAKE_EMAIL), "vault.json must not contain the raw email");

  await t.diagnostic(`app UI E2E state root (kept for debugging): ${stateRoot}`);
});

/** Register a fake account on the PoC site so its login flow can succeed. */
async function seedRegisteredAccount(siteUrl: string): Promise<void> {
  const res = await fetch(new URL("register", siteUrl), {
    method: "POST",
    body: new URLSearchParams({
      fullname: "回収 花子",
      kana: "カイシュウ ハナコ",
      email: FAKE_EMAIL,
      tel: "090-0000-1111",
      zip: "100-0001",
      address: "東京都千代田区1-1",
      company: "テスト商会",
      department: "検証部",
      login_id: "e2e-hanako",
      password: FAKE_PASSWORD,
    }),
  });
  assert.equal(res.status, 200, "seeding the fake site's registered account must succeed");
}

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
