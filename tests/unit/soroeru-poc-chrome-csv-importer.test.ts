// Chrome Password Manager CSV import (Issue #125 / REQ-018).

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importChromeCsv } from "../../src/agent/chrome-csv-importer.js";
import { SoroeruApp } from "../../src/app/app.js";
import { startWebUiServer, type WebUiServerHandle } from "../../src/app/web-ui.js";
import { csrf, getHtml, PASSPHRASE, post, postFormData, unlockThroughUi } from "./helpers/web-ui-client.js";

// ---------------------------------------------------------------------------
// Direct importChromeCsv() tests
// ---------------------------------------------------------------------------

async function withStore(fn: (app: SoroeruApp) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "af-csv-import-"));
  const app = new SoroeruApp({ stateDir: dir, idleLockMs: 0 });
  try {
    await app.unlock(PASSPHRASE);
    await fn(app);
  } finally {
    await app.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
}

const SAMPLE_CSV = [
  "name,url,username,password,note",
  "Example Site,https://example.com,user@example.com,s3cret,",
  "Another Site,https://another.test,alice,hunter2,",
  "Third Site,https://third.example.org,bob,pass123,",
].join("\n");

test("importChromeCsv: 3行CSV → imported: 3, accountState: imported", async () => {
  await withStore(async (app) => {
    const result = importChromeCsv(SAMPLE_CSV, app.store);
    assert.equal(result.imported, 3);
    assert.equal(result.skipped, 0);
    assert.deepEqual(result.siteIds, ["example.com", "another.test", "third.example.org"]);
    const records = [...app.store.siteRecords.values()];
    assert.equal(records.length, 3);
    for (const rec of records) {
      assert.equal(rec.accountState, "imported");
      assert.equal(rec.status, "registered");
      assert.equal(rec.nextAction, "reviewInventory");
    }
  });
});

test("importChromeCsv: 不正URLはスキップされ skipped カウントに加算", async () => {
  await withStore(async (app) => {
    const csv = [
      "name,url,username,password,note",
      "Good,https://good.example,u,p,",
      "Bad,not-a-url,u,p,",
      "Empty URL,,u,p,",
    ].join("\n");
    const result = importChromeCsv(csv, app.store);
    assert.equal(result.imported, 1);
    assert.equal(result.skipped, 2);
  });
});

test("importChromeCsv: 重複 origin は最初の1件のみインポート", async () => {
  await withStore(async (app) => {
    const csv = [
      "name,url,username,password,note",
      "Site A,https://dup.example/page1,u1,p1,",
      "Site A2,https://dup.example/page2,u2,p2,",
    ].join("\n");
    const result = importChromeCsv(csv, app.store);
    assert.equal(result.imported, 1);
    assert.equal(result.skipped, 1);
    assert.equal([...app.store.siteRecords.values()].length, 1);
  });
});

test("importChromeCsv: ヘッダー行のみ → imported: 0, skipped: 0", async () => {
  await withStore(async (app) => {
    const csv = "name,url,username,password,note";
    const result = importChromeCsv(csv, app.store);
    assert.equal(result.imported, 0);
    assert.equal(result.skipped, 0);
  });
});

test("importChromeCsv: 不正ヘッダーは例外をスロー", async () => {
  await withStore(async (app) => {
    const csv = "name,url,username,password\nSite,https://example.com,u,p";
    assert.throws(() => importChromeCsv(csv, app.store), /ヘッダーが不正/);
  });
});

test("importChromeCsv: 認証情報はグローバルプロファイルに保存されない（per-siteストアが未実装のため）", async () => {
  await withStore(async (app) => {
    const csv = [
      "name,url,username,password,note",
      "Example,https://example.com,myuser,mypass,",
    ].join("\n");
    importChromeCsv(csv, app.store);
    // Credentials are intentionally not written to account.id / account.password:
    // Chrome exports per-site credentials; saving multiple rows to a single global
    // key would silently discard all but the last.
    assert.equal(app.store.getValue("account.id"), undefined);
    assert.equal(app.store.getValue("account.password"), undefined);
    // The site record itself is still imported.
    assert.equal(app.store.siteRecords.size, 1);
  });
});

