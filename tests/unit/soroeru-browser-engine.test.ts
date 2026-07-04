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

test("openSession falls back to the bundled Chromium build when real Chrome is not installed", async () => {
  const calls: Array<{ headless: boolean; channel?: "chrome" }> = [];
  let attempt = 0;
  const engine = new BrowserEngine({
    channel: "chrome",
    launch: async (opts) => {
      calls.push(opts);
      attempt += 1;
      // The exact message playwright-core's browserType.launch throws for a missing channel.
      if (attempt === 1) throw new Error("Chromium distribution 'chrome' is not found at ...");
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

test("openSession does not fall back on a channel launch error unrelated to a missing install", async () => {
  const calls: Array<{ headless: boolean; channel?: "chrome" }> = [];
  const engine = new BrowserEngine({
    channel: "chrome",
    launch: async (opts) => {
      calls.push(opts);
      throw new Error("EACCES: permission denied opening browser executable");
    },
  });

  await assert.rejects(() => engine.openSession(), /EACCES/);
  // Only the single (failed) channel attempt happened — no silent retry.
  assert.deepEqual(calls, [{ headless: false, channel: "chrome" }]);
});

test("openSession passes a persisted storageState through to newContext, parsed as an object (Issue #294)", async () => {
  const contextCalls: unknown[] = [];
  const fakePage = { evaluate: async () => ({}) };
  const fakeContext = { newPage: async () => fakePage, close: async () => {}, storageState: async () => ({ cookies: [], origins: [] }) };
  const fakeBrowserWithCapture = {
    newContext: async (opts: unknown) => {
      contextCalls.push(opts);
      return fakeContext;
    },
    close: async () => {},
  } as unknown as Browser;

  const engine = new BrowserEngine({ launch: async () => fakeBrowserWithCapture });
  const storageState = JSON.stringify({ cookies: [{ name: "a", value: "b" }], origins: [] });
  await engine.openSession(undefined, { storageState });

  assert.deepEqual(contextCalls, [{ storageState: JSON.parse(storageState) }]);
  await engine.closeAll();
});

test("openSession falls back to a fresh context when a persisted storageState is corrupt JSON", async () => {
  const contextCalls: unknown[] = [];
  const fakePage = { evaluate: async () => ({}) };
  const fakeContext = { newPage: async () => fakePage, close: async () => {} };
  const fakeBrowserWithCapture = {
    newContext: async (opts: unknown) => {
      contextCalls.push(opts);
      return fakeContext;
    },
    close: async () => {},
  } as unknown as Browser;

  const engine = new BrowserEngine({ launch: async () => fakeBrowserWithCapture });
  await engine.openSession(undefined, { storageState: "not valid json" });

  assert.deepEqual(contextCalls, [{}]);
  await engine.closeAll();
});

test("a real Playwright session's exportStorageState reads the context's live storageState (Issue #294)", async () => {
  const exported = { cookies: [{ name: "session", value: "tok" }], origins: [] };
  const fakePage = { evaluate: async () => ({}) };
  const fakeContext = {
    newPage: async () => fakePage,
    close: async () => {},
    storageState: async () => exported,
  };
  const fakeBrowserForExport = {
    newContext: async () => fakeContext,
    close: async () => {},
  } as unknown as Browser;

  const engine = new BrowserEngine({ launch: async () => fakeBrowserForExport });
  const session = await engine.openSession();
  assert.ok(session.exportStorageState);
  const raw = await session.exportStorageState();
  assert.deepEqual(JSON.parse(raw), exported);
  await session.close();
  await engine.closeAll();
});

test("openSession chains the original error when the fallback launch also fails", async () => {
  let attempt = 0;
  const engine = new BrowserEngine({
    channel: "chrome",
    launch: async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("Chromium distribution 'chrome' is not found at ...");
      throw new Error("bundled Chromium failed to launch too");
    },
  });

  await assert.rejects(() => engine.openSession(), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /fallback also failed to launch/);
    assert.ok(err.cause instanceof Error);
    assert.match((err.cause as Error).message, /bundled Chromium failed to launch too/);
    return true;
  });
});
