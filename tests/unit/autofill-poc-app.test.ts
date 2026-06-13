// App shell (RFC-001 v3 §7, APP-001 / #43): encrypted-store unlock/lock
// (incl. idle auto-lock) and Playwright browser lifecycle, plus the
// `AppRunner` UI <-> automation boundary.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, Page } from "playwright";
import { AutofillApp, AutofillAppError } from "../../poc/autofill-agent/src/app/app.js";
import { AppRunner, type AppRunnerHooks } from "../../poc/autofill-agent/src/app/runner.js";
import type { Mapper } from "../../poc/autofill-agent/src/agent/mapper.js";

const PASSPHRASE = "unit-test-passphrase";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "af-poc-app-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("unlock() opens the encrypted store; a wrong passphrase fails closed with AutofillAppError", async () => {
  await withTempDir(async (dir) => {
    const app = new AutofillApp({ stateDir: dir, idleLockMs: 0 });
    const store = await app.unlock(PASSPHRASE);
    assert.equal(app.isUnlocked, true);
    store.setProfileValue("email", "メールアドレス", "user@example.test");
    await store.save();
    app.lock();
    assert.equal(app.isUnlocked, false);
    assert.throws(() => app.store, AutofillAppError);

    const app2 = new AutofillApp({ stateDir: dir, idleLockMs: 0 });
    await assert.rejects(() => app2.unlock("wrong-passphrase"), AutofillAppError);
    assert.equal(app2.isUnlocked, false);
  });
});

test("idle auto-lock locks the store once the injected timer fires", async () => {
  await withTempDir(async (dir) => {
    const timers = new Map<number, () => void>();
    let nextHandle = 0;
    const app = new AutofillApp({
      stateDir: dir,
      idleLockMs: 1000,
      setTimeoutFn: (fn) => {
        const handle = nextHandle++;
        timers.set(handle, fn);
        return handle;
      },
      clearTimeoutFn: (handle) => {
        timers.delete(handle as number);
      },
    });
    await app.unlock(PASSPHRASE);
    assert.equal(timers.size, 1);

    const [handle, fire] = [...timers.entries()][0]!;
    fire();
    assert.equal(app.isUnlocked, false);
    assert.equal(timers.has(handle), false);
  });
});

test("touch() resets the idle auto-lock timer", async () => {
  await withTempDir(async (dir) => {
    const timers = new Map<number, () => void>();
    let nextHandle = 0;
    const app = new AutofillApp({
      stateDir: dir,
      idleLockMs: 1000,
      setTimeoutFn: (fn) => {
        const handle = nextHandle++;
        timers.set(handle, fn);
        return handle;
      },
      clearTimeoutFn: (handle) => {
        timers.delete(handle as number);
      },
    });
    await app.unlock(PASSPHRASE);
    const firstHandle = [...timers.keys()][0]!;

    app.touch();
    assert.equal(timers.has(firstHandle), false);
    assert.equal(timers.size, 1);

    const [secondHandle, fire] = [...timers.entries()][0]!;
    assert.notEqual(secondHandle, firstHandle);
    fire();
    assert.equal(app.isUnlocked, false);
  });
});

test("launchBrowser tracks browsers; shutdown closes them all and locks the store", async () => {
  await withTempDir(async (dir) => {
    let closeCount = 0;
    const launchBrowserFn = async (): Promise<Browser> => ({ close: async () => { closeCount++; } }) as unknown as Browser;

    const app = new AutofillApp({ stateDir: dir, idleLockMs: 0, launchBrowserFn });
    await app.unlock(PASSPHRASE);

    await app.launchBrowser("chromium");
    await app.launchBrowser("firefox");

    await app.shutdown();
    assert.equal(closeCount, 2);
    assert.equal(app.isUnlocked, false);
  });
});

test("closeBrowser closes and stops tracking a single browser", async () => {
  await withTempDir(async (dir) => {
    let closeCount = 0;
    const launchBrowserFn = async (): Promise<Browser> => ({ close: async () => { closeCount++; } }) as unknown as Browser;

    const app = new AutofillApp({ stateDir: dir, idleLockMs: 0, launchBrowserFn });
    await app.unlock(PASSPHRASE);

    const browser = await app.launchBrowser("chromium");
    await app.closeBrowser(browser);
    assert.equal(closeCount, 1);

    await app.shutdown();
    assert.equal(closeCount, 1);
  });
});

test("AppRunner.register/update require an unlocked store", async () => {
  await withTempDir(async (dir) => {
    const app = new AutofillApp({ stateDir: dir, idleLockMs: 0 });
    const runner = new AppRunner(app, {} as unknown as Mapper);
    const hooks: AppRunnerHooks = {
      gate: { decide: async () => ({ approved: false, attestationApprovals: {}, cardApproved: false }) },
      promptUser: async () => undefined,
      log: () => {},
    };

    await assert.rejects(async () => {
      await runner.register({} as unknown as Page, "http://127.0.0.1/site", hooks);
    }, AutofillAppError);

    await assert.rejects(async () => {
      await runner.update({} as unknown as Page, "http://127.0.0.1/site", "site-id", hooks);
    }, AutofillAppError);
  });
});
