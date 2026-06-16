// Add Site branch-selection E2E tests (Issue #93).
// Covers: notRegistered → starts registration, registered → quick import,
// uncertain → warns, and the login/account fixtures added for import flows.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { CatashiroApp } from "../../src/app/app.js";
import { startWebUiServer, type WebUiServerHandle } from "../../src/app/web-ui.js";
import { startPocServer } from "../../sites/server.js";

const PASSPHRASE = "unit-test-passphrase";

async function getHtml(server: WebUiServerHandle, path = "/"): Promise<string> {
  const res = await fetch(new URL(path, server.url));
  assert.equal(res.status, 200);
  return await res.text();
}

function csrf(html: string): string {
  const match = /name="csrf" value="([^"]+)"/.exec(html);
  assert.ok(match, "expected csrf token");
  return match[1]!;
}

async function post(server: WebUiServerHandle, path: string, body: Record<string, string>): Promise<Response> {
  return fetch(new URL(path, server.url), {
    method: "POST",
    body: new URLSearchParams(body),
    redirect: "manual",
  });
}

async function unlockThroughUi(server: WebUiServerHandle): Promise<string> {
  const token = csrf(await getHtml(server));
  const res = await post(server, "/unlock", { csrf: token, passphrase: PASSPHRASE });
  assert.equal(res.status, 303);
  return token;
}

// ---------------------------------------------------------------------------
// Add Site branch-selection tests
// ---------------------------------------------------------------------------

