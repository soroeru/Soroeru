import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DomainService } from "../../src/domain/domain-service.js";
import { VaultV2 } from "../../src/store/vault-v2.js";
import type { FormField, PageSnapshot } from "../../src/types.js";
import type { PageDriver, SiteSession } from "../../src/automation/page-driver.js";
import { VisibilityService } from "../../electron/visibility-service.js";
import type { VisibilityEvent } from "../../electron/ipc/contract.js";

// Fake data only (docs/testing.md). Verifies the main-side VisibilityService
// brokers the wall hand-off between the headed browser and the renderer
// (RFC-002 §5.2): it emits run/hand-off/resume/finish events, pauses at a wall,
// resumes on request, and refuses a concurrent run / a locked vault.
const PASSPHRASE = "visibility-service-passphrase";

async function openDomain(): Promise<{ dir: string; domain: DomainService }> {
  const dir = await mkdtemp(join(tmpdir(), "soroeru-vis-svc-"));
  const vault = await VaultV2.open(join(dir, "vault.json"), PASSPHRASE);
  return { dir, domain: new DomainService(vault) };
}

test("runs to completion and emits started + finished events", async () => {
  const { dir, domain } = await openDomain();
  try {
    const site = domain.upsertSiteAccount({ domain: "example.test", url: "https://example.test/account", displayName: "Example" });
    const page = new FakePageDriver(
      [snapshot("https://example.test/account", [field("email", { autocomplete: "email", labels: ["メールアドレス"] })], "newsletter")],
      { email: "user@example.test" },
    );
    const events: VisibilityEvent[] = [];
    const service = new VisibilityService({ openSession: () => Promise.resolve(new FakeSession(page)), emit: (e) => events.push(e) });
    service.setDomain(domain);

    const result = await service.runSite(site.id);

    assert.equal(result.status, "collected");
    assert.equal(events[0]?.type, "run-started");
    assert.equal(events.at(-1)?.type, "run-finished");
    assert.equal(service.isRunning, false);
    assert.equal(service.status().awaitingHandoff, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pauses at a wall, exposes the hand-off, and resumes on request", async () => {
  const { dir, domain } = await openDomain();
  try {
    const site = domain.upsertSiteAccount({ domain: "mfa.test", url: "https://mfa.test/login", displayName: "MFA" });
    domain.addCredential({ siteAccountId: site.id, username: "user", password: "fake-pass", source: "csv-import" });
    const page = new FakePageDriver(
      [
        snapshot("https://mfa.test/login", [
          field("email", { autocomplete: "username", labels: ["ID"] }),
          field("password", { type: "password", autocomplete: "current-password", labels: ["パスワード"] }),
        ]),
        snapshot("https://mfa.test/otp", [field("otp", { autocomplete: "one-time-code", labels: ["認証コード"] })]),
        snapshot("https://mfa.test/account", [field("email-now", { autocomplete: "email", labels: ["メール"] })]),
      ],
      { "email-now": "user@example.test" },
    );
    const events: VisibilityEvent[] = [];
    const service = new VisibilityService({ openSession: () => Promise.resolve(new FakeSession(page)), emit: (e) => events.push(e) });
    service.setDomain(domain);

    const runPromise = service.runSite(site.id);
    await waitFor(() => service.status().awaitingHandoff);

    const status = service.status();
    assert.equal(status.running, true);
    assert.equal(status.awaitingHandoff, true);
    assert.equal(status.siteAccountId, site.id);
    assert.ok(status.instruction && status.instruction.length > 0);
    assert.ok(events.some((e) => e.type === "handoff"));

    assert.equal(service.resumeHandoff(), true);
    const result = await runPromise;

    assert.equal(result.status, "collected");
    assert.ok(events.some((e) => e.type === "resumed"));
    assert.equal(domain.getCheckpoint("visibility", site.id)?.status, "done");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("refuses a concurrent run while one is paused at a hand-off", async () => {
  const { dir, domain } = await openDomain();
  try {
    const site = domain.upsertSiteAccount({ domain: "mfa.test", url: "https://mfa.test/login", displayName: "MFA" });
    const page = new FakePageDriver([snapshot("https://mfa.test/otp", [field("otp", { autocomplete: "one-time-code", labels: ["認証コード"] })])]);
    const service = new VisibilityService({ openSession: () => Promise.resolve(new FakeSession(page)) });
    service.setDomain(domain);

    const runPromise = service.runSite(site.id);
    await waitFor(() => service.status().awaitingHandoff);

    const busy = await service.runSite(site.id);
    assert.equal(busy.status, "busy");

    service.abortHandoff();
    await runPromise;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reports locked when no vault is bound", async () => {
  const service = new VisibilityService({ openSession: () => Promise.reject(new Error("should not open")) });
  const result = await service.runSite("any");
  assert.equal(result.status, "locked");
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 1000 && !predicate(); i++) await new Promise((r) => setImmediate(r));
  if (!predicate()) throw new Error("condition not met");
}

class FakeSession implements SiteSession {
  constructor(readonly page: FakePageDriver) {}
  async close(): Promise<void> {
    this.page.closed = true;
  }
}

class FakePageDriver implements PageDriver {
  filled: Record<string, string> = {};
  clicked: string[] = [];
  closed = false;
  private index = 0;
  constructor(
    private readonly snapshots: PageSnapshot[],
    private readonly values: Record<string, string> = {},
  ) {}
  async goto(): Promise<void> {}
  currentUrl(): string {
    return this.snapshots[Math.min(this.index, this.snapshots.length - 1)]?.url ?? "";
  }
  async snapshot(): Promise<PageSnapshot> {
    const snap = this.snapshots[Math.min(this.index, this.snapshots.length - 1)];
    this.index++;
    if (!snap) throw new Error("no snapshot");
    return snap;
  }
  async readValues(): Promise<Record<string, string>> {
    return this.values;
  }
  async fillField(fieldId: string, value: string): Promise<void> {
    this.filled[fieldId] = value;
  }
  async click(selector: string): Promise<void> {
    this.clicked.push(selector);
  }
}

function snapshot(url: string, fields: FormField[], visibleText = ""): PageSnapshot {
  return {
    url,
    title: "Test",
    fields,
    buttons: [{ selector: "button[type=submit]", text: "ログイン" }],
    links: [],
    visibleText,
    iframeSrcs: [],
    wallMarkers: [],
  };
}

function field(fieldId: string, overrides: Partial<FormField>): FormField {
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
    ...overrides,
  };
}