test("importChromeCsv: 既存サイトレコードは上書きされずスキップ", async () => {
  await withStore(async (app) => {
    // Pre-populate a record for example.com
    app.store.upsertSiteRecord({
      origin: "https://example.com",
      siteId: "example.com",
      serviceName: "Existing",
      registeredAt: 1000,
      filledFields: [{ profileKey: "email", filledValueHash: "abc", fieldName: "email", filledAt: 1000 }],
      accountState: "registered",
      status: "registered",
    });
    const csv = [
      "name,url,username,password,note",
      "Example,https://example.com,u,p,",
      "Other,https://other.example,u2,p2,",
    ].join("\n");
    const result = importChromeCsv(csv, app.store);
    assert.equal(result.imported, 1);
    assert.equal(result.skipped, 1);
    // The existing record must not be overwritten
    const rec = app.store.getSiteRecord("example.com")!;
    assert.equal(rec.accountState, "registered");
    assert.equal(rec.filledFields.length, 1);
    assert.equal(rec.serviceName, "Existing");
  });
});

test("importChromeCsv: quoted フィールド（カンマを含む値）を正しく解析", async () => {
  await withStore(async (app) => {
    const csv = [
      "name,url,username,password,note",
      '"My Site, Inc.",https://mysite.example,u,"p,w",note',
    ].join("\n");
    const result = importChromeCsv(csv, app.store);
    assert.equal(result.imported, 1);
    const rec = [...app.store.siteRecords.values()][0]!;
    assert.equal(rec.serviceName, "My Site, Inc.");
  });
});

test("importChromeCsv: quoted note フィールド内の改行を1レコードとして解析", async () => {
  await withStore(async (app) => {
    const csv = [
      "name,url,username,password,note",
      'Multiline Note,https://notes.example,u,p,"line 1',
      'line 2"',
      "Second,https://second.example,u2,p2,",
    ].join("\n");
    const result = importChromeCsv(csv, app.store);
    assert.equal(result.imported, 2);
    assert.equal(result.skipped, 0);
    assert.deepEqual(result.siteIds, ["notes.example", "second.example"]);
  });
});

// ---------------------------------------------------------------------------
// Web UI route tests
// ---------------------------------------------------------------------------

async function withWebUi(fn: (server: WebUiServerHandle) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "af-csv-webui-"));
  const app = new SoroeruApp({ stateDir: dir, idleLockMs: 0 });
  const server = await startWebUiServer({ app, port: 0 });
  try {
    await fn(server);
  } finally {
    await server.close();
    await app.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
}

async function withWebUiApp(fn: (app: SoroeruApp, server: WebUiServerHandle, dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "af-csv-webui-app-"));
  const app = new SoroeruApp({ stateDir: dir, idleLockMs: 0 });
  const server = await startWebUiServer({ app, port: 0 });
  try {
    await fn(app, server, dir);
  } finally {
    await server.close();
    await app.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
}

test("POST /import/chrome-csv: Google Passwords.csv をアップロードすると選択UIにリダイレクト", async () => {
  await withWebUiApp(async (app, server) => {
    const token = await unlockThroughUi(server);
    const form = new FormData();
    form.set("csrf", token);
    form.set("csvFile", new Blob([SAMPLE_CSV], { type: "text/csv" }), "Google Passwords.csv");
    const res = await postFormData(server, "/import/chrome-csv", form);
    assert.equal(res.status, 303);
    const location = decodeURIComponent(res.headers.get("location") ?? "");
    assert.match(location, /tab=settings/);
    assert.match(location, /インポート/);
    assert.equal(app.store.listSiteRecords().length, 3);

    const html = await getHtml(server, "/?tab=settings");
    assert.match(html, /新規取り込みサイト/);
    assert.match(html, /Example Site/);
    assert.match(html, /全てにチェックを入れる/);
  });
});

test("POST /import/chrome-csv: ファイル未選択は warn リダイレクト", async () => {
  await withWebUi(async (server) => {
    const token = await unlockThroughUi(server);
    const form = new FormData();
    form.set("csrf", token);
    form.set("csvFile", new Blob([""], { type: "text/csv" }), "Google Passwords.csv");
    const res = await postFormData(server, "/import/chrome-csv", form);
    assert.equal(res.status, 303);
    assert.match(decodeURIComponent(res.headers.get("location") ?? ""), /warn=/);
  });
});

