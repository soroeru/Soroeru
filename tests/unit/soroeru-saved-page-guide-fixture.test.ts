import assert from "node:assert/strict";
import { test } from "node:test";
import { startPocServer } from "../../sites/server.js";

test("saved-page guide fixture provides fake-only wall and account pages for screenshots", async () => {
  const server = await startPocServer();
  try {
    const wall = await fetch(new URL("/saved-page-guide/wall", server.url));
    assert.equal(wall.status, 200);
    const wallHtml = await wall.text();
    assert.match(wallHtml, /実際の CAPTCHA ウィジェットではありません/);
    assert.doesNotMatch(wallHtml, /hcaptcha\.com|google\.com\/recaptcha|challenges\.cloudflare\.com/i);

    const account = await fetch(new URL("/saved-page-guide/account", server.url));
    assert.equal(account.status, 200);
    const accountHtml = await account.text();
    assert.match(accountHtml, /guide-user@example\.test/);
    assert.match(accountHtml, /address\[zip\]/);
    assert.doesNotMatch(accountHtml, /yoyostorerewind|shopify|gmail|icloud/i);
  } finally {
    await server.close();
  }
});
