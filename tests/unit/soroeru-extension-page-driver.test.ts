// Issue #338: ExtensionPageDriver + fake bridge transport + VisibilityRunner
// integration. Proves the existing runner login / collection / wall-handoff /
// checkpoint path works unchanged on the extension surface, and that browser-side
// interruption (timeout / disconnect) maps to explicit failure without hanging.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ExtensionBridgeError,
  ExtensionPageDriver,
  openExtensionTabSession,
  type ChromeBridgeTransport,
} from "../../src/automation/extension-page-driver.js";
import { VisibilityRunner } from "../../src/automation/visibility-runner.js";
import { DomainService } from "../../src/domain/domain-service.js";
import { VaultV2 } from "../../src/store/vault-v2.js";
import type { FormField, PageSnapshot } from "../../src/types.js";

const PASSPHRASE = "extension-page-driver-test-passphrase";

function field(fieldId: string, partial: Partial<FormField> = {}): FormField {
  return {
    fieldId,
    tag: "input",
    type: "text",
    name: "",
    id: fieldId,
    autocomplete: "",
    required: false,
    placeholder: "",
    labels: [],
    nearbyText: "",
    ...partial,
  };
}

function snapshot(url: string, partial: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    url,
    title: "Test",
    fields: [],
    buttons: [],
    links: [],
    visibleText: "",
    iframeSrcs: [],
    wallMarkers: [],
    ...partial,
  };
}

/** Scripted fake transport: maps command names to sequential payload queues. */
class FakeBridgeTransport implements ChromeBridgeTransport {
  connected = true;
  readonly calls: Array<{ command: string; payload: unknown }> = [];
  private readonly queues = new Map<string, unknown[]>();
  private readonly errors = new Map<string, Error[]>();
  private delayMs = 0;

  enqueue(command: string, payload: unknown): void {
    const list = this.queues.get(command) ?? [];
    list.push(payload);
    this.queues.set(command, list);
  }

  enqueueError(command: string, error: Error): void {
    const list = this.errors.get(command) ?? [];
    list.push(error);
    this.errors.set(command, list);
  }

