import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ChromeBridgeSettingsStore,
  isValidChromeExtensionId,
} from "../../electron/chrome-bridge-settings.js";

const VALID_ID = "abcdefghijklmnopabcdefghijklmnop";

test("Chrome extension IDs use Chrome's strict lowercase a-p alphabet", () => {
  assert.equal(isValidChromeExtensionId(VALID_ID), true);
  assert.equal(isValidChromeExtensionId("a".repeat(31)), false);
  assert.equal(isValidChromeExtensionId("q".repeat(32)), false);
  assert.equal(isValidChromeExtensionId("A".repeat(32)), false);
});

test("missing and malformed settings fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "soroeru-bridge-settings-"));
  try {
    const store = new ChromeBridgeSettingsStore(join(root, "chrome-bridge-settings.json"));
    assert.deepEqual(await store.load(), { version: 1, enabled: false, extensionId: "" });
    await writeFile(store.filePath, JSON.stringify({ version: 1, enabled: true, extensionId: "invalid" }));
    assert.deepEqual(await store.load(), { version: 1, enabled: false, extensionId: "" });
    await writeFile(store.filePath, "{broken");
    assert.deepEqual(await store.load(), { version: 1, enabled: false, extensionId: "" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolution uses environment then stored values then defaults per field", async () => {
  const root = await mkdtemp(join(tmpdir(), "soroeru-bridge-settings-"));
  try {
    const store = new ChromeBridgeSettingsStore(join(root, "chrome-bridge-settings.json"));
    await store.save({ enabled: true, extensionId: VALID_ID });

    assert.deepEqual(await store.resolve({}), {
      stored: { version: 1, enabled: true, extensionId: VALID_ID },
      effective: {
        enabled: true,
        extensionId: VALID_ID,
        enabledSource: "stored",
        extensionIdSource: "stored",
      },
    });
    assert.deepEqual(await store.resolve({ SOROERU_ENABLE_CHROME_BRIDGE: "0" }), {
      stored: { version: 1, enabled: true, extensionId: VALID_ID },
      effective: {
        enabled: false,
        extensionId: VALID_ID,
        enabledSource: "environment",
        extensionIdSource: "stored",
      },
    });
    const invalid = await store.resolve({
      SOROERU_ENABLE_CHROME_BRIDGE: "1",
      SOROERU_CHROME_EXTENSION_ID: "invalid",
    });
    assert.equal(invalid.effective.enabled, false);
    assert.equal(invalid.effective.extensionId, "");
    assert.equal(invalid.effective.enabledSource, "environment");
    assert.equal(invalid.effective.extensionIdSource, "environment");
    assert.equal(invalid.validationError, "invalid-extension-id");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolution identifies defaults when no settings document exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "soroeru-bridge-settings-"));
  try {
    const store = new ChromeBridgeSettingsStore(join(root, "chrome-bridge-settings.json"));
    const resolved = await store.resolve({});
    assert.equal(resolved.effective.enabledSource, "default");
    assert.equal(resolved.effective.extensionIdSource, "default");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("save atomically persists a private versioned settings document", async () => {
  const root = await mkdtemp(join(tmpdir(), "soroeru-bridge-settings-"));
  try {
    const store = new ChromeBridgeSettingsStore(join(root, "chrome-bridge-settings.json"));
    await store.save({ enabled: true, extensionId: VALID_ID });
    assert.deepEqual(JSON.parse(await readFile(store.filePath, "utf8")), {
      version: 1,
      enabled: true,
      extensionId: VALID_ID,
    });
    assert.equal((await stat(store.filePath)).mode & 0o777, 0o600);
    assert.deepEqual(await store.load(), { version: 1, enabled: true, extensionId: VALID_ID });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