test("POST /import/chrome-csv: 不正ヘッダーは error リダイレクト", async () => {
  await withWebUi(async (server) => {
    const token = await unlockThroughUi(server);
    const form = new FormData();
    form.set("csrf", token);
    form.set("csvFile", new Blob(["Name,URL,Username,Password\nFoo,https://foo.test,u,p"], { type: "text/csv" }), "Google Passwords.csv");
    const res = await postFormData(server, "/import/chrome-csv", form);
    assert.equal(res.status, 303);
    assert.match(decodeURIComponent(res.headers.get("location") ?? ""), /error=/);
  });
});

test("POST /import/chrome-csv: multipart upload rejects an invalid CSRF token", async () => {
  await withWebUiApp(async (app, server) => {
    await unlockThroughUi(server);
    const form = new FormData();
    form.set("csrf", "bad-token");
    form.set("csvFile", new Blob([SAMPLE_CSV], { type: "text/csv" }), "Google Passwords.csv");

    const res = await postFormData(server, "/import/chrome-csv", form);
    assert.equal(res.status, 403);
    assert.equal(app.store.listSiteRecords().length, 0);
  });
});

test("設定ページに Chrome CSV インポートフォームが表示される", async () => {
  await withWebUi(async (server) => {
    await unlockThroughUi(server);
    const html = await getHtml(server, "/?tab=settings");
    assert.match(html, /Google Passwords.csv/);
    assert.match(html, /action="\/import\/chrome-csv"/);
    assert.match(html, /type="file"/);
    assert.match(html, /Chrome Password Manager のエクスポート画面を開く/);
    assert.doesNotMatch(html, /CSV テキスト/);
    assert.doesNotMatch(html, /保存済みCSVファイルのパス/);
  });
});

test("Chrome Password Manager import selection can request profile retrieval candidates", async () => {
  await withWebUiApp(async (app, server) => {
    const token = await unlockThroughUi(server);
    app.store.setProviderSettings({ provider: "openai", model: "gpt-test", apiKey: "sk-test", mode: "deterministic" });
    const form = new FormData();
    form.set("csrf", token);
    form.set("csvFile", new Blob([SAMPLE_CSV], { type: "text/csv" }), "Google Passwords.csv");
    const res = await postFormData(server, "/import/chrome-csv", form);
    assert.equal(res.status, 303);
    assert.equal(app.store.listSiteRecords().length, 3);

    const html = await getHtml(server, "/?tab=settings");
    assert.match(html, /新規取り込みサイト/);
    assert.match(html, /Example Site/);
    assert.match(html, /全てにチェックを入れる/);

    const bulk = await post(server, "/import/chrome-csv/bulk-start", {
      csrf: token,
      select: "checked",
      siteId: "example.com",
    });
    assert.equal(bulk.status, 303);
    assert.match(decodeURIComponent(bulk.headers.get("location") ?? ""), /1件の個人情報取得/);
  });
});

test("Chrome Password Manager import selection actions reject invalid CSRF tokens", async () => {
  await withWebUiApp(async (app, server) => {
    const token = await unlockThroughUi(server);
    const form = new FormData();
    form.set("csrf", token);
    form.set("csvFile", new Blob([SAMPLE_CSV], { type: "text/csv" }), "Google Passwords.csv");
    const res = await postFormData(server, "/import/chrome-csv", form);
    assert.equal(res.status, 303);
    assert.equal(app.store.listSiteRecords().length, 3);

    const bulk = await post(server, "/import/chrome-csv/bulk-start", {
      csrf: "bad-token",
      select: "checked",
      siteId: "example.com",
    });
    assert.equal(bulk.status, 403);

    const dismiss = await post(server, "/import/chrome-csv/dismiss", {
      csrf: "bad-token",
    });
    assert.equal(dismiss.status, 403);

    const html = await getHtml(server, "/?tab=settings");
    assert.match(html, /新規取り込みサイト/);
  });
});
