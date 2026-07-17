import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import type { PageSnapshot } from "../../src/types.js";
import { hideAutomationBanner, readPageValues, scanPage } from "../../extension/content-script.js";
import { snapshotPage } from "../../src/agent/scan.js";
import {
  isAllowedExtensionOrigin,
  isExpectedNavigationOrigin,
  ExtensionExecutionEpoch,
  isSameSiteExtensionOrigin,
  unbindMatchesBinding,
  validateExtensionCommand,
  withPageIdentity,
} from "../../extension/worker.js";
import {
  ExtensionPageDriver,
  type ChromeBridgeTransport,
} from "../../src/automation/extension-page-driver.js";

test("MV3 manifest requests only the bridge permissions and optional HTTPS hosts", async () => {
  const manifest = JSON.parse(
    await readFile(join(process.cwd(), "extension", "manifest.json"), "utf8"),
  ) as Record<string, unknown>;

  assert.deepEqual(manifest.permissions, ["nativeMessaging", "scripting", "activeTab", "storage"]);
  assert.deepEqual(manifest.optional_host_permissions, ["https://*/*"]);
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.content_scripts, undefined);
});

test("extension build config bundles source imports into the unpacked files", async () => {
  const config = await readFile(join(process.cwd(), "extension", "vite.config.mjs"), "utf8");
  assert.match(config, /contentScript/);
  assert.match(config, /worker/);
});

test("worker accepts only explicit bound tabs and HTTPS origins", () => {
  assert.equal(isAllowedExtensionOrigin("https://example.test"), true);
  assert.equal(isAllowedExtensionOrigin("http://example.test"), false);
  assert.equal(isAllowedExtensionOrigin("file:///tmp/page.html"), false);
  assert.equal(isAllowedExtensionOrigin("https://example.test/path"), false);

  assert.deepEqual(validateExtensionCommand("snapshot", { tabId: 7 }), { tabId: 7 });
  assert.deepEqual(validateExtensionCommand("goto", { tabId: 7, url: "https://example.test/account" }), {
    tabId: 7,
    url: "https://example.test/account",
  });
  assert.deepEqual(
    validateExtensionCommand("goto", {
      tabId: 7,
      url: "https://account.example.test/profile",
      siteDomain: "example.test",
    }),
    {
      tabId: 7,
      url: "https://account.example.test/profile",
      siteDomain: "example.test",
    },
  );
  assert.deepEqual(validateExtensionCommand("unbind", { tabId: 7, siteDomain: "example.test" }), {
    tabId: 7,
    siteDomain: "example.test",
  });
  assert.deepEqual(validateExtensionCommand("listPermissions", undefined), {});
  assert.deepEqual(validateExtensionCommand("activeTab", undefined), {});
  assert.deepEqual(validateExtensionCommand("stop", undefined), {});
  assert.deepEqual(validateExtensionCommand("removePermission", { origin: "https://example.test" }), {
    origin: "https://example.test",
  });
  assert.throws(
    () => validateExtensionCommand("removePermission", { origin: "http://example.test" }),
    /HTTPS/,
  );
  assert.throws(() => validateExtensionCommand("activeTab", { credential: "CANARY" }), /unknown payload/);
  assert.throws(() => validateExtensionCommand("snapshot", { tabId: 0 }), /tabId/);
  assert.throws(() => validateExtensionCommand("goto", { tabId: 7, url: "http://example.test" }), /HTTPS/);
  assert.throws(() => validateExtensionCommand("snapshot", { tabId: 7, extra: true }), /unknown payload/);
  assert.throws(
    () => validateExtensionCommand("unbind", { tabId: 7, url: "https://example.test/" }),
    /unknown payload/,
  );
});

test("same-site origin check accepts the site domain and its subdomains, never siblings", () => {
  assert.equal(isSameSiteExtensionOrigin("https://example.test", "example.test"), true);
  assert.equal(isSameSiteExtensionOrigin("https://account.example.test", "example.test"), true);
  assert.equal(isSameSiteExtensionOrigin("https://www.example.test", "example.test"), true);
  assert.equal(isSameSiteExtensionOrigin("https://EXAMPLE.TEST", "example.test"), true);
  assert.equal(isSameSiteExtensionOrigin("https://evil-example.test", "example.test"), false);
  assert.equal(isSameSiteExtensionOrigin("https://notexample.test", "example.test"), false);
  assert.equal(isSameSiteExtensionOrigin("javascript:void(0)", "example.test"), false);
  assert.equal(isSameSiteExtensionOrigin("not a url", "example.test"), false);
});

test("navigation origin check allows same-site redirects only when the tab is site-scoped", () => {
  assert.equal(isExpectedNavigationOrigin("https://example.test/login", "https://example.test"), true);
  assert.equal(
    isExpectedNavigationOrigin("https://account.example.test/otp", "https://example.test", "example.test"),
    true,
  );
  assert.equal(isExpectedNavigationOrigin("https://account.example.test/otp", "https://example.test"), false);
  assert.equal(
    isExpectedNavigationOrigin("https://evil.test/", "https://example.test", "example.test"),
    false,
  );
  assert.equal(
    isExpectedNavigationOrigin("http://example.test/", "https://example.test", "example.test"),
    false,
  );
  assert.equal(isExpectedNavigationOrigin(undefined, "https://example.test", "example.test"), false);
});

