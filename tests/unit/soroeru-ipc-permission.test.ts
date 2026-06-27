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
  await api.vault.lock();
  await api.domain.summary();

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
    domain.setPersonalAttribute({ attributeKey: "card.cvv", label: "CVV", value: "123" });
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
    assert.equal(serialized.includes("123"), false);
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

test("isIpcChannel rejects channels outside the allowlist", () => {
  assert.equal(isIpcChannel("soroeru:vault:status"), true);
  assert.equal(isIpcChannel("soroeru:vault:delete-everything"), false);
  assert.equal(isIpcChannel("fs:readFile"), false);
});
