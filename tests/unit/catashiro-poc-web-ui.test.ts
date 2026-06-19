// Issue #66 local browser UI foundation: local-only server routes, CSRF,
// masked profile display, settings, recovery keys, and stale-site dashboard.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CatashiroApp } from "../../src/app/app.js";
import { startWebUiServer, type WebUiServerHandle } from "../../src/app/web-ui.js";
import { sha256Hex } from "../../src/store/store.js";
import type { LocalCandidateDefinition } from "../../src/types.js";

const PASSPHRASE = "unit-test-passphrase";

async function withWebUi(fn: (app: CatashiroApp, server: WebUiServerHandle) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "af-poc-web-ui-"));
  const app = new CatashiroApp({ stateDir: dir, idleLockMs: 0 });
  const server = await startWebUiServer({ app, port: 0 });
  try {
    await fn(app, server);
  } finally {
    await server.close();
    await app.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
}

async function getHtml(server: WebUiServerHandle, path = "/"): Promise<string> {
  const res = await fetch(new URL(path, server.url));
  assert.equal(res.status, 200);
  return await res.text();
}

function csrf(html: string): string {
  const match = /name="csrf" value="([^"]+)"/.exec(html);
  assert.ok(match, "expected csrf token in rendered form");
  return match[1]!;
}

