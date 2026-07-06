// Collection diagnostics run (Issue #317): drive the packaged Soroeru app
// through a full Visibility batch — vault setup → password-CSV import →
// select all sites → collect → download the diagnostics log — unattended, so
// the failure log can be gathered and analyzed repeatedly.
//
// This is an operational driver, not a test: it runs against the user's real
// password CSV and real sites, so it is local-only, never in CI, and never
// prints usernames, passwords, or collected values. Wall hand-offs (CAPTCHA /
// MFA / verification) are auto-skipped via the UI's 「このサイトをスキップ」 —
// the wall is recorded as a constraint and counted as a failure cause; nothing
// is bypassed.
//
// Environment:
//   SOROERU_DIAG_APP         path to a packaged app executable
//                            (…/Soroeru.app/Contents/MacOS/Soroeru), or "dev"
//                            to launch dist/compiled/electron/main.js.
//                            Default: newest out/Soroeru-darwin-*/… build,
//                            falling back to the dev build.
//   SOROERU_DIAG_CSV         password CSV path (default tests/e2e/Google_Passwords.csv)
//   SOROERU_DIAG_MAX_SITES   cap the number of selected sites (default: all)
//   SOROERU_DIAG_TIMEOUT_MIN overall batch timeout in minutes (default 360)
//
// Output: the per-run state root (printed at start/end) containing
// logs/soroeru.log — analyze it with:
//   node dist/compiled/run/analyze-collection-log.js <stateRoot>/logs/soroeru.log

