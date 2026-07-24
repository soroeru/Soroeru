import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IPC_CHANNELS,
  IPC_CHANNEL_LIST,
  isIpcChannel,
  type DomainSummary,
  type VaultMutationResult,
  type VaultStatus,
} from "../../electron/ipc/contract.js";
import { createSoroeruApi } from "../../electron/preload-api.js";
import { createIpcBridge } from "../../electron/ipc/bridge.js";
import { normalizeChromePermissionOrigin, SoroeruSession } from "../../electron/session.js";
import { nativeHostIsRegistered } from "../../native-host/registration.js";
import { DomainService } from "../../src/domain/domain-service.js";
import { VaultV2 } from "../../src/store/vault-v2.js";

// Fake data only (docs/testing.md). Verifies RFC-002 §8.2 IPC permission rules:
// the renderer-facing API can reach only allowlisted channels, the main bridge
// exposes exactly that allowlist, and crossing values are sanitized.
const PASSPHRASE = "ipc-test-passphrase";
const CHROME_EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";

async function tmpVaultPath(): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "soroeru-ipc-"));
  return { dir, path: join(dir, "vault.json") };
}

test("the preload API invokes only allowlisted channels and covers the surface", async () => {
  const invoked: string[] = [];
  const api = createSoroeruApi((channel, ...args) => {
    invoked.push(channel);
    void args;
    return Promise.resolve(undefined);
  });

  // Every exposed method must exist and be callable.
  await api.vault.status();
  await api.vault.setup("x");
  await api.vault.unlock("x");
  await api.vault.unlockWithRecoveryKey("x");
  await api.vault.lock();
  await api.vault.generateRecoveryKey();
  await api.domain.summary();
  await api.csv.import("x");
  await api.savedPage.import({ siteAccountId: "x", fileName: "account.html", data: new Uint8Array() });
  await api.savedPage.openSite("x");
  await api.savedPage.markManualCheck("x");
  await api.ledger.sites();
  await api.ledger.site("x");
  await api.ledger.siteDetails();
  await api.ledger.reorderSites(["b", "a"]);
  await api.ledger.insights();
  await api.ledger.reveal("x", "y");
  await api.ledger.confirmDynamicCandidate({ proposedAttributeKey: "custom.x", label: "x" });
  await api.ledger.deleteSite({ siteAccountId: "x", confirmedFourthBoundary: true });
  await api.ledger.updateCredential({
    siteAccountId: "x",
    credentialId: "y",
    password: "z",
    confirmedOverwrite: true,
  });
  await api.sessionPersistence.set({ siteAccountId: "x", enabled: true });
  await api.sessionPersistence.clear("x");
  await api.visibility.run("x");
  await api.visibility.resume();
  await api.visibility.abort();
  await api.visibility.status();
  await api.chromeBridge.status();
  await api.chromeBridge.configuration();
  await api.chromeBridge.setConfiguration({ enabled: false, extensionId: "" });
  await api.chromeBridge.connect();
  await api.chromeBridge.disconnect();
  await api.chromeBridge.permissions();
  await api.chromeBridge.revokeOrigin("https://example.test");
  await api.chromeBridge.activeTab();
  await api.chromeBridge.selectTab(42);
  await api.chromeBridge.stop();
  // onEvent only subscribes (no channel invoke); calling it must not throw and
  // returns an unsubscribe function even with no subscribe transport provided.
  assert.equal(typeof api.visibility.onEvent(() => {}), "function");
  assert.equal(typeof api.chromeBridge.onEvent(() => {}), "function");
  await api.logs.export();

  for (const channel of invoked) {
    assert.ok(isIpcChannel(channel), `unexpected channel ${channel}`);
  }
  // The API exercises exactly the allowlist — no missing, no extra channels.
  assert.deepEqual([...invoked].sort(), [...IPC_CHANNEL_LIST].sort());
});