test("unbind matches the bound tab and site scope without needing a live tab", () => {
  assert.equal(unbindMatchesBinding(undefined, { tabId: 7 }), false);
  assert.equal(unbindMatchesBinding({ tabId: 7 }, { tabId: 8 }), false);
  // A binding created by a non-goto command has no siteDomain; unbind then matches on tabId alone.
  assert.equal(unbindMatchesBinding({ tabId: 7 }, { tabId: 7, siteDomain: "example.test" }), true);
  assert.equal(
    unbindMatchesBinding({ tabId: 7, siteDomain: "example.test" }, { tabId: 7, siteDomain: "example.test" }),
    true,
  );
  assert.equal(unbindMatchesBinding({ tabId: 7, siteDomain: "example.test" }, { tabId: 7 }), false);
  assert.equal(
    unbindMatchesBinding({ tabId: 7, siteDomain: "example.test" }, { tabId: 7, siteDomain: "other.test" }),
    false,
  );
});

test("a stop generation invalidates a slower command before it can apply late state", async () => {
  const epoch = new ExtensionExecutionEpoch();
  const startedAt = epoch.current();
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  let appliedLateState = false;
  const command = (async () => {
    await delayed;
    if (epoch.isCurrent(startedAt)) appliedLateState = true;
  })();

  epoch.stop();
  release();
  await command;

  assert.equal(appliedLateState, false);
});

test("stop removes the visible automation banner", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="soroeru-extension-automation-banner">running</div>');
    await page.evaluate(hideAutomationBanner);
    assert.equal(await page.locator("#soroeru-extension-automation-banner").count(), 0);
  } finally {
    await browser.close();
  }
});

test("content snapshot has the same structure-only shape as the Playwright scanner", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <meta property="og:site_name" content="  Example Service  ">
      <label for="email">メールアドレス</label>
      <input id="email" name="email" autocomplete="email" required>
      <dl><dt>氏名</dt><dd>山田 太郎</dd></dl>
      <button>保存</button>
    `);

    const extensionSnapshot = (await page.evaluate(scanPage)) as PageSnapshot;
    const playwrightSnapshot = await snapshotPage(page);

    assert.deepEqual(
      extensionSnapshot.fields.map(({ fieldId: _fieldId, ...field }) => field),
      playwrightSnapshot.fields.map(({ fieldId: _fieldId, ...field }) => field),
    );
    assert.deepEqual(
      extensionSnapshot.displayValues?.map(({ valueId: _valueId, ...value }) => value),
      playwrightSnapshot.displayValues?.map(({ valueId: _valueId, ...value }) => value),
    );
    assert.equal(extensionSnapshot.visibleText, playwrightSnapshot.visibleText);
    assert.equal(extensionSnapshot.siteName, "Example Service");
    assert.equal(playwrightSnapshot.siteName, "Example Service");
    assert.equal(extensionSnapshot.fields[0]?.name, "email");
    assert.equal(extensionSnapshot.displayValues?.[0]?.labelText, "氏名");
    assert.equal(JSON.stringify(extensionSnapshot.fields).includes("山田 太郎"), false);
    assert.equal(JSON.stringify(extensionSnapshot.displayValues).includes("山田 太郎"), false);
  } finally {
    await browser.close();
  }
});

test("the real scan payload passes driver validation only after the worker attaches url/title (Issue #360)", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <label for="email">メールアドレス</label>
      <input id="email" name="email" autocomplete="email" required>
      <button>ログイン</button>
    `);
    // Exactly what the content script sends back for a snapshot command.
    const rawScanPayload = await page.evaluate(scanPage);

    const driverFor = (payload: unknown): ExtensionPageDriver => {
      const transport: ChromeBridgeTransport = {
        sendCommand: async () => payload,
        isConnected: () => true,
      };
      return new ExtensionPageDriver(transport, 7);
    };

    // Without the worker-side merge the driver must reject the scan result —
    // this is the exact "invalid snapshot payload" failure seen on a real site.
    await assert.rejects(driverFor(rawScanPayload).snapshot(), /invalid snapshot payload/);

    const merged = withPageIdentity(rawScanPayload, {
      url: "https://login.example.test/",
      title: "ログイン",
    });
    const snapshot = await driverFor(merged).snapshot();
    assert.equal(snapshot.url, "https://login.example.test/");
    assert.equal(snapshot.title, "ログイン");
    assert.equal(snapshot.fields[0]?.name, "email");
    // The tab's identity is authoritative even if a payload smuggles its own.
    assert.equal(
      (withPageIdentity({ url: "https://evil.example.test/" }, { url: "https://ok.example.test/" }) as { url: string }).url,
      "https://ok.example.test/",
    );
  } finally {
    await browser.close();
  }
});

test("content value collection excludes unchecked choices and empty inputs like Playwright", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <input data-af-id="f-email" value="user@example.test">
      <input data-af-id="f-checked" type="checkbox" value="newsletter" checked>
      <input data-af-id="f-unchecked" type="checkbox" value="marketing">
      <input data-af-id="f-radio-checked" type="radio" value="home" checked>
      <input data-af-id="f-radio-unchecked" type="radio" value="office">
      <input data-af-id="f-empty" value="">
    `);

    assert.deepEqual(await page.evaluate(readPageValues, undefined), {
      "f-email": "user@example.test",
      "f-checked": "newsletter",
      "f-radio-checked": "home",
    });
  } finally {
    await browser.close();
  }
});