import { existsSync, readdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { _electron, type ElectronApplication, type Page } from "playwright";

const POLL_INTERVAL_MS = 3000;

async function main(): Promise<void> {
  const csvPath = resolve(process.env["SOROERU_DIAG_CSV"] ?? join("tests", "e2e", "Google_Passwords.csv"));
  if (!existsSync(csvPath)) {
    throw new Error(`password CSV not found: ${csvPath} (set SOROERU_DIAG_CSV)`);
  }
  const maxSites = positiveIntEnv("SOROERU_DIAG_MAX_SITES");
  const timeoutMinutes = positiveIntEnv("SOROERU_DIAG_TIMEOUT_MIN") ?? 360;

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const stateRoot = resolve("state", "soroeru-poc", "collection-diagnostics", stamp);
  await mkdir(stateRoot, { recursive: true });
  // Per-run throwaway vault; the passphrase is never reused and never printed.
  const passphrase = `diag-${randomBytes(16).toString("hex")}`;

  const launchTarget = resolveLaunchTarget();
  console.log(`[diagnostics] app: ${launchTarget.label}`);
  console.log(`[diagnostics] state root: ${stateRoot}`);

  let electronApp: ElectronApplication | undefined;
  let appClosed = false;
  try {
    electronApp = await _electron.launch({
      ...(launchTarget.executablePath !== undefined
        ? { executablePath: launchTarget.executablePath }
        : {}),
      args: launchTarget.args ?? [],
      env: appEnv(stateRoot),
    });
    electronApp.on("close", () => {
      appClosed = true;
    });
    const page = await electronApp.firstWindow();
    page.setDefaultTimeout(60_000);

    // 1. First launch shows the vault-setup gate; create and unlock.
    await page.locator("#passphrase").fill(passphrase);
    await page.getByRole("button", { name: "作成して解錠" }).click();
    await page.getByRole("button", { name: "サイト管理" }).waitFor();

    // 2. Import the CSV through the hidden file input behind 「ファイルを選択」.
    await page.locator('input[type="file"][accept=".csv,text/csv"]').setInputFiles(csvPath);
    await page.getByText("取り込んだ認証情報").waitFor({ timeout: 180_000 });

    // 3. Select the sites to collect.
    if (maxSites !== undefined) {
      const checkboxes = page.locator('li input[type="checkbox"]');
      const total = await checkboxes.count();
      const target = Math.min(maxSites, total);
      for (let i = 0; i < target; i++) await checkboxes.nth(i).check();
      console.log(`[diagnostics] selected ${target} of ${total} sites (SOROERU_DIAG_MAX_SITES)`);
    } else {
      await page.getByRole("button", { name: "全てにチェックする" }).click();
      console.log("[diagnostics] selected all sites");
    }

    // 4. Start the batch and babysit it: skip wall hand-offs, report progress.
    await page.getByRole("button", { name: "選択したサイトを収集" }).click();
    const summary = await waitForBatchDone(page, timeoutMinutes, () => appClosed);
    console.log(`[diagnostics] batch finished: ${summary.doneText}`);
    console.log(`[diagnostics] wall hand-offs auto-skipped: ${summary.wallsSkipped}`);

    // Dismiss the collection-result modal if it opened.
    const modalClose = page.getByLabel("閉じる");
    if (await modalClose.isVisible().catch(() => false)) {
      await modalClose.click().catch(() => {});
    }

    // 5. Drive the Settings tab's 「ログをダウンロード」 as a real-UI smoke
    //    step. The authoritative log copy is the on-disk file the button
    //    reads (state root/logs/soroeru.log; see tests/e2e/app-ui-logging.e2e.ts
    //    for why the OS download itself is not asserted here).
    await page.getByRole("button", { name: "設定" }).click();
    await page.getByRole("button", { name: "ログをダウンロード" }).click();
    await page.getByText("ログをダウンロード").waitFor();
  } finally {
    await electronApp?.close().catch(() => {});
  }

  const logPath = join(stateRoot, "logs", "soroeru.log");
  console.log(`[diagnostics] log: ${logPath}`);
  console.log(
    `[diagnostics] analyze: node dist/compiled/run/analyze-collection-log.js ${JSON.stringify(logPath)}`,
  );
}

interface BatchSummary {
  doneText: string;
  wallsSkipped: number;
}

/**
 * Poll the batch bar until it reports completion. A visible wall hand-off
 * modal is answered with 「このサイトをスキップ」 so an unattended run keeps
 * moving; the skipped site stays recorded as a wall constraint (the failure
 * cause we are here to count). Progress text is echoed when it changes so a
 * backgrounded run can be monitored from its output.
 */
async function waitForBatchDone(
  page: Page,
  timeoutMinutes: number,
  isAppClosed: () => boolean,
): Promise<BatchSummary> {
  const doneText = page.getByText(/完了: 成功 \d+ \/ 要確認 \d+/);
  const skipButton = page.getByRole("button", { name: "このサイトをスキップ" });
  const progressBar = page.getByText(/選択中 \d+ \/ 表示中 \d+/);
  const deadline = Date.now() + timeoutMinutes * 60_000;
  let wallsSkipped = 0;
  let lastProgress = "";

  while (Date.now() < deadline) {
    if (isAppClosed()) throw new Error("the app window closed before the batch finished");
    if (await doneText.isVisible().catch(() => false)) {
      const text = (await doneText.textContent().catch(() => null)) ?? "done";
      return { doneText: text.trim(), wallsSkipped };
    }
    if (await skipButton.isVisible().catch(() => false)) {
      await skipButton.click().catch(() => {});
      wallsSkipped++;
      console.log(`[diagnostics] wall hand-off skipped (${wallsSkipped} so far)`);
    }
    const progress = (await progressBar.textContent().catch(() => null))?.trim() ?? "";
    if (progress !== "" && progress !== lastProgress) {
      lastProgress = progress;
      console.log(`[diagnostics] ${progress}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`batch did not finish within ${timeoutMinutes} minutes`);
}

interface LaunchTarget {
  label: string;
  executablePath?: string;
  args?: string[];
}

/**
 * Pick the app to drive: an explicit SOROERU_DIAG_APP path, the newest
 * packaged build under out/ (the same binary the DMG ships), or the dev
 * build as a last resort.
 */
function resolveLaunchTarget(): LaunchTarget {
  const requested = process.env["SOROERU_DIAG_APP"];
  if (requested !== undefined && requested !== "" && requested !== "dev") {
    if (!existsSync(requested)) throw new Error(`SOROERU_DIAG_APP not found: ${requested}`);
    return { label: `packaged (${requested})`, executablePath: requested };
  }
  if (requested !== "dev") {
    const packaged = findPackagedBinary();
    if (packaged !== undefined) return { label: `packaged (${packaged})`, executablePath: packaged };
  }
  const devMain = resolve("dist", "compiled", "electron", "main.js");
  if (!existsSync(devMain)) {
    throw new Error("no packaged build under out/ and no dev build; run `npm run build:app` first");
  }
  return { label: `dev build (${devMain})`, args: [devMain] };
}

function findPackagedBinary(): string | undefined {
  const outDir = resolve("out");
  if (!existsSync(outDir)) return undefined;
  for (const entry of readdirSync(outDir)) {
    if (!entry.startsWith("Soroeru-darwin-")) continue;
    const binary = join(outDir, entry, "Soroeru.app", "Contents", "MacOS", "Soroeru");
    if (existsSync(binary)) return binary;
  }
  return undefined;
}

/**
 * Environment for the launched app: the current env minus the Vite dev-server
 * pointer, with the vault and diagnostics log isolated under the per-run
 * state root — the user's real vault is never touched.
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

function positiveIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err: unknown) => {
  console.error(`[diagnostics] failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
