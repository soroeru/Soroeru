import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
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
import { SoroeruSession } from "../../electron/session.js";
import { DomainService } from "../../src/domain/domain-service.js";
import { VaultV2 } from "../../src/store/vault-v2.js";

// Fake data only (docs/testing.md). Verifies RFC-002 §8.2 IPC permission rules:
// the renderer-facing API can reach only allowlisted channels, the main bridge
// exposes exactly that allowlist, and crossing values are sanitized.
const PASSPHRASE = "ipc-test-passphrase";

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
  await api.ledger.insights();
  await api.ledger.reveal("x", "y");
  await api.visibility.run("x");
  await api.visibility.resume();
  await api.visibility.abort();
  await api.visibility.status();
  // onEvent only subscribes (no channel invoke); calling it must not throw and
  // returns an unsubscribe function even with no subscribe transport provided.
  assert.equal(typeof api.visibility.onEvent(() => {}), "function");

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
