import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DomainService } from "../../src/domain/domain-service.js";
import { FileVaultPersistence } from "../../src/store/file-vault-persistence.js";
import { VaultV2 } from "../../src/store/vault-v2.js";
import type { FormField, PageSnapshot } from "../../src/types.js";
import type { AiEngine, DecisionKind } from "../../src/automation/decision-engine.js";
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
  const vault = await VaultV2.open(new FileVaultPersistence(join(dir, "vault.json")), PASSPHRASE);
  return { dir, domain: new DomainService(vault) };
}

test("runs to completion and emits started + finished events", async () => {
  const { dir, domain } = await openDomain();
  try {
    const site = domain.upsertSiteAccount({
      domain: "example.test",
      url: "https://example.test/account",
      displayName: "Example",
    });
    const page = new FakePageDriver(
      [
        snapshot(
          "https://example.test/account",
          [field("email", { autocomplete: "email", labels: ["メールアドレス"] })],
          "newsletter",
        ),
      ],
      { email: "user@example.test" },
    );
    const events: VisibilityEvent[] = [];
    const service = new VisibilityService({
      openSession: () => Promise.resolve(new FakeSession(page)),
      emit: (e) => events.push(e),
    });
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

test("replaces an imported domain display name with the observed service name", async () => {
  const { dir, domain } = await openDomain();
  try {
    const site = domain.upsertSiteAccount({
      domain: "account.example.test",
      url: "https://account.example.test/account",
      displayName: "account.example.test",
    });
    const observed = snapshot("https://account.example.test/account", [
      field("email", { autocomplete: "email", labels: ["メールアドレス"] }),
    ]);
    observed.siteName = "Example Service";
    const page = new FakePageDriver([observed], { email: "user@example.test" });
    const service = new VisibilityService({ openSession: () => Promise.resolve(new FakeSession(page)) });
    service.setDomain(domain);

    await service.runSite(site.id);

    assert.equal(domain.getSiteAccount(site.id)?.displayName, "Example Service");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("preserves a manually selected display name during collection", async () => {
  const { dir, domain } = await openDomain();
  try {
    const site = domain.upsertSiteAccount({
      domain: "account.example.test",
      url: "https://account.example.test/account",
      displayName: "My Example Account",
    });
    const observed = snapshot("https://account.example.test/account", [
      field("email", { autocomplete: "email", labels: ["メールアドレス"] }),
    ]);
    observed.siteName = "Example Service";
    const page = new FakePageDriver([observed], { email: "user@example.test" });
    const service = new VisibilityService({ openSession: () => Promise.resolve(new FakeSession(page)) });
    service.setDomain(domain);

    await service.runSite(site.id);

    assert.equal(domain.getSiteAccount(site.id)?.displayName, "My Example Account");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("setAiEngine wires an AI fallback through to a real run (Issue #310)", async () => {
  const { dir, domain } = await openDomain();
  try {
    const site = domain.upsertSiteAccount({
      domain: "ai-wiring.test",
      url: "https://ai-wiring.test/account",
      displayName: "AI Wiring",
    });
    const page = new FakePageDriver(
      [
        snapshot("https://ai-wiring.test/account", [
          field("email", { autocomplete: "email", labels: ["メールアドレス"] }),
        ]),
      ],
      { email: "user@example.test" },
    );
    const consulted: DecisionKind[] = [];
    const fakeAiEngine: AiEngine = {
      consult: (request) => {
        consulted.push(request.kind);
        return Promise.resolve(null);
      },
    };
    const service = new VisibilityService({ openSession: () => Promise.resolve(new FakeSession(page)) });
    service.setDomain(domain);
    service.setAiEngine(fakeAiEngine);

    const result = await service.runSite(site.id);

    assert.equal(result.status, "collected");
    assert.ok(
      consulted.length > 0,
      "the AiEngine set via setAiEngine must actually be consulted during a real run",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pauses at a wall, exposes the hand-off, and resumes on request", async () => {
  const { dir, domain } = await openDomain();
  try {
    const site = domain.upsertSiteAccount({
      domain: "mfa.test",
      url: "https://mfa.test/login",
      displayName: "MFA",
    });
    domain.addCredential({
      siteAccountId: site.id,
      username: "user",
      password: "fake-pass",
      source: "csv-import",
    });
    const page = new FakePageDriver(
      [
        snapshot("https://mfa.test/login", [
          field("email", { autocomplete: "username", labels: ["ID"] }),
          field("password", { type: "password", autocomplete: "current-password", labels: ["パスワード"] }),
        ]),
        snapshot("https://mfa.test/otp", [
          field("otp", { autocomplete: "one-time-code", labels: ["認証コード"] }),
        ]),
        snapshot("https://mfa.test/account", [
          field("email-now", { autocomplete: "email", labels: ["メール"] }),
        ]),
      ],
      { "email-now": "user@example.test" },
    );
    const events: VisibilityEvent[] = [];
    const service = new VisibilityService({
      openSession: () => Promise.resolve(new FakeSession(page)),
      emit: (e) => events.push(e),
    });
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

test("handoff event includes the site's login credential for local copy assistance", async () => {
  const { dir, domain } = await openDomain();
  try {
    const site = domain.upsertSiteAccount({
      domain: "mfa.test",
      url: "https://mfa.test/login",
      displayName: "MFA",
    });
    domain.addCredential({
      siteAccountId: site.id,
      username: "acceptance-user@example.test",
      password: "AcceptancePassw0rd!",
      source: "csv-import",
    });
    const page = new FakePageDriver([
      snapshot("https://mfa.test/otp", [
        field("otp", { autocomplete: "one-time-code", labels: ["認証コード"] }),
      ]),
    ]);
    const events: VisibilityEvent[] = [];
    const service = new VisibilityService({
      openSession: () => Promise.resolve(new FakeSession(page)),
      emit: (e) => events.push(e),
    });
    service.setDomain(domain);

    const runPromise = service.runSite(site.id);
    await waitFor(() => service.status().awaitingHandoff);

    const handoff = events.find((event) => event.type === "handoff");
    assert.equal(handoff?.credential?.username, "acceptance-user@example.test");
    assert.equal(handoff?.credential?.password, "AcceptancePassw0rd!");

    service.abortHandoff();
    await runPromise;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("handoff event omits credentials for a post-login non-MFA wall", async () => {
  const { dir, domain } = await openDomain();
  try {
    const site = domain.upsertSiteAccount({
      domain: "captcha.test",
      url: "https://captcha.test/login",
      displayName: "Captcha",
    });
    domain.addCredential({
      siteAccountId: site.id,
      username: "acceptance-user@example.test",
      password: "AcceptancePassw0rd!",
      source: "csv-import",
    });
    const afterLoginCaptcha = snapshot("https://captcha.test/account", [], "captcha required");
    afterLoginCaptcha.wallMarkers = ["recaptcha"];
    const page = new FakePageDriver([
      snapshot("https://captcha.test/login", [
        field("email", { autocomplete: "username", labels: ["ID"] }),
        field("password", { type: "password", autocomplete: "current-password", labels: ["パスワード"] }),
      ]),
      afterLoginCaptcha,
    ]);
    const events: VisibilityEvent[] = [];
    const service = new VisibilityService({
      openSession: () => Promise.resolve(new FakeSession(page)),
      emit: (e) => events.push(e),
    });
    service.setDomain(domain);

    const runPromise = service.runSite(site.id);
    await waitFor(() => service.status().awaitingHandoff);

    const handoff = events.find((event) => event.type === "handoff");
    assert.equal(handoff?.type, "handoff");
    assert.equal(handoff?.credential, undefined);

    service.abortHandoff();
    await runPromise;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("refuses a concurrent run while one is paused at a hand-off", async () => {
  const { dir, domain } = await openDomain();
  try {
    const site = domain.upsertSiteAccount({
      domain: "mfa.test",
      url: "https://mfa.test/login",
      displayName: "MFA",
    });
    const page = new FakePageDriver([
      snapshot("https://mfa.test/otp", [
        field("otp", { autocomplete: "one-time-code", labels: ["認証コード"] }),
      ]),
    ]);
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

test("abort stops an in-flight run even before a wall hand-off", async () => {
  const { dir, domain } = await openDomain();
  try {
    const site = domain.upsertSiteAccount({
      domain: "slow.test",
      url: "https://slow.test/account",
      displayName: "Slow",
    });
    const page = new BlockingPageDriver();
    const service = new VisibilityService({ openSession: () => Promise.resolve(new FakeSession(page)) });
    service.setDomain(domain);

    const runPromise = service.runSite(site.id);
    await waitFor(() => service.isRunning);

    assert.equal(service.abortRun(), true);
    const result = await runPromise;

    assert.equal(result.status, "canceled");
    assert.equal(page.closed, true);
    assert.equal(service.isRunning, false);
    assert.equal(service.status().awaitingHandoff, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("abort before display-value collection prevents persisted disclosures and records canceled checkpoint", async () => {
  const { dir, domain } = await openDomain();
  try {
    const site = domain.upsertSiteAccount({
      domain: "slow.test",
      url: "https://slow.test/account",
      displayName: "Slow",
    });
    const page = new BlockingDisplayPageDriver(
      [
        snapshot("https://slow.test/account", [
          field("email", { autocomplete: "email", labels: ["メールアドレス"] }),
        ]),
      ],
      { email: "user@example.test" },
    );
    const service = new VisibilityService({ openSession: () => Promise.resolve(new FakeSession(page)) });
    service.setDomain(domain);

    const runPromise = service.runSite(site.id);
    await waitFor(() => page.readDisplayStarted);

    assert.equal(service.abortRun(), true);
    const result = await runPromise;

    assert.equal(result.status, "canceled");
    assert.equal(domain.listDisclosuresForSite(site.id).length, 0);
    const checkpoint = domain.getCheckpoint("visibility", site.id);
    assert.equal(checkpoint?.step, "canceled");
    assert.equal(checkpoint?.status, "failed");
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
  constructor(readonly page: FakePageDriver | BlockingPageDriver | BlockingDisplayPageDriver) {}
  async close(): Promise<void> {
    this.page.closed = true;
    if ("close" in this.page) this.page.close();
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
  async waitForReady(): Promise<void> {}
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

class BlockingPageDriver implements PageDriver {
  closed = false;
  private unblock: (() => void) | undefined;
  async goto(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.unblock = resolve;
      if (this.closed) resolve();
    });
  }
  async waitForReady(): Promise<void> {}
  currentUrl(): string {
    return "https://slow.test/account";
  }
  async snapshot(): Promise<PageSnapshot> {
    return snapshot("https://slow.test/account", []);
  }
  async readValues(): Promise<Record<string, string>> {
    return {};
  }
  async fillField(): Promise<void> {}
  async click(): Promise<void> {}
  close(): void {
    this.closed = true;
    this.unblock?.();
  }
}

class BlockingDisplayPageDriver extends FakePageDriver {
  readDisplayStarted = false;
  private unblock: (() => void) | undefined;
  async readDisplayValues(): Promise<Record<string, string>> {
    this.readDisplayStarted = true;
    await new Promise<void>((resolve) => {
      this.unblock = resolve;
      if (this.closed) resolve();
    });
    return {};
  }
  close(): void {
    this.closed = true;
    this.unblock?.();
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

test("abort during checkpoint persistence does not install a later handoff", async () => {
  const { dir, domain } = await openDomain();
  let releaseSave!: () => void;
  let enteredSave!: () => void;
  const entered = new Promise<void>((resolve) => { enteredSave = resolve; });
  const blocked = new Promise<void>((resolve) => { releaseSave = resolve; });
  try {
    const site = domain.upsertSiteAccount({ domain: "captcha.test", url: "https://captcha.test/account", displayName: "Fake" });
    const wall = snapshot("https://captcha.test/account", [], "captcha required");
    wall.wallMarkers = ["recaptcha"];
    const events: VisibilityEvent[] = [];
    let saves = 0;
    const service = new VisibilityService({
      openSession: () => Promise.resolve(new FakeSession(new FakePageDriver([wall], {}))),
      emit: (event) => events.push(event),
      persist: async () => { if (saves++ === 0) { enteredSave(); await blocked; } },
    });
    service.setDomain(domain);
    const running = service.runSite(site.id);
    await entered;
    service.abortRun();
    let completed = false;
    const completion = service.waitForActiveRunCompletion().then(() => { completed = true; });
    await Promise.resolve();
    assert.equal(completed, false);
    releaseSave();
    await running;
    await completion;
    assert.equal(completed, true);
    assert.equal(service.isRunning, false);
    assert.equal(service.status().awaitingHandoff, false);
    assert.equal(events.some((event) => event.type === "handoff"), false);
  } finally {
    releaseSave();
    await rm(dir, { recursive: true, force: true });
  }
});
