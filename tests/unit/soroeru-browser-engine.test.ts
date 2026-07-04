import assert from "node:assert/strict";
import { test } from "node:test";
import type { Browser } from "playwright";
import { BrowserEngine, buildLaunchOptions } from "../../src/automation/browser-engine.js";

test("buildLaunchOptions defaults to headed packaged Chromium with no channel", () => {
  assert.deepEqual(buildLaunchOptions("chromium", {}), { headless: false });
});

test("buildLaunchOptions honors an explicit headless override", () => {
  assert.deepEqual(buildLaunchOptions("chromium", { headless: true }), { headless: true });
});

test("buildLaunchOptions passes channel:'chrome' through for the chromium engine", () => {
  assert.deepEqual(buildLaunchOptions("chromium", { channel: "chrome" }), {
    headless: false,
    channel: "chrome",
  });
});

test("buildLaunchOptions ignores channel for non-chromium engines (Chromium-only option)", () => {
  assert.deepEqual(buildLaunchOptions("firefox", { channel: "chrome" }), { headless: false });
  assert.deepEqual(buildLaunchOptions("webkit", { channel: "chrome" }), { headless: false });
});

function fakeBrowser(): Browser {
  const fakePage = { evaluate: async () => ({}) };
  const fakeContext = { newPage: async () => fakePage, close: async () => {} };
  return { newContext: async () => fakeContext, close: async () => {} } as unknown as Browser;
}

test("openSession launches with the requested channel when no fallback is needed", async () => {
  const calls: Array<{ headless: boolean; channel?: "chrome" }> = [];
  const engine = new BrowserEngine({
    channel: "chrome",
    launch: async (opts) => {
      calls.push(opts);
      return fakeBrowser();
    },
  });

  await engine.openSession();

  assert.deepEqual(calls, [{ headless: false, channel: "chrome" }]);
  await engine.closeAll();
});

test("openSession falls back to the bundled Chromium build when real Chrome is unavailable", async () => {
  const calls: Array<{ headless: boolean; channel?: "chrome" }> = [];
  let attempt = 0;
  const engine = new BrowserEngine({
    channel: "chrome",
    launch: async (opts) => {
      calls.push(opts);
      attempt += 1;
      if (attempt === 1) throw new Error("channel 'chrome' is not installed");
      return fakeBrowser();
    },
  });

  await engine.openSession();

  assert.deepEqual(calls, [
    { headless: false, channel: "chrome" },
    { headless: false },
  ]);
  await engine.closeAll();
});

test("openSession does not swallow launch failures unrelated to the channel fallback", async () => {
  const engine = new BrowserEngine({
    launch: async () => {
      throw new Error("no display available");
    },
  });

  await assert.rejects(() => engine.openSession(), /no display available/);
});
