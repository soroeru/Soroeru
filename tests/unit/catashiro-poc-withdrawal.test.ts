// Withdrawal preparation flow (#129): navigate configured withdrawal steps,
// hand off at walls, and stop before the irreversible final action.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { startPocServer } from "../../sites/server.js";
import { DeterministicMapper } from "../../src/agent/mapper.js";
import { AppRunner } from "../../src/app/runner.js";
import { CatashiroApp } from "../../src/app/app.js";

const PASSPHRASE = "unit-test-passphrase";

test("AppRunner.withdraw prepares the withdrawal page without clicking the final button", async () => {
  const dir = await mkdtemp(join(tmpdir(), "af-poc-withdrawal-"));
  const site = await startPocServer();
  const app = new CatashiroApp({
    stateDir: dir,
    idleLockMs: 0,
    launchBrowserFn: async (): Promise<Browser> => chromium.launch({ headless: true }),
  });
  try {
    await app.unlock(PASSPHRASE);
    const siteId = "08-terms";
    const origin = site.siteUrl(siteId).replace(/\/$/, "");
    const now = Date.now();
    app.store.upsertSiteRecord({
      origin,
      siteId,
      serviceName: "テスト商事",
      registeredAt: now,
      filledFields: [],
      accountState: "withdrawalCandidate",
      status: "registered",
      nextAction: "prepareWithdrawal",
      withdrawalCandidateAt: now,
    });
    site.state(siteId).registered = { email: "taro@example.test" };

    const browser = await app.launchBrowser("chromium");
    const page = await browser.newPage();
    try {
      const runner = new AppRunner(app, new DeterministicMapper());
      const result = await runner.withdraw(page, site.siteUrl(siteId), siteId, {
        gate: { decide: async () => ({ approved: false, attestationApprovals: {}, cardApproved: false }) },
        promptUser: async () => undefined,
        log: () => {},
      });

      assert.equal(result.status, "prepared");
      assert.equal(result.finalActionManual, true);
      assert.match(page.url(), /\/site\/08-terms\/withdraw$/);
      assert.equal(site.state(siteId).events.filter((event) => event.type === "withdraw").length, 0);
      const record = app.store.getSiteRecord(siteId)!;
      assert.ok(record.withdrawalPreparedAt);
      assert.equal(record.withdrawalFinalConfirmationRequired, true);
    } finally {
      await page.close().catch(() => {});
      await app.closeBrowser(browser);
    }
  } finally {
    await app.shutdown();
    await site.close();
    await rm(dir, { recursive: true, force: true });
  }
});
