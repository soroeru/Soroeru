import assert from "node:assert/strict";
import { test } from "node:test";
import { detectWall } from "../../poc/autofill-agent/src/agent/walls.js";
import type { PageSnapshot } from "../../poc/autofill-agent/src/types.js";

function snapshot(partial: Partial<PageSnapshot>): PageSnapshot {
  return {
    url: "http://localhost/",
    title: "",
    fields: [],
    buttons: [],
    links: [],
    visibleText: "",
    iframeSrcs: [],
    wallMarkers: [],
    ...partial,
  };
}

test("captcha widgets are detected (never solved)", () => {
  assert.equal(detectWall(snapshot({ wallMarkers: ["g-recaptcha"] }))?.kind, "captcha");
  assert.equal(
    detectWall(snapshot({ iframeSrcs: ["https://challenges.cloudflare.com/turnstile/x"] }))?.kind,
    "captcha",
  );
  assert.equal(detectWall(snapshot({ visibleText: "私はロボットではありません" }))?.kind, "captcha");
});

test("otp / mfa fields are detected by traits", () => {
  const byAutocomplete = snapshot({
    fields: [
      {
        fieldId: "f1",
        tag: "input",
        type: "text",
        name: "code",
        id: "code",
        autocomplete: "one-time-code",
        required: true,
        placeholder: "",
        labels: [],
        nearbyText: "",
      },
    ],
  });
  assert.equal(detectWall(byAutocomplete)?.kind, "mfa");
  const byLabel = snapshot({
    fields: [
      {
        fieldId: "f2",
        tag: "input",
        type: "text",
        name: "c",
        id: "",
        autocomplete: "",
        required: true,
        placeholder: "",
        labels: ["認証コード"],
        nearbyText: "",
      },
    ],
  });
  assert.equal(detectWall(byLabel)?.kind, "mfa");
});

test("email verification wording is detected", () => {
  assert.equal(detectWall(snapshot({ visibleText: "確認メールを送信しました。" }))?.kind, "email-verification");
});

test("an ordinary registration page is not a wall", () => {
  assert.equal(detectWall(snapshot({ visibleText: "会員登録フォーム。氏名とメールアドレスを入力してください。" })), undefined);
});