test("the main bridge registers exactly the allowlisted channels", async () => {
  const { dir, path } = await tmpVaultPath();
  try {
    const bridge = createIpcBridge(new SoroeruSession(path));
    assert.deepEqual(Object.keys(bridge).sort(), [...IPC_CHANNEL_LIST].sort());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("connected Chrome disconnect normalizes and revokes every origin before host cleanup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "soroeru-ipc-chrome-cleanup-"));
  const sourceBinary = join(dir, "host-source");
  const paths = {
    appSupportDir: join(dir, "Application Support"),
    chromeNativeMessagingDir: join(dir, "Chrome", "NativeMessagingHosts"),
  };
  const commands: Array<{ command: string; payload?: unknown }> = [];
  let connected = true;
  const chromeBridge = {
    isConnected: () => connected,
    sendCommand: async (command: string, payload?: unknown) => {
      commands.push({ command, ...(payload === undefined ? {} : { payload }) });
      if (command === "listPermissions") {
        return { origins: ["https://b.example/*", "https://a.example/*"] };
      }
      if (command === "removePermission") {
        const origin = (payload as { origin: string }).origin;
        return { removed: origin === "https://b.example" };
      }
      return undefined;
    },
    start: async () => undefined,
    close: async () => {
      connected = false;
    },
  };
  const logged: any[] = [];
  const logger = {
    info: (category: string, message: string, fields?: any) => {
      logged.push({ level: "info", category, message, fields });
    },
    warn: (category: string, message: string, fields?: any) => {
      logged.push({ level: "warn", category, message, fields });
    },
    error: (category: string, message: string, fields?: any) => {
      logged.push({ level: "error", category, message, fields });
    },
  };
  try {
    await writeFile(sourceBinary, "fake-host");
    const session = new SoroeruSession(join(dir, "vault.json"), {
      chromeBridge,
      chromeBridgeSetup: { sourceBinary, extensionId: "a".repeat(32), paths },
      logger,
    });
    assert.equal((await session.connectChromeBridge()).ok, true);
    assert.ok(logged.some(e => e.level === "info" && e.category === "chrome-bridge" && e.message === "native host registered successfully"));
    assert.ok(logged.some(e => e.level === "info" && e.category === "chrome-bridge" && e.message === "chrome bridge started successfully"));
    assert.equal(await nativeHostIsRegistered(paths), true);
    const result = await session.disconnectChromeBridge();
    assert.equal(result.ok, true);
    assert.ok(logged.some(e => e.level === "info" && e.category === "chrome-bridge" && e.message === "chrome bridge closed"));
    assert.ok(logged.some(e => e.level === "info" && e.category === "chrome-bridge" && e.message === "native host unregistered successfully"));
    assert.deepEqual("manualCleanupOrigins" in result ? result.manualCleanupOrigins : undefined, [
      "https://a.example",
    ]);
    assert.deepEqual(commands, [
      { command: "listPermissions" },
      { command: "removePermission", payload: { origin: "https://b.example" } },
      { command: "removePermission", payload: { origin: "https://a.example" } },
    ]);
    assert.equal(await nativeHostIsRegistered(paths), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Chrome bridge registration failure logs detailed error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "soroeru-ipc-chrome-fail-"));
  const sourceBinary = join(dir, "host-source");
  const paths = {
    appSupportDir: join(dir, "Application Support"),
    chromeNativeMessagingDir: join(dir, "Chrome", "NativeMessagingHosts"),
  };
  const logged: any[] = [];
  const logger = {
    info: (category: string, message: string, fields?: any) => {
      logged.push({ level: "info", category, message, fields });
    },
    warn: (category: string, message: string, fields?: any) => {
      logged.push({ level: "warn", category, message, fields });
    },
    error: (category: string, message: string, fields?: any) => {
      logged.push({ level: "error", category, message, fields });
    },
  };
  try {
    await writeFile(sourceBinary, "fake-host");
    const session = new SoroeruSession(join(dir, "vault.json"), {
      chromeBridge: {
        isConnected: () => false,
        sendCommand: async () => { throw new Error("not connected"); },
        start: async () => { throw new Error("failed to start"); }
      },
      // Pass 31 characters to trigger extension ID validation failure
      chromeBridgeSetup: { sourceBinary, extensionId: "a".repeat(31), paths },
      logger,
    });
    const result = await session.connectChromeBridge();
    // Invalid IDs fail closed before registration so the allowlist is never written wrong.
    assert.equal(result.ok, false);
    assert.equal(result.error, "invalid-extension-id");
    assert.equal(
      logged.some(
        (e) =>
          e.level === "error" &&
          e.category === "chrome-bridge" &&
          e.message === "native host registration failed",
      ),
      false,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("connect registers the stored extension ID when it differs from startup setup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "soroeru-ipc-chrome-stored-id-"));
  const sourceBinary = join(dir, "host-source");
  const paths = {
    appSupportDir: join(dir, "Application Support"),
    chromeNativeMessagingDir: join(dir, "Chrome", "NativeMessagingHosts"),
  };
  const startupId = "a".repeat(32);
  const storedId = "b".repeat(32);
  try {
    await writeFile(sourceBinary, "#!/usr/bin/env node\n");
    const session = new SoroeruSession(join(dir, "vault.json"), {
      chromeBridge: {
        isConnected: () => false,
        sendCommand: async () => undefined,
        start: async () => undefined,
      },
      chromeBridgeSetup: { sourceBinary, extensionId: startupId, paths },
      chromeBridgeSettings: {
        initial: {
          stored: { version: 1, enabled: true, extensionId: storedId },
          effective: {
            enabled: true,
            extensionId: startupId,
            enabledSource: "stored",
            extensionIdSource: "stored",
          },
        },
        save: async (input) => ({ version: 1 as const, ...input }),
      },
    });
    assert.equal((await session.connectChromeBridge()).ok, true);
    const manifest = JSON.parse(
      await readFile(join(paths.chromeNativeMessagingDir, "jp.soroeru.bridge.json"), "utf8"),
    ) as { allowed_origins: string[] };
    assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${storedId}/`]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("connect registers the environment override extension ID when env override is present", async () => {
  const dir = await mkdtemp(join(tmpdir(), "soroeru-ipc-chrome-env-id-"));
  const sourceBinary = join(dir, "host-source");
  const paths = {
    appSupportDir: join(dir, "Application Support"),
    chromeNativeMessagingDir: join(dir, "Chrome", "NativeMessagingHosts"),
  };
  const startupId = "a".repeat(32);
  const storedId = "b".repeat(32);
  const envId = "c".repeat(32);
  try {
    await writeFile(sourceBinary, "#!/usr/bin/env node\n");
    const session = new SoroeruSession(join(dir, "vault.json"), {
      chromeBridge: {
        isConnected: () => false,
        sendCommand: async () => undefined,
        start: async () => undefined,
      },
      chromeBridgeSetup: { sourceBinary, extensionId: startupId, paths },
      chromeBridgeSettings: {
        initial: {
          stored: { version: 1, enabled: true, extensionId: storedId },
          effective: {
            enabled: true,
            extensionId: envId,
            enabledSource: "stored",
            extensionIdSource: "environment",
          },
        },
        save: async (input) => ({ version: 1 as const, ...input }),
      },
    });
    assert.equal((await session.connectChromeBridge()).ok, true);
    const manifest = JSON.parse(
      await readFile(join(paths.chromeNativeMessagingDir, "jp.soroeru.bridge.json"), "utf8"),
    ) as { allowed_origins: string[] };
    assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${envId}/`]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Chrome bridge configuration persists enablement and reports restart-required state", async () => {
  const saved: Array<{ enabled: boolean; extensionId: string }> = [];
  const session = new SoroeruSession(join(tmpdir(), "unused-chrome-settings-vault.json"), {
    chromeBridgeSettings: {
      initial: {
        stored: { version: 1, enabled: false, extensionId: "" },
        effective: {
          enabled: false,
          extensionId: "",
          enabledSource: "stored",
          extensionIdSource: "stored",
        },
      },
      save: async (input) => {
        saved.push(input);
        return { version: 1 as const, ...input };
      },
    },
  });

  assert.equal((await session.chromeBridgeConfiguration()).restartRequired, false);
  const result = await session.setChromeBridgeConfiguration({
    enabled: true,
    extensionId: CHROME_EXTENSION_ID,
  });
  assert.equal(result.ok, true);
  assert.equal(result.configuration?.restartRequired, true);
  assert.deepEqual(saved, [{ enabled: true, extensionId: CHROME_EXTENSION_ID }]);
});

test("Chrome bridge configuration rejects invalid IDs without persistence", async () => {
  let saved = false;
  const session = new SoroeruSession(join(tmpdir(), "unused-invalid-chrome-settings-vault.json"), {
    chromeBridgeSettings: {
      initial: {
        stored: { version: 1, enabled: false, extensionId: "" },
        effective: {
          enabled: false,
          extensionId: "",
          enabledSource: "stored",
          extensionIdSource: "stored",
        },
      },
      save: async (input) => {
        saved = true;
        return { version: 1 as const, ...input };
      },
    },
  });
  assert.deepEqual(await session.setChromeBridgeConfiguration({ enabled: true, extensionId: "invalid" }), {
    ok: false,
    error: "invalid-extension-id",
  });
  assert.equal(saved, false);
});

test("Chrome bridge configuration rejects non-boolean IPC input", async () => {
  let saved = false;
  const session = new SoroeruSession(join(tmpdir(), "unused-invalid-ipc-settings-vault.json"), {
    chromeBridgeSettings: {
      initial: {
        stored: { version: 1, enabled: false, extensionId: "" },
        effective: {
          enabled: false,
          extensionId: "",
          enabledSource: "stored",
          extensionIdSource: "stored",
        },
      },
      save: async (input) => {
        saved = true;
        return { version: 1 as const, ...input };
      },
    },
  });
  const bridge = createIpcBridge(session);
  assert.deepEqual(
    await bridge[IPC_CHANNELS.chromeBridgeSetConfiguration]({
      enabled: "true",
      extensionId: CHROME_EXTENSION_ID,
    }),
    { ok: false, error: "invalid-request" },
  );
  assert.equal(saved, false);
});

test("disabling an unregistered listener closes it before persisting OFF", async () => {
  const order: string[] = [];
  const session = new SoroeruSession(join(tmpdir(), "unused-unregistered-disable-vault.json"), {
    chromeBridge: {
      isConnected: () => false,
      sendCommand: async () => {
        throw new Error("must not query permissions without registration");
      },
      close: async () => {
        order.push("close");
      },
    },
    chromeBridgeSettings: {
      initial: {
        stored: { version: 1, enabled: true, extensionId: CHROME_EXTENSION_ID },
        effective: {
          enabled: true,
          extensionId: CHROME_EXTENSION_ID,
          enabledSource: "stored",
          extensionIdSource: "stored",
        },
      },
      save: async (input) => {
        order.push("save");
        return { version: 1 as const, ...input };
      },
    },
  });
  const result = await session.setChromeBridgeConfiguration({
    enabled: false,
    extensionId: CHROME_EXTENSION_ID,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(order, ["close", "save"]);
});

test("disabling does not persist OFF when permission cleanup is uncertain", async () => {
  let saved = false;
  const session = new SoroeruSession(join(tmpdir(), "unused-disable-chrome-settings-vault.json"), {
    chromeBridge: {
      isConnected: () => true,
      sendCommand: async () => {
        throw new Error("Chrome closed");
      },
      close: async () => undefined,
    },
    chromeBridgeSetup: {
      sourceBinary: "/unused/host",
      extensionId: CHROME_EXTENSION_ID,
      paths: {
        appSupportDir: join(tmpdir(), "unused-app-support"),
        chromeNativeMessagingDir: join(tmpdir(), "unused-native-host"),
      },
    },
    chromeBridgeSettings: {
      initial: {
        stored: { version: 1, enabled: true, extensionId: CHROME_EXTENSION_ID },
        effective: {
          enabled: true,
          extensionId: CHROME_EXTENSION_ID,
          enabledSource: "stored",
          extensionIdSource: "stored",
        },
      },
      save: async (input) => {
        saved = true;
        return { version: 1 as const, ...input };
      },
    },
  });

  const result = await session.setChromeBridgeConfiguration({
    enabled: false,
    extensionId: CHROME_EXTENSION_ID,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "cleanup-incomplete");
  assert.equal(saved, false);
});

test("disconnect surfaces listener close failure", async () => {
  const session = new SoroeruSession(join(tmpdir(), "unused-close-failure-vault.json"), {
    chromeBridge: {
      isConnected: () => false,
      sendCommand: async () => ({ origins: [] }),
      close: async () => {
        throw new Error("close failed");
      },
    },
    chromeBridgeSetup: {
      sourceBinary: "/unused/host",
      extensionId: CHROME_EXTENSION_ID,
      paths: {
        appSupportDir: join(tmpdir(), "unused-close-app-support"),
        chromeNativeMessagingDir: join(tmpdir(), "unused-close-native-host"),
      },
    },
  });
  const result = await session.disconnectChromeBridge();
  assert.equal(result.ok, false);
  assert.equal(result.error, "cleanup-failed");
});

test("connect is rejected after OFF is stored pending restart", async () => {
  const session = new SoroeruSession(join(tmpdir(), "unused-pending-off-vault.json"), {
    chromeBridge: {
      isConnected: () => false,
      sendCommand: async () => undefined,
    },
    chromeBridgeSetup: {
      sourceBinary: "/unused/host",
      extensionId: CHROME_EXTENSION_ID,
      paths: {
        appSupportDir: join(tmpdir(), "unused-pending-off-app-support"),
        chromeNativeMessagingDir: join(tmpdir(), "unused-pending-off-native-host"),
      },
    },
    chromeBridgeSettings: {
      initial: {
        stored: { version: 1, enabled: false, extensionId: CHROME_EXTENSION_ID },
        effective: {
          enabled: true,
          extensionId: CHROME_EXTENSION_ID,
          enabledSource: "stored",
          extensionIdSource: "stored",
        },
      },
      save: async (input) => ({ version: 1 as const, ...input }),
    },
  });
  assert.deepEqual(await session.connectChromeBridge(), { ok: false, error: "restart-required" });
});

test("Chrome permission patterns normalize to HTTPS origins only", () => {
  assert.equal(normalizeChromePermissionOrigin("https://example.test/*"), "https://example.test");
  assert.equal(normalizeChromePermissionOrigin("http://example.test/*"), undefined);
  assert.equal(normalizeChromePermissionOrigin("not-a-pattern"), undefined);
});

test("Chrome disconnect reports permission state unknown when enumeration fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "soroeru-ipc-chrome-unknown-"));
  const sourceBinary = join(dir, "host-source");
  const paths = {
    appSupportDir: join(dir, "Application Support"),
    chromeNativeMessagingDir: join(dir, "Chrome", "NativeMessagingHosts"),
  };
  try {
    await writeFile(sourceBinary, "fake-host");
    const session = new SoroeruSession(join(dir, "vault.json"), {
      chromeBridge: {
        isConnected: () => false,
        sendCommand: async () => {
          throw new Error("Chrome closed");
        },
        close: async () => undefined,
      },
      chromeBridgeSetup: { sourceBinary, extensionId: "a".repeat(32), paths },
    });
    assert.equal((await session.connectChromeBridge()).ok, true);
    const result = await session.disconnectChromeBridge();
    assert.equal("permissionsCleanupUnknown" in result && result.permissionsCleanupUnknown, true);
    assert.equal(await nativeHostIsRegistered(paths), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("single-origin revoke fails when Chrome reports removed false", async () => {
  const session = new SoroeruSession(join(tmpdir(), "unused-chrome-revoke-vault.json"), {
    chromeBridge: {
      isConnected: () => true,
      sendCommand: async () => ({ removed: false }),
    },
  });
  assert.deepEqual(await session.revokeChromeBridgeOrigin("https://example.test"), {
    ok: false,
    error: "permission-remove-failed",
  });
});

test("status reports first-run before setup and unlocked after", async () => {
  const { dir, path } = await tmpVaultPath();
  try {
    const session = new SoroeruSession(path);
    const bridge = createIpcBridge(session);

    const before = (await bridge[IPC_CHANNELS.vaultStatus]()) as VaultStatus;
    assert.equal(before.exists, false);
    assert.equal(before.locked, true);

    const setup = (await bridge[IPC_CHANNELS.vaultSetup](PASSPHRASE)) as VaultMutationResult;
    assert.equal(setup.ok, true);
    assert.equal(setup.locked, false);

    const after = (await bridge[IPC_CHANNELS.vaultStatus]()) as VaultStatus;
    assert.equal(after.exists, true);
    assert.equal(after.locked, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the domain summary is sanitized: masked previews, no raw values leak", async () => {
  const { dir, path } = await tmpVaultPath();
  try {
    // Seed canonical attributes (incl. the most-sensitive CVV) then lock.
    const vault = await VaultV2.open(path, PASSPHRASE);
    const domain = new DomainService(vault);
    domain.setPersonalAttribute({ attributeKey: "email", label: "メール", value: "user@example.test" });
    // Distinctive canary (not a 3-digit value) so the no-leak substring check
    // below cannot coincidentally match random hex in UUIDs/timestamps.
    domain.setPersonalAttribute({ attributeKey: "card.cvv", label: "CVV", value: "CVV-CANARY-LEAK" });
    await vault.save();
    vault.lock();

    const session = new SoroeruSession(path);
    const bridge = createIpcBridge(session);
    const unlock = (await bridge[IPC_CHANNELS.vaultUnlock](PASSPHRASE)) as VaultMutationResult;
    assert.equal(unlock.ok, true);

    const summary = (await bridge[IPC_CHANNELS.domainSummary]()) as DomainSummary;
    assert.equal(summary.locked, false);
    assert.equal(summary.attributeCount, 2);

    for (const attr of summary.attributes) {
      assert.match(attr.preview, /^•*$/, `preview must be masked bullets, got ${attr.preview}`);
    }
    const cvv = summary.attributes.find((a) => a.attributeKey === "card.cvv");
    assert.equal(cvv?.sensitivity, "most-sensitive");

    // No raw value may appear anywhere in the serialized response.
    const serialized = JSON.stringify(summary);
    assert.equal(serialized.includes("user@example.test"), false);
    assert.equal(serialized.includes("@example"), false);
    assert.equal(serialized.includes("CVV-CANARY-LEAK"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a wrong passphrase is reported without unlocking and without leaking why", async () => {
  const { dir, path } = await tmpVaultPath();
  try {
    const setupSession = new SoroeruSession(path);
    await createIpcBridge(setupSession)[IPC_CHANNELS.vaultSetup](PASSPHRASE);

    const session = new SoroeruSession(path);
    const bridge = createIpcBridge(session);
    const unlock = (await bridge[IPC_CHANNELS.vaultUnlock]("wrong-passphrase")) as VaultMutationResult;
    assert.equal(unlock.ok, false);
    assert.equal(unlock.locked, true);

    const summary = (await bridge[IPC_CHANNELS.domainSummary]()) as DomainSummary;
    assert.equal(summary.locked, true);
    assert.equal(summary.attributeCount, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("setup rejects a too-short passphrase at the trusted boundary", async () => {
  const { dir, path } = await tmpVaultPath();
  try {
    const session = new SoroeruSession(path);
    const bridge = createIpcBridge(session);

    const weak = (await bridge[IPC_CHANNELS.vaultSetup]("short")) as VaultMutationResult;
    assert.equal(weak.ok, false);
    assert.equal(weak.error, "passphrase-too-short");

    // The vault must not have been created by the rejected setup.
    const status = (await bridge[IPC_CHANNELS.vaultStatus]()) as VaultStatus;
    assert.equal(status.exists, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("saved page import rejects mhtml files at the trusted boundary", async () => {
  const { dir, path } = await tmpVaultPath();
  try {
    const session = new SoroeruSession(path);
    const bridge = createIpcBridge(session);
    await bridge[IPC_CHANNELS.vaultSetup](PASSPHRASE);
    const csv = [
      "name,url,username,password,note",
      "Example,https://example.test/account,user@example.test,secret,",
    ].join("\n");
    const importResult = (await bridge[IPC_CHANNELS.csvImport](csv)) as {
      ok: boolean;
      error?: string;
      summary?: { siteAccountIds: string[] };
    };
    assert.equal(importResult.ok, true);
    const siteAccountId = importResult.summary?.siteAccountIds[0];
    if (!siteAccountId) throw new Error("expected site account id");

    const result = (await bridge[IPC_CHANNELS.savedPageImport]({
      siteAccountId,
      fileName: "account.mhtml",
      data: new Uint8Array(),
    })) as { ok: boolean; error?: string };
    assert.equal(result.ok, false);
    assert.equal(result.error, "bad-file-type");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("saved page import rejects oversized files before parsing", async () => {
  const { dir, path } = await tmpVaultPath();
  try {
    const session = new SoroeruSession(path);
    const bridge = createIpcBridge(session);
    await bridge[IPC_CHANNELS.vaultSetup](PASSPHRASE);
    const csv = [
      "name,url,username,password,note",
      "Example,https://example.test/account,user@example.test,secret,",
    ].join("\n");
    const importResult = (await bridge[IPC_CHANNELS.csvImport](csv)) as {
      ok: boolean;
      summary?: { siteAccountIds: string[] };
    };
    assert.equal(importResult.ok, true);
    const siteAccountId = importResult.summary?.siteAccountIds[0];
    if (!siteAccountId) throw new Error("expected site account id");

    const result = (await bridge[IPC_CHANNELS.savedPageImport]({
      siteAccountId,
      fileName: "account.html",
      data: new Uint8Array(5 * 1024 * 1024 + 1),
    })) as { ok: boolean; error?: string };
    assert.equal(result.ok, false);
    assert.equal(result.error, "too-large");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("saved page import does not mark a site collected when no disclosures are found", async () => {
  const { dir, path } = await tmpVaultPath();
  try {
    const session = new SoroeruSession(path);
    const bridge = createIpcBridge(session);
    await bridge[IPC_CHANNELS.vaultSetup](PASSPHRASE);
    const csv = [
      "name,url,username,password,note",
      "Example,https://example.test/account,user@example.test,secret,",
    ].join("\n");
    const importResult = (await bridge[IPC_CHANNELS.csvImport](csv)) as {
      ok: boolean;
      error?: string;
      summary?: { siteAccountIds: string[] };
    };
    assert.equal(importResult.ok, true);
    const siteAccountId = importResult.summary?.siteAccountIds[0];
    if (!siteAccountId) throw new Error("expected site account id");

    const blankHtml = "<!doctype html><html><body><main>blank</main></body></html>";
    const result = (await bridge[IPC_CHANNELS.savedPageImport]({
      siteAccountId,
      fileName: "account.html",
      data: new TextEncoder().encode(blankHtml),
    })) as { ok: boolean; summary?: { disclosures: number }; error?: string };
    assert.equal(result.ok, true);
    assert.equal(result.summary?.disclosures, 0);

    const sites = (await bridge[IPC_CHANNELS.ledgerSites]()) as Array<{
      siteAccountId: string;
      collected: boolean;
    }>;
    assert.equal(sites.find((site) => site.siteAccountId === siteAccountId)?.collected, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("saved page import is rejected while a visibility run is in progress", async () => {
  const { dir, path } = await tmpVaultPath();
  let releaseRun: (() => void) | undefined;
  try {
    const runBlocker = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    const session = new SoroeruSession(path, {
      openSession: async () => {
        await runBlocker;
        throw new Error("stop run");
      },
    });
    const bridge = createIpcBridge(session);
    await bridge[IPC_CHANNELS.vaultSetup](PASSPHRASE);
    const csv = [
      "name,url,username,password,note",
      "Example,https://example.test/account,user@example.test,secret,",
    ].join("\n");
    const importResult = (await bridge[IPC_CHANNELS.csvImport](csv)) as {
      ok: boolean;
      summary?: { siteAccountIds: string[] };
    };
    assert.equal(importResult.ok, true);
    const siteAccountId = importResult.summary?.siteAccountIds[0];
    if (!siteAccountId) throw new Error("expected site account id");

    const runPromise = bridge[IPC_CHANNELS.visibilityRun](siteAccountId);
    await waitFor(async () => {
      const status = (await bridge[IPC_CHANNELS.visibilityStatus]()) as { running: boolean };
      return status.running;
    });

    const result = (await bridge[IPC_CHANNELS.savedPageImport]({
      siteAccountId,
      fileName: "account.html",
      data: new TextEncoder().encode("<!doctype html><html></html>"),
    })) as { ok: boolean; error?: string };
    assert.equal(result.ok, false);
    assert.equal(result.error, "busy");

    releaseRun?.();
    await runPromise;
  } finally {
    releaseRun?.();
    await rm(dir, { recursive: true, force: true });
  }
});

test("saved page fallback opens a site in the default browser via an injected opener", async () => {
  const { dir, path } = await tmpVaultPath();
  const opened: string[] = [];
  try {
    const session = new SoroeruSession(path, {
      openExternal: async (url) => {
        opened.push(url);
      },
    });
    const bridge = createIpcBridge(session);
    await bridge[IPC_CHANNELS.vaultSetup](PASSPHRASE);
    const csv = [
      "name,url,username,password,note",
      "Example,https://example.test/account,user@example.test,secret,",
    ].join("\n");
    const importResult = (await bridge[IPC_CHANNELS.csvImport](csv)) as {
      ok: boolean;
      summary?: { siteAccountIds: string[] };
    };
    assert.equal(importResult.ok, true);
    const siteAccountId = importResult.summary?.siteAccountIds[0];
    if (!siteAccountId) throw new Error("expected site account id");

    const result = (await bridge[IPC_CHANNELS.savedPageOpenSite](siteAccountId)) as {
      ok: boolean;
      url?: string;
      error?: string;
    };
    assert.equal(result.ok, true);
    assert.equal(result.url, "https://example.test/account");
    assert.deepEqual(opened, ["https://example.test/account"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("saved page fallback refuses to open non-web URLs in the default browser", async () => {
  const { dir, path } = await tmpVaultPath();
  const opened: string[] = [];
  try {
    const vault = await VaultV2.open(path, PASSPHRASE);
    const domain = new DomainService(vault);
    const site = domain.upsertSiteAccount({
      domain: "example.test",
      url: "file:///Users/example/private.html",
      displayName: "Example",
    });
    await vault.save();
    vault.lock();

    const session = new SoroeruSession(path, {
      openExternal: async (url) => {
        opened.push(url);
      },
    });
    const bridge = createIpcBridge(session);
    await bridge[IPC_CHANNELS.vaultUnlock](PASSPHRASE);

    const result = (await bridge[IPC_CHANNELS.savedPageOpenSite](site.id)) as {
      ok: boolean;
      error?: string;
    };
    assert.equal(result.ok, false);
    assert.equal(result.error, "bad-url");
    assert.deepEqual(opened, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("saved page fallback manual-check is rejected while a visibility run is in progress", async () => {
  const { dir, path } = await tmpVaultPath();
  let releaseRun: (() => void) | undefined;
  try {
    const runBlocker = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    const session = new SoroeruSession(path, {
      openSession: async () => {
        await runBlocker;
        throw new Error("stop run");
      },
    });
    const bridge = createIpcBridge(session);
    await bridge[IPC_CHANNELS.vaultSetup](PASSPHRASE);
    const csv = [
      "name,url,username,password,note",
      "Example,https://example.test/account,user@example.test,secret,",
    ].join("\n");
    const importResult = (await bridge[IPC_CHANNELS.csvImport](csv)) as {
      ok: boolean;
      summary?: { siteAccountIds: string[] };
    };
    assert.equal(importResult.ok, true);
    const siteAccountId = importResult.summary?.siteAccountIds[0];
    if (!siteAccountId) throw new Error("expected site account id");

    const runPromise = bridge[IPC_CHANNELS.visibilityRun](siteAccountId);
    await waitFor(async () => {
      const status = (await bridge[IPC_CHANNELS.visibilityStatus]()) as { running: boolean };
      return status.running;
    });

    const result = (await bridge[IPC_CHANNELS.savedPageMarkManual](siteAccountId)) as {
      ok: boolean;
      error?: string;
    };
    assert.equal(result.ok, false);
    assert.equal(result.error, "busy");

    releaseRun?.();
    await runPromise;
  } finally {
    releaseRun?.();
    await rm(dir, { recursive: true, force: true });
  }
});

test("saved page fallback skip records a manual-check constraint without marking the site collected", async () => {
  const { dir, path } = await tmpVaultPath();
  try {
    const session = new SoroeruSession(path);
    const bridge = createIpcBridge(session);
    await bridge[IPC_CHANNELS.vaultSetup](PASSPHRASE);
    const csv = [
      "name,url,username,password,note",
      "Example,https://example.test/account,user@example.test,secret,",
    ].join("\n");
    const importResult = (await bridge[IPC_CHANNELS.csvImport](csv)) as {
      ok: boolean;
      summary?: { siteAccountIds: string[] };
    };
    assert.equal(importResult.ok, true);
    const siteAccountId = importResult.summary?.siteAccountIds[0];
    if (!siteAccountId) throw new Error("expected site account id");

    const result = (await bridge[IPC_CHANNELS.savedPageMarkManual](siteAccountId)) as {
      ok: boolean;
      error?: string;
    };
    assert.equal(result.ok, true);

    const detail = (await bridge[IPC_CHANNELS.ledgerSite](siteAccountId)) as {
      collected: boolean;
      constraints: Array<{ kind: string; detail: string; resolution?: string }>;
    };
    assert.equal(detail.collected, false);
    const manual = detail.constraints.find((constraint) => constraint.detail.includes("手動で確認"));
    assert.equal(manual?.kind, "unknown-state");
    assert.equal(manual?.resolution, "user-stopped");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the session-persistence channels coerce the request shape and route through to the session", async () => {
  const { dir, path } = await tmpVaultPath();
  try {
    const vault = await VaultV2.open(path, PASSPHRASE);
    const domain = new DomainService(vault);
    const site = domain.upsertSiteAccount({ domain: "example.test", displayName: "Example" });
    await vault.save();
    vault.lock();

    const session = new SoroeruSession(path);
    const bridge = createIpcBridge(session);
    assert.equal(((await bridge[IPC_CHANNELS.vaultUnlock](PASSPHRASE)) as VaultMutationResult).ok, true);

    const set = (await bridge[IPC_CHANNELS.sessionPersistenceSet]({
      siteAccountId: site.id,
      enabled: true,
    })) as { ok: boolean; state?: { enabled: boolean } };
    assert.equal(set.ok, true);
    assert.equal(set.state?.enabled, true);

    const cleared = (await bridge[IPC_CHANNELS.sessionPersistenceClear](site.id)) as { ok: boolean };
    assert.equal(cleared.ok, true);

    // A malformed (non-object) request must not throw; it coerces to empty/false.
    const malformed = (await bridge[IPC_CHANNELS.sessionPersistenceSet](null)) as {
      ok: boolean;
      error?: string;
    };
    assert.equal(malformed.ok, false);
    assert.equal(malformed.error, "not-found");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("logs export reads back what the trusted layer logged, with no raw credential leaking", async () => {
  const { dir, path } = await tmpVaultPath();
  try {
    const session = new SoroeruSession(path);
    const bridge = createIpcBridge(session);
    await bridge[IPC_CHANNELS.vaultSetup](PASSPHRASE);
    const csv = [
      "name,url,username,password,note",
      "Example,https://example.test/account,user@example.test,super-secret-password,",
    ].join("\n");
    await bridge[IPC_CHANNELS.csvImport](csv);

    const exported = (await bridge[IPC_CHANNELS.logsExport]()) as {
      ok: boolean;
      fileName?: string;
      content?: string;
    };
    assert.equal(exported.ok, true);
    assert.match(exported.fileName ?? "", /^soroeru-log-.*\.log$/);
    assert.ok(exported.content?.includes("csv import completed"));
    assert.equal(exported.content?.includes("super-secret-password"), false);
    assert.equal(exported.content?.includes("user@example.test"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("logs export reports read-failed instead of silently returning empty content on a genuine read error", async () => {
  const { dir, path } = await tmpVaultPath();
  try {
    // A directory in place of the expected log file makes the underlying
    // read fail with EISDIR (not ENOENT), so this must surface as an error
    // rather than a successful empty-content download.
    const logPath = join(dir, "logs", "soroeru.log");
    await mkdir(logPath, { recursive: true });

    const session = new SoroeruSession(path, { logPath });
    const bridge = createIpcBridge(session);
    await bridge[IPC_CHANNELS.vaultSetup](PASSPHRASE);

    const exported = (await bridge[IPC_CHANNELS.logsExport]()) as { ok: boolean; error?: string };
    assert.equal(exported.ok, false);
    assert.equal(exported.error, "read-failed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("isIpcChannel rejects channels outside the allowlist", () => {
  assert.equal(isIpcChannel("soroeru:vault:status"), true);
  assert.equal(isIpcChannel("soroeru:vault:delete-everything"), false);
  assert.equal(isIpcChannel("fs:readFile"), false);
});

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    if (await predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition not met");
}
