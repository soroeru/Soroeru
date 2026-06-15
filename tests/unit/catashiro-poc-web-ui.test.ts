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

test("top navigation renders three tabs and the sites tab leads with new registration", async () => {
  await withWebUi(async (_app, server) => {
    await unlockThroughUi(server);
    const html = await getHtml(server, "/?tab=sites");

    assert.match(html, /<a href="\/\?tab=profile"/);
    assert.match(html, /<a href="\/\?tab=sites" class="active" aria-current="page">登録済みサイト<\/a>/);
    assert.match(html, /<a href="\/\?tab=settings"/);
    assert.match(html, /<h2>登録済みサイト<\/h2>/);

    assert.ok(html.indexOf("<h3>新規登録</h3>") >= 0);
    assert.ok(!html.includes("<h3>一括更新</h3>"));
    assert.match(html, /差分のあるサイトはありません/);
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
      model: "gpt-5.4",
      apiKey: "sk-test",
    });
    assert.equal(settings.status, 303);
    assert.deepEqual(app.store.getSettings(), { provider: "openai", model: "gpt-5.4", apiKey: "sk-test" });

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
    assert.ok(!html.includes("new@example.test"));
    assert.ok(!html.includes("old@example.test"));

    const registrationIndex = html.indexOf("<h3>新規登録</h3>");
    const bulkIndex = html.indexOf("<h3>一括更新</h3>");
    assert.ok(registrationIndex >= 0);
    assert.ok(bulkIndex > registrationIndex);
  });
});