async function post(server: WebUiServerHandle, path: string, body: Record<string, string>): Promise<Response> {
  return await fetch(new URL(path, server.url), {
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

function localCandidate(id: string): LocalCandidateDefinition {
  return {
    id,
    serviceName: "候補サイト",
    match: { urlPatterns: ["/site/candidate/"] },
    fieldRules: [{ id: "email", profileKey: "email", labelPattern: "メール" }],
    source: "ai",
    status: "candidate",
    createdAt: 1000,
    updatedAt: 1000,
  };
}

test("locked screen renders onboarding and rejects POSTs without the CSRF token", async () => {
  await withWebUi(async (_app, server) => {
    const html = await getHtml(server);
    assert.match(html, /Catashiro を開く/);
    assert.match(html, /クラウド同期やテレメトリは使いません/);

    const res = await post(server, "/unlock", { passphrase: PASSPHRASE });
    assert.equal(res.status, 403);
    assert.match(await res.text(), /画面を再読み込み/);
  });
});

test("first run shows a vault setup form with passphrase confirmation and the vault location", async () => {
  await withWebUi(async (app, server) => {
    const html = await getHtml(server);
    assert.match(html, /action="\/setup"/);
    assert.match(html, /name="passphrase"/);
    assert.match(html, /name="confirmPassphrase"/);
    assert.ok(html.includes(app.storeFilePath));
    assert.ok(!html.includes('action="/unlock"'));
  });
});

test("vault setup creates the encrypted store with a confirmed passphrase and points to recovery-key setup", async () => {
  await withWebUi(async (app, server) => {
    assert.equal(await app.hasVault(), false);
    const token = csrf(await getHtml(server));
    const newPassphrase = "correct horse battery staple";

    const res = await post(server, "/setup", { csrf: token, passphrase: newPassphrase, confirmPassphrase: newPassphrase });
    assert.equal(res.status, 303);
    const location = decodeURIComponent(res.headers.get("location") ?? "");
    assert.match(location, /tab=settings/);
    assert.match(location, /リカバリーキー/);

    assert.equal(app.isUnlocked, true);
    assert.equal(await app.hasVault(), true);
    assert.equal(await app.store.verifyPassphrase(newPassphrase), true);
  });
});

test("vault setup rejects mismatched or too-short passphrases without creating a vault", async () => {
  await withWebUi(async (app, server) => {
    const token = csrf(await getHtml(server));

    const tooShort = await post(server, "/setup", { csrf: token, passphrase: "short1", confirmPassphrase: "short1" });
    assert.match(decodeURIComponent(tooShort.headers.get("location") ?? ""), /8文字以上/);
    assert.equal(await app.hasVault(), false);

    const mismatched = await post(server, "/setup", {
      csrf: token,
      passphrase: "long-enough-pass",
      confirmPassphrase: "long-enough-pass2",
    });
    assert.match(decodeURIComponent(mismatched.headers.get("location") ?? ""), /一致しません/);
    assert.equal(await app.hasVault(), false);
  });
});

test("vault setup is rejected once a vault already exists", async () => {
  await withWebUi(async (app, server) => {
    const token = await unlockThroughUi(server);

    const res = await post(server, "/setup", { csrf: token, passphrase: "another-passphrase", confirmPassphrase: "another-passphrase" });
    assert.match(decodeURIComponent(res.headers.get("location") ?? ""), /すでに保管庫が作成されています/);
  });
});

test("locked screen shows passphrase and recovery-key unlock forms once a vault exists", async () => {
  await withWebUi(async (app, server) => {
    await unlockThroughUi(server);
    app.lock();

    const html = await getHtml(server);
    assert.match(html, /action="\/unlock"/);
    assert.match(html, /action="\/unlock-recovery"/);
    assert.ok(!html.includes('action="/setup"'));
    assert.match(html, /パスフレーズとリカバリーキーの両方が分からない場合/);
  });
});

test("dashboard shows a recovery-key reminder until a recovery key is generated", async () => {
  await withWebUi(async (_app, server) => {
    const token = await unlockThroughUi(server);

    const before = await getHtml(server);
    assert.match(before, /リカバリーキーが未設定です/);

    await fetch(new URL("/recovery/generate", server.url), {
      method: "POST",
      body: new URLSearchParams({ csrf: token }),
    });

    const after = await getHtml(server);
    assert.ok(!after.includes("リカバリーキーが未設定です"));
  });
});

test("dashboard explains idle auto-lock duration when idle auto-lock is enabled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "af-poc-web-ui-"));
  const app = new CatashiroApp({ stateDir: dir, idleLockMs: 5 * 60 * 1000 });
  const server = await startWebUiServer({ app, port: 0 });
  try {
    await unlockThroughUi(server);
    const html = await getHtml(server);
    assert.match(html, /5分で自動的にロックされます/);
  } finally {
    await server.close();
    await app.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});

test("profile routes save locally, mask sensitive values, and require re-authentication to reveal", async () => {
  await withWebUi(async (app, server) => {
    const token = await unlockThroughUi(server);

    const save = await post(server, "/profile/save", {
      csrf: token,
      knownKey: "card.number",
      value: "4242424242424242",
    });
    assert.equal(save.status, 303);
    assert.equal(app.store.getValue("card.number"), "4242424242424242");

    const dashboard = await getHtml(server);
    assert.match(dashboard, /\*\*\*\* \*\*\*\* \*\*\*\* 4242/);
    assert.ok(!dashboard.includes("4242424242424242"));

    const badReveal = await post(server, "/profile/reveal", {
      csrf: token,
      key: "card.number",
      passphrase: "wrong-passphrase",
    });
    assert.equal(badReveal.status, 303);
    assert.match(badReveal.headers.get("location") ?? "", /error=/);

    const goodReveal = await fetch(new URL("/profile/reveal", server.url), {
      method: "POST",
      body: new URLSearchParams({ csrf: token, key: "card.number", passphrase: PASSPHRASE }),
    });
    assert.equal(goodReveal.status, 200);
    assert.match(await goodReveal.text(), /4242424242424242/);
  });
});

test("profile tab uses a whole-page edit form with one bottom save action", async () => {
  await withWebUi(async (app, server) => {
    const token = await unlockThroughUi(server);
    app.store.setProfileValue("card.number", "カード番号", "4242424242424242");

    const view = await getHtml(server, "/?tab=profile");
    assert.match(view, /href="\/\?tab=profile&mode=edit">編集/);
    assert.ok(!view.includes("<summary>編集</summary>"));

    const edit = await getHtml(server, "/?tab=profile&mode=edit");
    assert.match(edit, /action="\/profile\/save-all"/);
    assert.match(edit, /<button type="submit">保存<\/button>/);
    assert.match(edit, /設定済み。変更する場合だけ入力/);
    assert.ok(!edit.includes("4242424242424242"));

    const saved = await post(server, "/profile/save-all", {
      csrf: token,
      "profile.name.full": "山田太郎",
      "profile.email": "taro@example.test",
      "profile.card.number": "",
      customSlug: "occupation",
      customLabel: "職業",
      customValue: "会社員",
      customTerms: "職業, ご職業",
    });
    assert.equal(saved.status, 303);
    assert.equal(app.store.getValue("name.full"), "山田太郎");
    assert.equal(app.store.getValue("email"), "taro@example.test");
    assert.equal(app.store.getValue("card.number"), "4242424242424242");
    assert.equal(app.store.getValue("custom.occupation"), "会社員");
  });
});

test("profile edit form validates field formats with clear Japanese error messages", async () => {
  await withWebUi(async (app, server) => {
    const token = await unlockThroughUi(server);

    const invalidEmail = await post(server, "/profile/save-all", {
      csrf: token,
      "profile.email": "not-an-email",
    });
    assert.equal(invalidEmail.status, 303);
    assert.match(decodeURIComponent(invalidEmail.headers.get("location") ?? ""), /メールアドレスの形式が正しくありません/);
    assert.equal(app.store.getValue("email"), undefined);

    const invalidPostal = await post(server, "/profile/save-all", {
      csrf: token,
      "profile.postal.full": "abcde",
    });
    assert.match(decodeURIComponent(invalidPostal.headers.get("location") ?? ""), /郵便番号は7桁の数字/);

    const invalidCvv = await post(server, "/profile/save-all", {
      csrf: token,
      "profile.card.cvv": "12",
    });
    assert.match(decodeURIComponent(invalidCvv.headers.get("location") ?? ""), /セキュリティコードは3〜4桁の数字/);

    const valid = await post(server, "/profile/save-all", {
      csrf: token,
      "profile.email": "taro@example.test",
      "profile.postal.full": "100-0001",
    });
    assert.equal(valid.status, 303);
    assert.match(valid.headers.get("location") ?? "", /ok=/);
    assert.equal(app.store.getValue("email"), "taro@example.test");
    assert.equal(app.store.getValue("postal.full"), "100-0001");
  });
});

test("profile edit form deletes known and custom fields via delete checkboxes", async () => {
  await withWebUi(async (app, server) => {
    const token = await unlockThroughUi(server);
    app.store.setProfileValue("card.number", "カード番号", "4242424242424242");
    app.store.setProfileValue("custom.occupation", "職業", "会社員", ["職業", "ご職業"]);
    await app.store.save();

    const edit = await getHtml(server, "/?tab=profile&mode=edit");
    assert.match(edit, /name="deleteKeys" value="card\.number"/);
    assert.match(edit, /name="customDeleteKeys" value="custom\.occupation"/);

    const saved = await post(server, "/profile/save-all", {
      csrf: token,
      deleteKeys: "card.number",
      customExistingKey: "custom.occupation",
      customExistingLabel: "職業",
      customExistingValue: "会社員",
      customExistingTerms: "職業, ご職業",
      customDeleteKeys: "custom.occupation",
    });
    assert.equal(saved.status, 303);
    assert.equal(app.store.getValue("card.number"), undefined);
    assert.equal(app.store.getValue("custom.occupation"), undefined);
  });
});

test("revealing the card security code shows an extra handling warning", async () => {
  await withWebUi(async (app, server) => {
    const token = await unlockThroughUi(server);
    app.store.setProfileValue("card.cvv", "セキュリティコード", "123");
    app.store.setProfileValue("card.number", "カード番号", "4242424242424242");
    await app.store.save();

    const cvvReveal = await fetch(new URL("/profile/reveal", server.url), {
      method: "POST",
      body: new URLSearchParams({ csrf: token, key: "card.cvv", passphrase: PASSPHRASE }),
    });
    assert.equal(cvvReveal.status, 200);
    const cvvHtml = await cvvReveal.text();
    assert.match(cvvHtml, /123/);
    assert.match(cvvHtml, /最も重要な情報です/);

    const numberReveal = await fetch(new URL("/profile/reveal", server.url), {
      method: "POST",
      body: new URLSearchParams({ csrf: token, key: "card.number", passphrase: PASSPHRASE }),
    });
    assert.equal(numberReveal.status, 200);
    const numberHtml = await numberReveal.text();
    assert.match(numberHtml, /4242424242424242/);
    assert.ok(!numberHtml.includes("最も重要な情報です"));
  });
});

test("top navigation renders three tabs and the sites tab leads with guided site add", async () => {
  await withWebUi(async (_app, server) => {
    await unlockThroughUi(server);
    const html = await getHtml(server, "/?tab=sites");

    assert.match(html, /<a href="\/\?tab=profile"/);
    assert.match(html, /<a href="\/\?tab=sites" class="active" aria-current="page">登録済みサイト<\/a>/);
    assert.match(html, /<a href="\/\?tab=settings"/);
    assert.match(html, /<h2>登録済みサイト<\/h2>/);

    assert.ok(html.indexOf("<h3>サイトを追加</h3>") >= 0);
    assert.match(html, /name="accountStatus" value="notRegistered"/);
    assert.match(html, /name="accountStatus" value="registered"/);
    assert.match(html, /name="accountStatus" value="uncertain"/);
    assert.ok(!html.includes("<h3>一括更新</h3>"));
    assert.match(html, /差分のあるサイトはありません/);
  });
});

test("site add flow imports an existing account into the account-state inventory", async () => {
  await withWebUi(async (app, server) => {
    const token = await unlockThroughUi(server);

    const res = await post(server, "/site/add", {
      csrf: token,
      url: "https://accounts.example.test/login",
      accountStatus: "registered",
    });
    assert.equal(res.status, 303);
    assert.match(decodeURIComponent(res.headers.get("location") ?? ""), /既存アカウントとしてサイト一覧に取り込みました/);

    const record = app.store.listSiteRecords().find((site) => site.siteId === "accounts.example.test");
    assert.ok(record);
    assert.equal(record.origin, "https://accounts.example.test");
    assert.equal(record.serviceName, "accounts.example.test");
    assert.equal(record.accountState, "imported");
    assert.equal(record.nextAction, "reviewInventory");
    assert.equal(record.filledFields.length, 0);

    const html = await getHtml(server, "/?tab=sites");
    assert.match(html, /accounts\.example\.test/);
  });
});

test("site add flow asks the user to choose when account existence is uncertain", async () => {
  await withWebUi(async (app, server) => {
    const token = await unlockThroughUi(server);

    const res = await post(server, "/site/add", {
      csrf: token,
      url: "example.test/register",
      accountStatus: "uncertain",
    });
    assert.equal(res.status, 303);
    assert.match(decodeURIComponent(res.headers.get("location") ?? ""), /既存アカウントの有無を選んでから続行してください/);
    assert.equal(app.store.listSiteRecords().length, 0);
  });
});

test("custom profile fields and provider settings persist through the encrypted store", async () => {
  await withWebUi(async (app, server) => {
    const token = await unlockThroughUi(server);

    const custom = await post(server, "/profile/save", {
      csrf: token,
      customSlug: "occupation",
      customLabel: "職業",
      value: "会社員",
      matchTerms: "職業, ご職業",
    });
    assert.equal(custom.status, 303);
    assert.equal(app.store.getValue("custom.occupation"), "会社員");
    assert.deepEqual(app.store.profile.get("custom.occupation")?.matchTerms, ["職業", "ご職業"]);

    const settings = await post(server, "/settings/provider", {
      csrf: token,
      provider: "openai",
      mode: "ai",
      model: "gpt-5.4",
      apiKey: "sk-test",
    });
    assert.equal(settings.status, 303);
    assert.deepEqual(app.store.getSettings(), { provider: "openai", model: "gpt-5.4", apiKey: "sk-test", mode: "ai" });

    const dashboard = await getHtml(server);
    assert.match(dashboard, /gpt-5\.4/);
    assert.ok(!dashboard.includes("sk-test"));

    const reveal = await fetch(new URL("/settings/reveal-api-key", server.url), {
      method: "POST",
      body: new URLSearchParams({ csrf: token, passphrase: PASSPHRASE }),
    });
    assert.equal(reveal.status, 200);
    assert.match(await reveal.text(), /sk-test/);
  });
});

test("candidate definitions can be previewed and marked submitted from the local UI", async () => {
  await withWebUi(async (app, server) => {
    const token = await unlockThroughUi(server);
    app.store.upsertLocalCandidate(localCandidate("candidate-alpha"));
    await app.store.save();

    const html = await getHtml(server, "/?tab=candidates");
    assert.match(html, /候補定義/);
    assert.match(html, /候補サイト/);
    assert.match(html, /candidate-alpha/);
    assert.match(html, /提出JSONをダウンロード/);
    assert.match(html, /&quot;profileKey&quot;: &quot;email&quot;/);

    const res = await fetch(new URL("/candidates/candidate-alpha/submit", server.url), {
      method: "POST",
      body: new URLSearchParams({ csrf: token }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    assert.match(res.headers.get("content-disposition") ?? "", /catashiro-candidate-candidate-alpha\.json/);
    const draft = (await res.json()) as { title: string; candidate: LocalCandidateDefinition };
    assert.equal(draft.title, "Local candidate definition: 候補サイト");
    assert.equal(draft.candidate.status, "submitted");
    assert.equal(app.store.getLocalCandidate("candidate-alpha")?.status, "submitted");

    const after = await getHtml(server, "/?tab=candidates");
    assert.match(after, /candidate-alpha \/ ai \/ submitted/);
    assert.match(after, /disabled>提出JSONをダウンロード/);
  });
});

test("recovery key routes generate, verify, and remove the local recovery wrap", async () => {
  await withWebUi(async (app, server) => {
    const token = await unlockThroughUi(server);

    const generated = await fetch(new URL("/recovery/generate", server.url), {
      method: "POST",
      body: new URLSearchParams({ csrf: token }),
    });
    assert.equal(generated.status, 200);
    const html = await generated.text();
    const recoveryKey = /([A-Z2-7]{4}-){12}[A-Z2-7]{4}/.exec(html)?.[0];
    assert.ok(recoveryKey);
    assert.equal(app.store.hasRecoveryKey, true);

    const verified = await post(server, "/recovery/verify", {
      csrf: token,
      recoveryKey,
    });
    assert.equal(verified.status, 303);
    assert.match(verified.headers.get("location") ?? "", /ok=/);

    const removed = await post(server, "/recovery/remove", { csrf: token });
    assert.equal(removed.status, 303);
    assert.equal(app.store.hasRecoveryKey, false);
  });
});

test("diagnostics export requires confirmation and returns a redacted support bundle", async () => {
  await withWebUi(async (app, server) => {
    const token = await unlockThroughUi(server);
    app.store.addDiagnosticEvent({
      type: "error",
      severity: "error",
      message: "fake error for taro@example.test",
      metadata: { note: "card 4111 1111 1111 1111" },
    });

    const settings = await getHtml(server, "/?tab=settings");
    assert.match(settings, /サポート診断/);

    const missingConfirm = await post(server, "/diagnostics/export", { csrf: token });
    assert.equal(missingConfirm.status, 303);
    assert.match(decodeURIComponent(missingConfirm.headers.get("location") ?? ""), /確認チェック/);

    const exported = await fetch(new URL("/diagnostics/export", server.url), {
      method: "POST",
      body: new URLSearchParams({ csrf: token, confirm: "1" }),
    });
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get("content-type") ?? "", /application\/json/);
    const body = await exported.text();
    assert.match(body, /catashiro-support-bundle-v1/);
    assert.ok(!body.includes("taro@example.test"));
    assert.ok(!body.includes("4111 1111 1111 1111"));
  });
});

test("dashboard shows site inventory and stale bulk-update candidates without raw values", async () => {
  await withWebUi(async (app, server) => {
    await app.unlock(PASSPHRASE);
    app.store.setProfileValue("email", "メールアドレス", "new@example.test");
    app.store.upsertSiteRecord({
      origin: "https://example.test",
      siteId: "example",
      serviceName: "Example Service",
      registeredAt: Date.now(),
      filledFields: [
        {
          profileKey: "email",
          filledValueHash: sha256Hex("old@example.test"),
          fieldName: "email",
          filledAt: Date.now(),
        },
      ],
      accountState: "registered",
      status: "registered",
      nextAction: "reviewInventory",
    });

    const html = await getHtml(server, "/?tab=sites");
    assert.match(html, /Example Service/);
    assert.match(html, /更新候補 1/);
    assert.match(html, /メールアドレス/);
    assert.match(html, /name="bulkField"/);
    assert.match(html, /value="example\|email"/);
    assert.ok(!html.includes("new@example.test"));
    assert.ok(!html.includes("old@example.test"));

    const registrationIndex = html.indexOf("<h3>サイトを追加</h3>");
    const bulkIndex = html.indexOf("<h3>一括更新</h3>");
    assert.ok(registrationIndex >= 0);
    assert.ok(bulkIndex > registrationIndex);
  });
});

test("bulk update start requires selected stale site fields", async () => {
  await withWebUi(async (app, server) => {
    const token = await unlockThroughUi(server);
    app.store.setProfileValue("email", "メールアドレス", "new@example.test");
    app.store.upsertSiteRecord({
      origin: "https://example.test",
      siteId: "example",
      serviceName: "Example Service",
      registeredAt: Date.now(),
      filledFields: [
        {
          profileKey: "email",
          filledValueHash: sha256Hex("old@example.test"),
          fieldName: "email",
          filledAt: Date.now(),
        },
      ],
      accountState: "registered",
      status: "registered",
      nextAction: "reviewInventory",
    });

    const res = await post(server, "/bulk/start", { csrf: token });
    assert.equal(res.status, 303);
    assert.match(decodeURIComponent(res.headers.get("location") ?? ""), /更新するサイトと項目を選択してください/);
  });
});

test("withdrawal task flow requires explicit final-action confirmation", async () => {
  await withWebUi(async (app, server) => {
    const token = await unlockThroughUi(server);
    app.store.upsertSiteRecord({
      origin: "https://example.test",
      siteId: "example",
      serviceName: "Example Service",
      registeredAt: Date.now(),
      filledFields: [],
      accountState: "registered",
      status: "registered",
      nextAction: "reviewInventory",
    });

    const html = await getHtml(server, "/?tab=sites");
    assert.match(html, /退会候補にする/);

    const marked = await post(server, "/withdrawal/mark", { csrf: token, siteId: "example" });
    assert.equal(marked.status, 303);
    assert.equal(app.store.getSiteRecord("example")?.accountState, "withdrawalCandidate");
    assert.equal(app.store.getSiteRecord("example")?.nextAction, "prepareWithdrawal");

    const candidate = await getHtml(server, "/?tab=sites");
    assert.match(candidate, /退会タスク/);
    assert.match(candidate, /最終ボタンは自動で押しません/);
    assert.match(candidate, /action="\/withdrawal\/start"/);

    const missingConfirm = await post(server, "/withdrawal/prepare", { csrf: token, siteId: "example" });
    assert.equal(missingConfirm.status, 303);
    assert.equal(app.store.getSiteRecord("example")?.withdrawalPreparedAt, undefined);

    const missingRunConfirm = await post(server, "/withdrawal/start", { csrf: token, siteId: "example" });
    assert.equal(missingRunConfirm.status, 303);
    assert.match(decodeURIComponent(missingRunConfirm.headers.get("location") ?? ""), /最終操作を自動化しない確認が必要です/);
    assert.equal(app.store.getSiteRecord("example")?.withdrawalPreparedAt, undefined);

    const prepared = await post(server, "/withdrawal/prepare", {
      csrf: token,
      siteId: "example",
      confirmFinalManual: "1",
    });
    assert.equal(prepared.status, 303);
    const record = app.store.getSiteRecord("example")!;
    assert.ok(record.withdrawalPreparedAt);
    assert.equal(record.withdrawalFinalConfirmationRequired, true);
  });
});

test("POST /shutdown renders stopping page and invokes onShutdownRequest callback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "af-poc-web-ui-shutdown-"));
  const app = new CatashiroApp({ stateDir: dir, idleLockMs: 0 });
  let callbackInvoked = false;
  const server = await startWebUiServer({
    app,
    port: 0,
    onShutdownRequest: () => { callbackInvoked = true; },
  });
  try {
    const token = csrf(await getHtml(server));
    const res = await post(server, "/shutdown", { csrf: token });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Catashiro を停止しています/);
    assert.ok(callbackInvoked, "onShutdownRequest must be called after the response is sent");
  } finally {
    await server.close();
    await app.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});