test("Add Site notRegistered status launches a registration session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "af-add-site-"));
  const site = await startPocServer();
  const app = new CatashiroApp({
    stateDir: dir,
    idleLockMs: 0,
    launchBrowserFn: async () => chromium.launch({ headless: true }),
  });
  const server = await startWebUiServer({ app, port: 0 });
  try {
    const token = await unlockThroughUi(server);
    const res = await post(server, "/site/add", {
      csrf: token,
      url: site.siteUrl("01-basic"),
      accountStatus: "notRegistered",
    });
    assert.equal(res.status, 303);
    assert.match(decodeURIComponent(res.headers.get("location") ?? ""), /新規登録を開始しました/);
  } finally {
    await server.close();
    await app.shutdown();
    await site.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Add Site registered status performs a quick import without launching a browser", async () => {
  const dir = await mkdtemp(join(tmpdir(), "af-add-site-"));
  let browserLaunched = false;
  const app = new CatashiroApp({
    stateDir: dir,
    idleLockMs: 0,
    launchBrowserFn: async () => {
      browserLaunched = true;
      return chromium.launch({ headless: true });
    },
  });
  const server = await startWebUiServer({ app, port: 0 });
  try {
    const token = await unlockThroughUi(server);
    const res = await post(server, "/site/add", {
      csrf: token,
      url: "https://members.example.test/account",
      accountStatus: "registered",
    });
    assert.equal(res.status, 303);
    assert.match(decodeURIComponent(res.headers.get("location") ?? ""), /既存アカウントとしてサイト一覧に取り込みました/);

    assert.equal(browserLaunched, false, "quick import must not launch a browser");

    const record = app.store.listSiteRecords().find((r) => r.siteId === "members.example.test");
    assert.ok(record, "site record must exist after quick import");
    assert.equal(record.accountState, "imported");
    assert.equal(record.nextAction, "reviewInventory");
  } finally {
    await server.close();
    await app.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Add Site uncertain status warns without saving a record or launching a browser", async () => {
  const dir = await mkdtemp(join(tmpdir(), "af-add-site-"));
  let browserLaunched = false;
  const app = new CatashiroApp({
    stateDir: dir,
    idleLockMs: 0,
    launchBrowserFn: async () => {
      browserLaunched = true;
      return chromium.launch({ headless: true });
    },
  });
  const server = await startWebUiServer({ app, port: 0 });
  try {
    const token = await unlockThroughUi(server);
    const res = await post(server, "/site/add", {
      csrf: token,
      url: "https://shop.example.test/",
      accountStatus: "uncertain",
    });
    assert.equal(res.status, 303);
    assert.match(decodeURIComponent(res.headers.get("location") ?? ""), /既存アカウントの有無を選んでから続行してください/);

    assert.equal(browserLaunched, false);
    assert.equal(app.store.listSiteRecords().length, 0);
  } finally {
    await server.close();
    await app.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Add Site with a missing URL warns and does not save a record", async () => {
  const dir = await mkdtemp(join(tmpdir(), "af-add-site-"));
  const app = new CatashiroApp({ stateDir: dir, idleLockMs: 0 });
  const server = await startWebUiServer({ app, port: 0 });
  try {
    const token = await unlockThroughUi(server);
    const res = await post(server, "/site/add", {
      csrf: token,
      url: "",
      accountStatus: "notRegistered",
    });
    assert.equal(res.status, 303);
    assert.match(decodeURIComponent(res.headers.get("location") ?? ""), /URLを入力してください/);
    assert.equal(app.store.listSiteRecords().length, 0);
  } finally {
    await server.close();
    await app.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Login page and account settings fixture tests
// ---------------------------------------------------------------------------

test("login page fixture returns 200 with a login form when no account is registered", async () => {
  const site = await startPocServer();
  try {
    const res = await fetch(`${site.siteUrl("01-basic")}login`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /ログイン/);
    assert.match(html, /type="email"/);
    assert.match(html, /type="password"/);
  } finally {
    await site.close();
  }
});

test("login page fixture redirects to account page after successful login", async () => {
  const site = await startPocServer();
  try {
    // Seed a registration so login can match
    await fetch(`${site.siteUrl("01-basic")}register`, {
      method: "POST",
      body: new URLSearchParams({
        fullname: "テスト 太郎",
        kana: "テスト タロウ",
        email: "taro@example.test",
        tel: "090-1234-5678",
        zip: "100-0001",
        address: "東京都千代田区1-1",
        login_id: "test-taro",
        password: "TestPassw0rd!",
      }),
    });

    const res = await fetch(`${site.siteUrl("01-basic")}login`, {
      method: "POST",
      body: new URLSearchParams({ email: "taro@example.test", password: "TestPassw0rd!" }),
      redirect: "manual",
    });
    assert.equal(res.status, 200);
    const html = await res.text();
    // Success path shows a redirect / account link
    assert.match(html, /ログインしました|\/account/);
  } finally {
    await site.close();
  }
});

test("account settings page shows registered values as read-only text", async () => {
  const site = await startPocServer();
  try {
    await fetch(`${site.siteUrl("01-basic")}register`, {
      method: "POST",
      body: new URLSearchParams({
        fullname: "設定 花子",
        kana: "セッテイ ハナコ",
        email: "hanako@example.test",
        tel: "080-9876-5432",
        zip: "100-0002",
        address: "東京都千代田区2-2",
        login_id: "hanako",
        password: "HanakoP@ss1",
      }),
    });

    const res = await fetch(`${site.siteUrl("01-basic")}account`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /アカウント情報/);
    assert.match(html, /設定 花子/);
    assert.match(html, /hanako@example\.test/);
    // Password must NOT appear on the account settings page
    assert.ok(!html.includes("HanakoP@ss1"), "password must not appear on account page");
  } finally {
    await site.close();
  }
});

test("account settings page prompts login when no account is registered", async () => {
  const site = await startPocServer();
  try {
    const res = await fetch(`${site.siteUrl("01-basic")}account`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /ログインが必要です|login/);
  } finally {
    await site.close();
  }
});

test("login-wall fixture shows MFA form after login POST", async () => {
  const site = await startPocServer();
  try {
    const res = await fetch(`${site.url}/login-wall/login`, {
      method: "POST",
      body: new URLSearchParams({ email: "user@example.test", password: "pw" }),
    });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /2段階認証|認証コード|one-time-code/);
  } finally {
    await site.close();
  }
});