  setDelay(ms: number): void {
    this.delayMs = ms;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async sendCommand(command: string, payload?: unknown, options?: { timeoutMs?: number }): Promise<unknown> {
    this.calls.push({ command, payload });
    if (!this.connected) throw new Error("chrome bridge disconnected");
    if (this.delayMs > 0) {
      const timeoutMs = options?.timeoutMs ?? 30_000;
      if (this.delayMs > timeoutMs) {
        throw new Error(`chrome bridge command timeout: ${command}`);
      }
      await new Promise((r) => setTimeout(r, this.delayMs));
    }
    const errQueue = this.errors.get(command);
    if (errQueue && errQueue.length > 0) throw errQueue.shift()!;
    const queue = this.queues.get(command);
    if (!queue || queue.length === 0) {
      throw new Error(`no scripted response for ${command}`);
    }
    return queue.shift();
  }
}

async function withDomain(run: (domain: DomainService) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "soroeru-extension-driver-"));
  try {
    const vault = await VaultV2.open(join(dir, "vault.json"), PASSPHRASE);
    await run(new DomainService(vault));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("ExtensionPageDriver maps PageDriver methods onto bridge commands with tabId", async () => {
  const transport = new FakeBridgeTransport();
  const pageSnap = snapshot("https://shop.example.test/account", {
    fields: [field("f-email", { autocomplete: "email" })],
  });
  transport.enqueue("goto", { url: "https://shop.example.test/account" });
  transport.enqueue("waitForReady", undefined);
  transport.enqueue("snapshot", pageSnap);
  transport.enqueue("readValues", { "f-email": "user@example.test" });
  transport.enqueue("readDisplayValues", { "d-phone": "03-0000-0000" });
  transport.enqueue("fillField", { ok: true });
  transport.enqueue("click", { ok: true });

  const driver = new ExtensionPageDriver(transport, 42);
  await driver.goto("https://shop.example.test/account");
  assert.equal(driver.currentUrl(), "https://shop.example.test/account");
  await driver.waitForReady();
  assert.deepEqual(await driver.snapshot(), pageSnap);
  assert.deepEqual(await driver.readValues(), { "f-email": "user@example.test" });
  assert.deepEqual(await driver.readDisplayValues(), { "d-phone": "03-0000-0000" });
  await driver.fillField("f-email", "user@example.test");
  await driver.click("button[type=submit]");

  assert.deepEqual(
    transport.calls.map((c) => c.command),
    ["goto", "waitForReady", "snapshot", "readValues", "readDisplayValues", "fillField", "click"],
  );
  assert.equal((transport.calls[0]?.payload as { tabId: number }).tabId, 42);
  assert.equal((transport.calls[5]?.payload as { fieldId: string; value: string }).fieldId, "f-email");
  assert.equal((transport.calls[5]?.payload as { value: string }).value, "user@example.test");
});

test("openExtensionTabSession close unbinds without further commands and has no exportStorageState", async () => {
  const transport = new FakeBridgeTransport();
  const session = openExtensionTabSession(transport, { tabId: 7 });
  assert.equal(typeof session.exportStorageState, "undefined");
  await session.close();
  await assert.rejects(() => session.page.snapshot(), (err: unknown) => {
    assert.ok(err instanceof ExtensionBridgeError);
    assert.match(err.message, /closed/);
    return true;
  });
  // Second close is idempotent.
  await session.close();
});

test("openExtensionTabSession refuses a disconnected transport", () => {
  const transport = new FakeBridgeTransport();
  transport.connected = false;
  assert.throws(() => openExtensionTabSession(transport, { tabId: 1 }), /not connected/);
});

test("command timeout surfaces as a timeout error (no permanent wait)", async () => {
  const transport = new FakeBridgeTransport();
  transport.setDelay(50);
  const driver = new ExtensionPageDriver(transport, 1, 10);
  await assert.rejects(() => driver.goto("https://example.test/"), /timeout/);
});

test("disconnect mid-run fails the command without hanging", async () => {
  const transport = new FakeBridgeTransport();
  transport.connected = false;
  const driver = new ExtensionPageDriver(transport, 1);
  await assert.rejects(() => driver.snapshot(), /disconnected/);
});

test("VisibilityRunner login + collection works through ExtensionPageDriver", async () => {
  await withDomain(async (domain) => {
    const site = domain.upsertSiteAccount({
      domain: "shop.example.test",
      url: "https://shop.example.test/login",
      displayName: "Shop",
    });
    domain.addCredential({
      siteAccountId: site.id,
      username: "user@example.test",
      password: "fake-pass",
      source: "csv-import",
    });

    const loginSnap = snapshot("https://shop.example.test/login", {
      fields: [
        field("f-user", { type: "email", autocomplete: "username" }),
        field("f-pass", { type: "password", autocomplete: "current-password" }),
      ],
      buttons: [{ selector: "button[type=submit]", text: "ログイン" }],
    });
    const accountSnap = snapshot("https://shop.example.test/account", {
      fields: [field("f-email", { autocomplete: "email", labels: ["メールアドレス"] })],
      links: [{ text: "ログアウト", href: "/logout" }],
    });

    const transport = new FakeBridgeTransport();
    // goto login → wait → snapshot (login) → fill x2 → click → wait → snapshot (account) → collect reads
    transport.enqueue("goto", { url: site.url });
    transport.enqueue("waitForReady", undefined);
    transport.enqueue("snapshot", loginSnap);
    transport.enqueue("fillField", { ok: true });
    transport.enqueue("fillField", { ok: true });
    transport.enqueue("click", { ok: true });
    transport.enqueue("waitForReady", undefined);
    transport.enqueue("snapshot", accountSnap);
    // PageExplorer / collector may snapshot and read values for the landing page.
    transport.enqueue("readValues", { "f-email": "user@example.test" });
    transport.enqueue("readDisplayValues", {});

    const runner = new VisibilityRunner({
      domain,
      openSession: async () => openExtensionTabSession(transport, { tabId: 9 }),
    });
    const result = await runner.runSite(site.id);
    assert.equal(result.status, "collected");
    assert.ok(result.disclosures >= 1);
    assert.ok(transport.calls.some((c) => c.command === "fillField"));
    assert.ok(transport.calls.some((c) => c.command === "click"));
    assert.equal(domain.getCheckpoint("visibility", site.id)?.status, "done");
  });
});

test("VisibilityRunner wall hand-off works through ExtensionPageDriver", async () => {
  await withDomain(async (domain) => {
    const site = domain.upsertSiteAccount({
      domain: "mfa.example.test",
      url: "https://mfa.example.test/login",
      displayName: "MFA",
    });
    domain.addCredential({
      siteAccountId: site.id,
      username: "user@example.test",
      password: "fake-pass",
      source: "csv-import",
    });

    // Match the established FakePageDriver hand-off sequence: login page → OTP wall → account.
    const loginSnap = snapshot("https://mfa.example.test/login", {
      fields: [
        field("f-user", { type: "email", autocomplete: "username", labels: ["ID"] }),
        field("f-pass", { type: "password", autocomplete: "current-password", labels: ["パスワード"] }),
      ],
      buttons: [{ selector: "button[type=submit]", text: "ログイン" }],
    });
    const otpSnap = snapshot("https://mfa.example.test/otp", {
      fields: [field("f-otp", { autocomplete: "one-time-code", labels: ["認証コード"] })],
      visibleText: "認証コードを入力",
    });
    const afterSnap = snapshot("https://mfa.example.test/account", {
      fields: [field("f-email", { autocomplete: "email", labels: ["メール"] })],
      links: [{ text: "ログアウト", href: "/logout" }],
    });

    const transport = new FakeBridgeTransport();
    transport.enqueue("goto", { url: site.url });
    transport.enqueue("waitForReady", undefined);
    transport.enqueue("snapshot", loginSnap);
    transport.enqueue("fillField", { ok: true });
    transport.enqueue("fillField", { ok: true });
    transport.enqueue("click", { ok: true });
    transport.enqueue("waitForReady", undefined);
    transport.enqueue("snapshot", otpSnap);
    // After handoff resume, re-snapshot account page
    transport.enqueue("snapshot", afterSnap);
    transport.enqueue("readValues", { "f-email": "user@example.test" });
    transport.enqueue("readDisplayValues", {});

    let handoffCalls = 0;
    const runner = new VisibilityRunner({
      domain,
      openSession: async () => openExtensionTabSession(transport, { tabId: 3 }),
      handoff: async () => {
        handoffCalls++;
        return "resolved";
      },
    });
    const result = await runner.runSite(site.id);
    assert.equal(handoffCalls, 1);
    assert.equal(result.status, "collected");
    assert.ok(result.disclosures >= 1);
    // Checkpoint is upserted per site; final status is done after resume+collect.
    // Wall path is proven by handoff callback + a wall constraint record.
    assert.ok(
      domain.listConstraints().some((c) => c.siteAccountId === site.id && c.kind === "wall"),
    );
    assert.equal(domain.getCheckpoint("visibility", site.id)?.status, "done");
  });
});

test("VisibilityRunner maps bridge timeout to unreachable (no permanent wait)", async () => {
  await withDomain(async (domain) => {
    const site = domain.upsertSiteAccount({
      domain: "slow.example.test",
      url: "https://slow.example.test/",
      displayName: "Slow",
    });
    const transport = new FakeBridgeTransport();
    transport.enqueueError("goto", new Error("chrome bridge command timeout: goto"));

    const runner = new VisibilityRunner({
      domain,
      openSession: async () => openExtensionTabSession(transport, { tabId: 2 }),
    });
    const result = await runner.runSite(site.id);
    assert.equal(result.status, "unreachable");
    const checkpoints = domain.listCheckpoints().filter((c) => c.siteAccountId === site.id);
    assert.ok(checkpoints.some((c) => c.step === "unreachable"));
    const resume = checkpoints.find((c) => c.step === "unreachable")?.resumeData as
      | { reason?: string }
      | undefined;
    assert.equal(resume?.reason, "timeout");
  });
});

test("VisibilityRunner maps bridge disconnect to failed checkpoint", async () => {
  await withDomain(async (domain) => {
    const site = domain.upsertSiteAccount({
      domain: "gone.example.test",
      url: "https://gone.example.test/",
      displayName: "Gone",
    });
    const transport = new FakeBridgeTransport();
    transport.enqueueError("goto", new Error("chrome bridge disconnected"));

    const runner = new VisibilityRunner({
      domain,
      openSession: async () => openExtensionTabSession(transport, { tabId: 2 }),
    });
    const result = await runner.runSite(site.id);
    assert.equal(result.status, "failed");
    const checkpoints = domain.listCheckpoints().filter((c) => c.siteAccountId === site.id);
    assert.ok(checkpoints.some((c) => c.status === "failed"));
  });
});
