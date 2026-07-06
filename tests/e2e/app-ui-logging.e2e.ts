// Electron app UI E2E (Issue #314): drive a real Visibility collection failure
// through the actual app UI, then verify the plain-text diagnostics log the
// Settings tab's download button reads surfaces the failure reason — the
// concrete "collection failed, log why" verification the Issue asks for.
//
// The imported site points at 127.0.0.1:1 (a well-known low port nothing
// listens on) so the run deterministically fails with "unreachable" /
// "navigation-failed" — a real network-layer failure driven through Chromium,
// entirely on loopback (no external network / DNS dependency).
//
// The log content itself is asserted by reading the on-disk file directly:
// Electron routes an `<a download>` click through its native `will-download`
// session API rather than the standard Chromium download manager, so
// Playwright's `page.waitForEvent("download")` does not reliably observe it
// here. The Settings tab is still driven through the real UI (tab switch +
// button click) as a smoke check that the button works without throwing.
//
// Local-only (docs/testing.md): not wired into CI. Uses fake data only; no
// real site is touched.

import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { _electron, type ElectronApplication } from "playwright";

const PASSPHRASE = "app-ui-logging-e2e-passphrase";
const FAKE_EMAIL = "e2e-unreachable@example.test";
const FAKE_PASSWORD = "E2e-Fake-Passw0rd!";
const UNREACHABLE_SITE_NAME = "到達不能商店";
const UNREACHABLE_URL = "http://127.0.0.1:1/login";

test("Electron app UI: an unreachable site's collection failure is recorded in the downloadable diagnostics log", async (t) => {
  const stateRoot = resolve("state", "soroeru-poc", "e2e-app-ui-logging", String(Date.now()));
  await mkdir(stateRoot, { recursive: true });

  let electronApp: ElectronApplication | undefined;
  try {
    const csvPath = join(stateRoot, "import.csv");
    await writeFile(
      csvPath,
      [
        "name,url,username,password,note",
        `${UNREACHABLE_SITE_NAME},${UNREACHABLE_URL},${FAKE_EMAIL},${FAKE_PASSWORD},`,
      ].join("\n"),
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

    // 3. Select the imported site and start collection; a refused connection
    //    on 127.0.0.1:1 never reaches "収集済み" — it ends with a recorded
    //    constraint ("要確認") instead.
    const siteCheckbox = page.getByRole("checkbox", { name: new RegExp(UNREACHABLE_SITE_NAME) });
    await siteCheckbox.check();
    await page.getByRole("button", { name: "選択したサイトを収集" }).click();
    await page.getByText("要確認 1", { exact: true }).waitFor({ timeout: 60_000 });

    // The run's failure summary opens as a modal; dismiss it before switching tabs.
    // (`getByLabel` targets the modal's `aria-label="閉じる"` close button uniquely —
    // the modal body also has a same-text "閉じる" button with no aria-label.)
    await page.getByLabel("閉じる").click();

    // 4. Smoke-test the new Settings tab's download button through the real UI
    //    (it must not error), then verify the actual log content it reads by
    //    inspecting the same on-disk file the trusted layer wrote (see header
    //    comment for why this test does not assert on a captured OS download).
    await page.getByRole("button", { name: "設定" }).click();
    await page.getByRole("button", { name: "ログをダウンロード" }).click();
    await page.getByText("ログをダウンロード").waitFor();

    const logContent = await readFile(join(stateRoot, "logs", "soroeru.log"), "utf8");
    const entries = logContent
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    const unreachableEntry = entries.find(
      (entry) => entry["category"] === "visibility" && entry["message"] === "site unreachable",
    );
    assert.ok(unreachableEntry, `expected a "site unreachable" log entry, got: ${logContent}`);
    // Real Chromium reports a refused loopback connection as a generic
    // navigation error rather than net::ERR_CONNECTION_REFUSED, so this lands
    // in the broader "navigation-failed" bucket (unreachableReasonFor,
    // src/automation/visibility-runner.ts) — still a specific reason, distinct
    // from a bare "failed", which is what this test needs to demonstrate.
    assert.equal(unreachableEntry["reason"], "navigation-failed");
    assert.equal(logContent.includes(FAKE_PASSWORD), false, "diagnostics log must never carry the raw password");
    assert.equal(logContent.includes(FAKE_EMAIL), false, "diagnostics log must never carry the raw email");
  } finally {
    await electronApp?.close().catch(() => {});
  }

  await t.diagnostic(`app UI logging E2E state root (kept for debugging): ${stateRoot}`);
});

/**
 * Environment for the launched app: the current env minus the Vite dev-server
 * pointer (so main.ts loads dist/renderer/index.html directly), with the vault
 * (and diagnostics log) isolated under the per-run state root.
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
