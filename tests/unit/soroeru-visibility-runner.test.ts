import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DomainService } from "../../src/domain/domain-service.js";
import type { SiteAccount } from "../../src/domain/entities.js";
import { VaultV2 } from "../../src/store/vault-v2.js";
import type { FormField, PageSnapshot } from "../../src/types.js";
import type { PageDriver, SiteSession } from "../../src/automation/page-driver.js";
import { VisibilityRunner } from "../../src/automation/visibility-runner.js";

const PASSPHRASE = "unit-test-passphrase";

async function openService(): Promise<{ dir: string; service: DomainService }> {
  const dir = await mkdtemp(join(tmpdir(), "soroeru-visibility-"));
  const vault = await VaultV2.open(join(dir, "vault.json"), PASSPHRASE);
  return { dir, service: new DomainService(vault) };
}

test("visibility runner logs in, collects redacted evidence, disclosures, relationships, and checkpoints", async () => {
  const { dir, service } = await openService();
  try {
    const site = service.upsertSiteAccount({
      domain: "example.test",
      url: "https://example.test/login",
      displayName: "Example",
    });
    service.addCredential({ siteAccountId: site.id, username: "user@example.test", password: "fake-pass", source: "csv-import" });
    service.setPersonalAttribute({ attributeKey: "email", label: "メール", value: "new@example.test", valueType: "email" });

    const page = new FakePageDriver([
      snapshot("https://example.test/login", [
        field("login-email", { type: "email", autocomplete: "username", labels: ["メールアドレス"] }),
        field("login-password", { type: "password", autocomplete: "current-password", labels: ["パスワード"] }),
      ]),
      snapshot(
        "https://example.test/account",
        [
          field("profile-email", { type: "email", autocomplete: "email", labels: ["メールアドレス"] }),
          field("profile-phone", { autocomplete: "tel", labels: ["電話番号"] }),
        ],
        "メールマガジンを購読中です。継続課金があります。",
      ),
    ], {
      "profile-email": "old@example.test",
      "profile-phone": "090-1234-5678",
    });

    const runner = new VisibilityRunner({
      domain: service,
      openSession: () => Promise.resolve(new FakeSession(page)),
      now: () => 1_700_000_000_000,
    });

    const result = await runner.runSite(site.id);

    assert.equal(result.status, "collected");
    assert.equal(result.disclosures, 2);
    assert.equal(page.filled["login-email"], "user@example.test");
    assert.equal(page.filled["login-password"], "fake-pass");
    assert.deepEqual(page.clicked, ["button[type=submit]"]);

    const disclosures = service.listDisclosuresForSite(site.id);
    assert.equal(disclosures.length, 2);
    assert.equal(disclosures.find((d) => d.attributeKey === "email")?.staleState, "stale");
    assert.equal(disclosures.find((d) => d.attributeKey === "phone.full")?.staleState, "unknown");
    assert.equal(disclosures.find((d) => d.attributeKey === "email")?.siteHeldValue, "old@example.test");
    assert.equal(disclosures.find((d) => d.attributeKey === "phone.full")?.siteHeldValue, "090-1234-5678");
    assert.ok(disclosures.every((d) => d.normalizedValueHash));

    const evidence = service.listEvidence();
    assert.equal(evidence.length, 2);
    assert.ok(evidence.every((item) => item.maskedSnippet && !item.maskedSnippet.includes("old@example.test")));
    assert.ok(evidence.every((item) => item.normalizedHash));

    assert.equal(service.listAccountRelationshipsForSite(site.id).length, 2);
    assert.equal(service.getCheckpoint("visibility", site.id)?.status, "done");
    assert.equal(page.closed, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("visibility runner records a wall constraint and resumes after human handoff", async () => {
  const { dir, service } = await openService();
  try {
    const site = service.upsertSiteAccount({ domain: "mfa.example.test", url: "https://mfa.example.test/login", displayName: "MFA" });
    service.addCredential({ siteAccountId: site.id, username: "user", password: "fake-pass", source: "csv-import" });

    const page = new FakePageDriver([
      snapshot("https://mfa.example.test/login", [
        field("email", { autocomplete: "username", labels: ["ログインID"] }),
        field("password", { type: "password", autocomplete: "current-password", labels: ["パスワード"] }),
      ]),
      snapshot("https://mfa.example.test/otp", [field("otp", { autocomplete: "one-time-code", labels: ["認証コード"] })]),
      snapshot("https://mfa.example.test/email-check", [], "確認メールを送信しました"),
      snapshot("https://mfa.example.test/account", [field("email-current", { autocomplete: "email", labels: ["メールアドレス"] })]),
    ], {
      "email-current": "user@example.test",
    });
    let handoffs = 0;

    const runner = new VisibilityRunner({
      domain: service,
      openSession: () => Promise.resolve(new FakeSession(page)),
      handoff: async () => {
        handoffs++;
        return "resolved";
      },
    });

    const result = await runner.runSite(site.id);

    assert.equal(result.status, "collected");
    assert.equal(handoffs, 2);
    assert.equal(service.listConstraints().filter((constraint) => constraint.kind === "wall").length, 2);
    assert.equal(service.listDisclosuresForSite(site.id).length, 1);
    assert.equal(service.getCheckpoint("visibility", site.id)?.status, "done");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("visibility runner reports the actual wall constraint count when handoff cannot clear chained walls", async () => {
  const { dir, service } = await openService();
  try {
    const site = service.upsertSiteAccount({
      domain: "blocked.example.test",
      url: "https://blocked.example.test/login",
      displayName: "Blocked",
    });
    const page = new FakePageDriver([
      snapshot("https://blocked.example.test/captcha", [], "私はロボットではありません"),
      snapshot("https://blocked.example.test/otp", [field("otp", { autocomplete: "one-time-code", labels: ["認証コード"] })]),
    ]);
    const runner = new VisibilityRunner({
      domain: service,
      openSession: () => Promise.resolve(new FakeSession(page)),
      handoff: async () => "resolved",
      maxHandoffs: 1,
    });

    const result = await runner.runSite(site.id);

    assert.equal(result.status, "handoff");
    assert.equal(result.constraints, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("visibility runner surfaces automation-prohibiting terms as a constraint", async () => {
  const { dir, service } = await openService();
  try {
    const site = service.upsertSiteAccount({ domain: "tos.example.test", url: "https://tos.example.test/account", displayName: "ToS" });
    const page = new FakePageDriver([
      snapshot(
        "https://tos.example.test/account",
        [field("email", { autocomplete: "email", labels: ["メールアドレス"] })],
        "No automated access is prohibited. newsletter",
      ),
    ], {
      email: "user@example.test",
    });

    const runner = new VisibilityRunner({
      domain: service,
      openSession: () => Promise.resolve(new FakeSession(page)),
    });

    const result = await runner.runSite(site.id);

    assert.equal(result.status, "collected");
    assert.equal(service.listConstraints()[0]?.kind, "tos-automation-prohibition");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("visibility runner records failed checkpoint when opening the browser session fails", async () => {
  const { dir, service } = await openService();
  try {
    const site = service.upsertSiteAccount({
      domain: "launch-fail.example.test",
      url: "https://launch-fail.example.test/login",
      displayName: "Launch Fail",
    });
    const runner = new VisibilityRunner({
      domain: service,
      openSession: async () => {
        throw new Error("browser launch failed");
      },
    });

    const result = await runner.runSite(site.id);

    assert.equal(result.status, "failed");
    assert.equal(service.getCheckpoint("visibility", site.id)?.status, "failed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("visibility runner does not click arbitrary buttons when credentials exist but no login fields are present", async () => {
  const { dir, service } = await openService();
  try {
    const site = service.upsertSiteAccount({
      domain: "already-in.example.test",
      url: "https://already-in.example.test/account",
      displayName: "Already In",
    });
    service.addCredential({ siteAccountId: site.id, username: "user", password: "fake-pass", source: "csv-import" });
    const page = new FakePageDriver([
      {
        ...snapshot("https://already-in.example.test/account", [
          field("email-current", { autocomplete: "email", labels: ["メールアドレス"] }),
        ]),
        buttons: [{ selector: "button.delete", text: "削除" }],
      },
    ], {
      "email-current": "user@example.test",
    });
    const runner = new VisibilityRunner({
      domain: service,
      openSession: () => Promise.resolve(new FakeSession(page)),
    });

    const result = await runner.runSite(site.id);

    assert.equal(result.status, "collected");
    assert.deepEqual(page.clicked, []);
    assert.equal(service.listDisclosuresForSite(site.id).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("visibility runner discovers a same-site login page and stores that URL on the site account", async () => {
  const { dir, service } = await openService();
  try {
    const site = service.upsertSiteAccount({
      domain: "example.test",
      url: "https://example.test/",
      displayName: "Example",
    });
    service.addCredential({ siteAccountId: site.id, username: "user@example.test", password: "fake-pass", source: "csv-import" });

    const page = new FakePageDriver([
      {
        ...snapshot("https://example.test/", [], "トップページ"),
        links: [
          { href: "https://example.test/help", text: "ヘルプ" },
          { href: "https://example.test/login", text: "ログイン" },
        ],
      },
      snapshot("https://example.test/login", [
        field("login-email", { type: "email", autocomplete: "username", labels: ["メールアドレス"] }),
        field("login-password", { type: "password", autocomplete: "current-password", labels: ["パスワード"] }),
      ]),
      snapshot("https://example.test/account", [
        field("profile-email", { type: "email", autocomplete: "email", labels: ["メールアドレス"] }),
      ]),
    ], {
      "profile-email": "user@example.test",
    });

    const runner = new VisibilityRunner({
      domain: service,
      openSession: () => Promise.resolve(new FakeSession(page)),
    });

    const result = await runner.runSite(site.id);

    assert.equal(result.status, "collected");
    assert.deepEqual(page.visited, ["https://example.test/", "https://example.test/login"]);
    assert.equal(service.getSiteAccount(site.id)?.url, "https://example.test/login");
    assert.equal(service.listDisclosuresForSite(site.id).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("visibility runner collects read-only display values (text-rendered account info, not form fields)", async () => {
  const { dir, service } = await openService();
  try {
    const site = service.upsertSiteAccount({
      domain: "profile.example.test",
      url: "https://profile.example.test/account",
      displayName: "Profile",
    });
    service.addCredential({ siteAccountId: site.id, username: "user", password: "fake-pass", source: "csv-import" });
    service.setPersonalAttribute({ attributeKey: "email", label: "メール", value: "current@example.test", valueType: "email" });

    // The account page has NO editable form fields; the registered values are
    // rendered as text (e.g. a <dl>), surfaced as displayValues by the scanner.
    const accountPage = snapshot("https://profile.example.test/account", [], "登録情報", [
      { valueId: "d-1", labelText: "メールアドレス", nearbyText: "" },
      { valueId: "d-2", labelText: "電話番号", nearbyText: "" },
    ]);
    const page = new FakePageDriver([accountPage], {}, {
      "d-1": "old@example.test",
      "d-2": "090-1234-5678",
    });
    const runner = new VisibilityRunner({
      domain: service,
      openSession: () => Promise.resolve(new FakeSession(page)),
      now: () => 1_700_000_000_000,
    });

    const result = await runner.runSite(site.id);

    assert.equal(result.status, "collected");
    assert.equal(result.disclosures, 2);
    const disclosures = service.listDisclosuresForSite(site.id);
    assert.equal(disclosures.find((d) => d.attributeKey === "email")?.staleState, "stale");
    assert.equal(disclosures.find((d) => d.attributeKey === "email")?.siteHeldValue, "old@example.test");
    assert.equal(disclosures.find((d) => d.attributeKey === "phone.full")?.siteHeldValue, "090-1234-5678");
    assert.ok(disclosures.every((d) => d.normalizedValueHash));
    // The redacted evidence must not contain the raw display value.
    const evidenceJson = JSON.stringify(service.listEvidence());
    assert.equal(evidenceJson.includes("old@example.test"), false);
    assert.equal(service.getCheckpoint("visibility", site.id)?.status, "done");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("visibility runner skips a non-web credential (e.g. android://) without marking it unreachable", async () => {
  const { dir, service } = await openService();
  try {
    const site = service.upsertSiteAccount({
      domain: "com.example.app",
      url: "android://hash@com.example.app/",
      displayName: "Example App",
    });
    service.addCredential({ siteAccountId: site.id, username: "user", password: "fake-pass", source: "csv-import" });
    let opened = false;
    const runner = new VisibilityRunner({
      domain: service,
      openSession: () => {
        opened = true;
        return Promise.resolve(new FakeSession(new FakePageDriver([])));
      },
    });

    const result = await runner.runSite(site.id);

    assert.equal(result.status, "skipped");
    assert.equal(opened, false, "a non-web credential must not open a browser session");
    const constraint = service.listConstraints().find((c) => c.kind === "unknown-state");
    assert.ok(constraint?.detail.startsWith("non-web-credential:"));
    assert.notEqual(service.getCheckpoint("visibility", site.id)?.status, "done");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("visibility runner reports login-failed (not collected) when a password field remains and nothing was collected", async () => {
  const { dir, service } = await openService();
  try {
    const site = service.upsertSiteAccount({
      domain: "stuck.example.test",
      url: "https://stuck.example.test/login",
      displayName: "Stuck",
    });
    service.addCredential({ siteAccountId: site.id, username: "user", password: "fake-pass", source: "csv-import" });
    // Both snapshots are the same login page: the login click never advanced past it.
    const loginSnapshot = snapshot("https://stuck.example.test/login", [
      field("email", { type: "email", autocomplete: "username", labels: ["メールアドレス"] }),
      field("password", { type: "password", autocomplete: "current-password", labels: ["パスワード"] }),
    ]);
    const page = new FakePageDriver([loginSnapshot, loginSnapshot], {});
    const runner = new VisibilityRunner({
      domain: service,
      openSession: () => Promise.resolve(new FakeSession(page)),
    });

    const result = await runner.runSite(site.id);

    assert.equal(result.status, "login-failed");
    assert.equal(result.disclosures, 0);
    assert.equal(service.listDisclosuresForSite(site.id).length, 0);
    assert.notEqual(service.getCheckpoint("visibility", site.id)?.status, "done");
    const constraint = service.listConstraints().find((c) => c.kind === "unknown-state");
    assert.ok(constraint?.detail.startsWith("login-incomplete:"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("visibility runner reports no-data (not collected) when the page yields no collectable values", async () => {
  const { dir, service } = await openService();
  try {
    const site = service.upsertSiteAccount({
      domain: "empty.example.test",
      url: "https://empty.example.test/account",
      displayName: "Empty",
    });
    service.addCredential({ siteAccountId: site.id, username: "user", password: "fake-pass", source: "csv-import" });
    // Already past login (no login fields), but readValues returns nothing.
    const page = new FakePageDriver(
      [snapshot("https://empty.example.test/account", [], "ようこそ")],
      {},
    );
    const runner = new VisibilityRunner({
      domain: service,
      openSession: () => Promise.resolve(new FakeSession(page)),
    });

    const result = await runner.runSite(site.id);

    assert.equal(result.status, "no-data");
    assert.equal(result.disclosures, 0);
    assert.notEqual(service.getCheckpoint("visibility", site.id)?.status, "done");
    const constraint = service.listConstraints().find((c) => c.kind === "unknown-state");
    assert.ok(constraint?.detail.startsWith("no-collectable-data:"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("visibility runner records an unreachable URL without leaking credentials", async () => {
  const { dir, service } = await openService();
  try {
    const site = service.upsertSiteAccount({
      domain: "gone.example.test",
      url: "https://gone.example.test/login",
      displayName: "Gone",
    });
    service.addCredential({ siteAccountId: site.id, username: "real-user-canary", password: "real-password-canary", source: "csv-import" });
    const page = new FakePageDriver([]);
    page.gotoError = new Error("page.goto: net::ERR_NAME_NOT_RESOLVED at https://gone.example.test/login");

    const runner = new VisibilityRunner({
      domain: service,
      openSession: () => Promise.resolve(new FakeSession(page)),
    });

    const result = await runner.runSite(site.id);

    assert.equal(result.status, "unreachable");
    const constraint = service.listConstraints().find((item) => item.kind === "unknown-state");
    assert.ok(constraint);
    assert.equal(constraint.detail, "access-unreachable: dns-not-found");
    const serialized = JSON.stringify({ constraints: service.listConstraints(), evidence: service.listEvidence() });
    assert.equal(serialized.includes("real-user-canary"), false);
    assert.equal(serialized.includes("real-password-canary"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

class FakeSession implements SiteSession {
  constructor(readonly page: FakePageDriver) {}

  async close(): Promise<void> {
    this.page.closed = true;
  }
}

class FakePageDriver implements PageDriver {
  filled: Record<string, string> = {};
  clicked: string[] = [];
  visited: string[] = [];
  gotoError: Error | undefined;
  closed = false;
  private index = 0;

  constructor(
    private readonly snapshots: PageSnapshot[],
    private readonly values: Record<string, string> = {},
    private readonly displayValues: Record<string, string> = {},
  ) {}

  async readDisplayValues(): Promise<Record<string, string>> {
    return this.displayValues;
  }

  async goto(url: string): Promise<void> {
    this.visited.push(url);
    if (this.gotoError) throw this.gotoError;
  }

  async waitForReady(): Promise<void> {}

  currentUrl(): string {
    return this.snapshots[Math.min(this.index, this.snapshots.length - 1)]?.url ?? "";
  }

  async snapshot(): Promise<PageSnapshot> {
    const snapshot = this.snapshots[Math.min(this.index, this.snapshots.length - 1)];
    this.index++;
    if (!snapshot) throw new Error("no snapshot");
    return snapshot;
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

function snapshot(
  url: string,
  fields: FormField[],
  visibleText = "",
  displayValues: PageSnapshot["displayValues"] = [],
): PageSnapshot {
  return {
    url,
    title: "Test",
    fields,
    buttons: [{ selector: "button[type=submit]", text: "ログイン" }],
    links: [],
    visibleText,
    iframeSrcs: [],
    wallMarkers: [],
    displayValues,
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
