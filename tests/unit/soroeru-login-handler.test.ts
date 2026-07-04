import assert from "node:assert/strict";
import { test } from "node:test";
import { DecisionEngine } from "../../src/automation/decision-engine.js";
import { LoginHandler } from "../../src/automation/login-handler.js";
import type { PageDriver } from "../../src/automation/page-driver.js";
import { RuleEngine } from "../../src/automation/rule-engine.js";
import { WallDetectionService } from "../../src/automation/wall-detection.js";
import type { Credential, SiteAccount } from "../../src/domain/entities.js";
import type { FormField, PageSnapshot } from "../../src/types.js";

function handler(): LoginHandler {
  return new LoginHandler(new DecisionEngine(new RuleEngine()), new WallDetectionService());
}

function siteAccount(partial: Partial<SiteAccount> = {}): SiteAccount {
  return {
    id: "site-1",
    domain: "example.test",
    url: "https://example.test/login",
    displayName: "Example",
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  };
}

function credential(): Credential {
  return {
    id: "cred-1",
    siteAccountId: "site-1",
    username: "user@example.test",
    password: "fake-pass",
    source: "csv-import",
    updatedAt: 0,
  };
}

function field(fieldId: string, partial: Partial<FormField>): FormField {
  return {
    fieldId,
    tag: "input",
    type: "text",
    name: "",
    id: "",
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

function loginPage(url = "https://example.test/login"): PageSnapshot {
  return snapshot(url, {
    fields: [
      field("f-user", { type: "email", autocomplete: "username" }),
      field("f-pass", { type: "password", autocomplete: "current-password" }),
    ],
    buttons: [{ selector: "button[type=submit]", text: "ログイン" }],
  });
}

function loggedInPage(): PageSnapshot {
  return snapshot("https://example.test/account", {
    links: [
      { text: "ログアウト", href: "/logout" },
      { text: "マイページ", href: "/mypage" },
    ],
  });
}

class FakePageDriver implements PageDriver {
  filled: Record<string, string> = {};
  clicked: string[] = [];
  visited: string[] = [];
  private index = 0;

  constructor(private readonly snapshots: PageSnapshot[]) {}

  async goto(url: string): Promise<void> {
    this.visited.push(url);
  }

  async waitForReady(): Promise<void> {}

  currentUrl(): string {
    return this.snapshots[Math.min(this.index, this.snapshots.length - 1)]?.url ?? "";
  }

  async snapshot(): Promise<PageSnapshot> {
    const current = this.snapshots[Math.min(this.index, this.snapshots.length - 1)];
    this.index++;
    if (!current) throw new Error("no snapshot");
    return current;
  }

  async readValues(): Promise<Record<string, string>> {
    return {};
  }

  async fillField(fieldId: string, value: string): Promise<void> {
    this.filled[fieldId] = value;
  }

  async click(selector: string): Promise<void> {
    this.clicked.push(selector);
  }
}

test("login fills the detected form, submits, and judges success", async () => {
  const page = new FakePageDriver([loginPage(), loggedInPage()]);

  const result = await handler().login(page, credential(), siteAccount());

  assert.deepEqual(result, { success: true });
  assert.deepEqual(page.visited, ["https://example.test/login"]);
  assert.equal(page.filled["f-user"], "user@example.test");
  assert.equal(page.filled["f-pass"], "fake-pass");
  assert.deepEqual(page.clicked, ["button[type=submit]"]);
});

test("login discovers the login page from the domain top page when the entry URL has no form", async () => {
  const topPage = snapshot("https://example.test/", {
    links: [{ text: "ログイン", href: "/login" }],
  });
  const page = new FakePageDriver([topPage, topPage, loginPage(), loggedInPage()]);

  const result = await handler().login(page, credential(), siteAccount({ url: "https://example.test/welcome" }));

  assert.deepEqual(result, { success: true });
  assert.deepEqual(page.visited, [
    "https://example.test/welcome",
    "https://example.test/",
    "https://example.test/login",
  ]);
});

test("login reports login-page-not-found when no login link exists", async () => {
  const topPage = snapshot("https://example.test/", {
    links: [{ text: "ヘルプ", href: "/help" }],
  });
  const page = new FakePageDriver([topPage, topPage]);

  const result = await handler().login(page, credential(), siteAccount({ url: "https://example.test/welcome" }));

  assert.deepEqual(result, { success: false, error: "login-page-not-found" });
  assert.deepEqual(page.filled, {});
});

test("login reports login-form-not-found when the discovered page still has no form", async () => {
  const topPage = snapshot("https://example.test/", {
    links: [{ text: "ログイン", href: "/login" }],
  });
  const formlessLoginPage = snapshot("https://example.test/login", {
    visibleText: "メンテナンス中です",
  });
  const page = new FakePageDriver([topPage, topPage, formlessLoginPage]);

  const result = await handler().login(page, credential(), siteAccount({ url: "https://example.test/welcome" }));

  assert.deepEqual(result, { success: false, error: "login-form-not-found" });
  assert.deepEqual(page.filled, {});
});

test("login hands off on a wall at the entry page without filling anything", async () => {
  const walledPage = snapshot("https://example.test/login", { wallMarkers: ["g-recaptcha"] });
  const page = new FakePageDriver([walledPage]);

  const result = await handler().login(page, credential(), siteAccount());

  assert.equal(result.success, false);
  assert.equal(result.wall?.kind, "captcha");
  assert.deepEqual(page.filled, {});
  assert.deepEqual(page.clicked, []);
  // The wall page is never navigated away from — the human resolves it here.
  assert.deepEqual(page.visited, ["https://example.test/login"]);
});

test("login hands off on a post-login MFA wall", async () => {
  const otpPage = snapshot("https://example.test/otp", {
    fields: [field("f-otp", { autocomplete: "one-time-code" })],
  });
  const page = new FakePageDriver([loginPage(), otpPage]);

  const result = await handler().login(page, credential(), siteAccount());

  assert.equal(result.success, false);
  assert.equal(result.wall?.kind, "mfa");
  assert.equal(page.filled["f-pass"], "fake-pass");
});

test("login reports login-failed when the password field is still present after submit", async () => {
  const page = new FakePageDriver([loginPage(), loginPage()]);

  const result = await handler().login(page, credential(), siteAccount());

  assert.deepEqual(result, { success: false, error: "login-failed" });
});

test("login treats an ambiguous post-login page as failed (safe default)", async () => {
  // A logout link (success signal) alongside error wording (failure signal):
  // the rule returns no result and the safe default treats login as failed.
  const ambiguous = snapshot("https://example.test/account", {
    links: [
      { text: "ログアウト", href: "/logout" },
      { text: "マイページ", href: "/mypage" },
    ],
    visibleText: "ログインエラーが発生しました",
  });
  const page = new FakePageDriver([loginPage(), ambiguous]);

  const result = await handler().login(page, credential(), siteAccount());

  assert.deepEqual(result, { success: false, error: "login-failed" });
});
