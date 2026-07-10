import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import type { PageSnapshot } from "../../src/types.js";
import { scanPage } from "../../extension/content-script.js";
import { snapshotPage } from "../../src/agent/scan.js";
import { isAllowedExtensionOrigin, validateExtensionCommand } from "../../extension/worker.js";

test("MV3 manifest requests only the bridge permissions and optional HTTPS hosts", async () => {
  const manifest = JSON.parse(
    await readFile(join(process.cwd(), "extension", "manifest.json"), "utf8"),
  ) as Record<string, unknown>;

  assert.deepEqual(manifest.permissions, ["nativeMessaging", "scripting", "activeTab", "storage"]);
  assert.deepEqual(manifest.optional_host_permissions, ["https://*/*"]);
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.content_scripts, undefined);
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
  assert.throws(() => validateExtensionCommand("snapshot", { tabId: 0 }), /tabId/);
  assert.throws(() => validateExtensionCommand("goto", { tabId: 7, url: "http://example.test" }), /HTTPS/);
  assert.throws(() => validateExtensionCommand("snapshot", { tabId: 7, extra: true }), /unknown payload/);
});

test("content snapshot has the same structure-only shape as the Playwright scanner", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
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
    assert.equal(extensionSnapshot.fields[0]?.name, "email");
    assert.equal(extensionSnapshot.displayValues?.[0]?.labelText, "氏名");
    assert.equal(JSON.stringify(extensionSnapshot.fields).includes("山田 太郎"), false);
    assert.equal(JSON.stringify(extensionSnapshot.displayValues).includes("山田 太郎"), false);
  } finally {
    await browser.close();
  }
});
