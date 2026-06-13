import assert from "node:assert/strict";
import { test } from "node:test";
import { clearWalls, detectWall, handoffInstruction } from "../../poc/autofill-agent/src/agent/walls.js";
import type { PageSnapshot, WallDetection } from "../../poc/autofill-agent/src/types.js";

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

test("SMS one-time-code wording is detected as mfa", () => {
  assert.equal(detectWall(snapshot({ visibleText: "", fields: [
    {
      fieldId: "f3", tag: "input", type: "text", name: "sms", id: "", autocomplete: "",
      required: true, placeholder: "SMSで送信された認証コード", labels: [], nearbyText: "",
    },
  ] }))?.kind, "mfa");
});

test("identity verification wording is detected", () => {
  assert.equal(
    detectWall(snapshot({ visibleText: "本人確認のため、運転免許証をアップロードしてください。" }))?.kind,
    "identity-verification",
  );
});

test("an ordinary registration page is not a wall", () => {
  assert.equal(detectWall(snapshot({ visibleText: "会員登録フォーム。氏名とメールアドレスを入力してください。" })), undefined);
});

test("handoff instruction asks the human to resolve the wall, never how to bypass it", () => {
  const kinds: WallDetection["kind"][] = ["captcha", "mfa", "email-verification", "identity-verification"];
  for (const kind of kinds) {
    const msg = handoffInstruction({ kind, evidence: "x" });
    assert.ok(msg.length > 0, kind);
    assert.ok(msg.includes("あなた自身"), `${kind} should ask the user to resolve it`);
    // Copy must not suggest solving/bypassing/automating the wall (SEC-002).
    assert.ok(!/自動|回避|解除|突破|スキップ|bypass/i.test(msg), `${kind} copy must not suggest bypass`);
  }
});

test("clearWalls re-observes after a resolved handoff and returns the resumed page", async () => {
  const resumed = snapshot({
    url: "http://localhost/resumed",
    visibleText: "会員登録フォーム。氏名とメールアドレスを入力してください。",
  });
  let handoffs = 0;
  let reobserved = 0;
  const out = await clearWalls(snapshot({ wallMarkers: ["g-recaptcha"] }), {
    handoff: async () => {
      handoffs += 1;
      return "resolved";
    },
    reobserve: async () => {
      reobserved += 1;
      return resumed;
    },
    log: () => {},
  });

  assert.equal(out.status, "clear");
  assert.equal(out.snapshot, resumed);
  assert.equal(handoffs, 1);
  assert.equal(reobserved, 1);
});

test("clearWalls catches chained walls and bounds the handoff loop", async () => {
  const chain = [
    snapshot({
      fields: [
        {
          fieldId: "otp",
          tag: "input",
          type: "text",
          name: "otp",
          id: "",
          autocomplete: "one-time-code",
          required: true,
          placeholder: "",
          labels: [],
          nearbyText: "",
        },
      ],
    }),
    snapshot({ visibleText: "確認メールを送信しました。" }),
    snapshot({ wallMarkers: ["cf-turnstile"] }),
  ];
  let handoffs = 0;
  const logs: string[] = [];
  const out = await clearWalls(snapshot({ wallMarkers: ["g-recaptcha"] }), {
    maxHandoffs: 3,
    handoff: async () => {
      handoffs += 1;
      return "resolved";
    },
    reobserve: async () => chain.shift() ?? snapshot({ visibleText: "done" }),
    log: (message) => logs.push(message),
  });

  assert.equal(out.status, "abort");
  assert.equal(handoffs, 3);
  assert.equal(chain.length, 0);
  assert.ok(logs.some((message) => message.includes("連続したため自動進行を停止")));
});

test("clearWalls aborts safely when no handoff is wired", async () => {
  let reobserved = false;
  const initial = snapshot({ visibleText: "私はロボットではありません" });
  const out = await clearWalls(initial, {
    reobserve: async () => {
      reobserved = true;
      return snapshot({});
    },
    log: () => {},
  });

  assert.equal(out.status, "abort");
  assert.equal(out.snapshot, initial);
  assert.equal(reobserved, false);
});

test("clearWalls aborts without re-observing when the human handoff is not resolved", async () => {
  let reobserved = false;
  const initial = snapshot({ visibleText: "確認メールを送信しました。" });
  const out = await clearWalls(initial, {
    handoff: async () => "abort",
    reobserve: async () => {
      reobserved = true;
      return snapshot({});
    },
    log: () => {},
  });

  assert.equal(out.status, "abort");
  assert.equal(out.snapshot, initial);
  assert.equal(reobserved, false);
});
