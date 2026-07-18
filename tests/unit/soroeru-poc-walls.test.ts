import assert from "node:assert/strict";
import { test } from "node:test";
import { clearWalls, detectWall, handoffInstruction } from "../../src/agent/walls.js";
import type { PageSnapshot, WallDetection } from "../../src/types.js";

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

test("an iframe-only CAPTCHA marker can be treated as passive only at a recognized login form", () => {
  const passiveMarker = snapshot({ iframeSrcs: ["https://www.google.com/recaptcha/enterprise/anchor"] });
  assert.equal(detectWall(passiveMarker)?.kind, "captcha");
  assert.equal(detectWall(passiveMarker, { ignorePassiveCaptchaIframes: true }), undefined);

  const visibleChallenge = snapshot({
    iframeSrcs: ["https://www.google.com/recaptcha/enterprise/anchor"],
    visibleCaptchaChallengeIframeSrcs: ["https://www.google.com/recaptcha/enterprise/bframe"],
  });
  assert.equal(detectWall(visibleChallenge, { ignorePassiveCaptchaIframes: true })?.kind, "captcha");
  assert.equal(
    detectWall(snapshot({ visibleText: "私はロボットではありません" }), { ignorePassiveCaptchaIframes: true })?.kind,
    "captcha",
  );
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

test("ambiguous access-control wording is detected conservatively", () => {
  assert.equal(detectWall(snapshot({ visibleText: "通常と異なるアクセスを検知しました。しばらくしてから再度お試しください。" }))?.kind, "ambiguous");
  assert.equal(detectWall(snapshot({ visibleText: "Security check: suspicious activity detected." }))?.kind, "ambiguous");
});

test("an ordinary registration page is not a wall", () => {
  assert.equal(detectWall(snapshot({ visibleText: "会員登録フォーム。氏名とメールアドレスを入力してください。" })), undefined);
});

test("site-forced password reset wording is detected (Issue #372)", () => {
  // Wording modelled on account.nicovideo.jp's forced-reset gate (no real personal data).
  assert.equal(
    detectWall(
      snapshot({ visibleText: "2024年8月5日（月）以降に初めてログインする方は、パスワード再設定が必要です。" }),
    )?.kind,
    "password-reset",
  );
  assert.equal(
    detectWall(snapshot({ visibleText: "ご利用を続けるには、パスワードを再設定してください。" }))?.kind,
    "password-reset",
  );
  assert.equal(
    detectWall(snapshot({ visibleText: "Password reset required to continue." }))?.kind,
    "password-reset",
  );
  assert.equal(
    detectWall(snapshot({ visibleText: "Please reset your password to continue." }))?.kind,
    "password-reset",
  );
});

test("password-reset wins over the reset page's own Turnstile iframe (Issue #372)", () => {
  // The forced-reset page embeds a Cloudflare Turnstile; kind must still be
  // password-reset so the human gets the accurate hand-off instruction.
  const wall = detectWall(
    snapshot({
      visibleText: "パスワードの再設定が必要です。",
      iframeSrcs: ["https://challenges.cloudflare.com/turnstile/x"],
      wallMarkers: ["cf-turnstile"],
    }),
  );
  assert.equal(wall?.kind, "password-reset");
});

test("a login page that merely links to voluntary password reset is not a wall", () => {
  assert.equal(
    detectWall(
      snapshot({ visibleText: "ログイン。パスワードをお忘れの方はこちらからパスワードの再設定はこちら。" }),
    ),
    undefined,
  );
});

test("handoff instruction asks the human to resolve the wall, never how to bypass it", () => {
  const kinds: WallDetection["kind"][] = [
    "captcha",
    "mfa",
    "email-verification",
    "identity-verification",
    "password-reset",
    "ambiguous",
  ];
  for (const kind of kinds) {
    const msg = handoffInstruction({ kind, evidence: "x" });
    assert.ok(msg.length > 0, kind);
    assert.ok(msg.includes("あなた自身"), `${kind} should ask the user to resolve it`);
    // Copy must not suggest solving/bypassing/automating the wall (SEC-002).
    assert.ok(!/自動|回避|解除|突破|スキップ|bypass/i.test(msg), `${kind} copy must not suggest bypass`);
  }
});

test("password-reset handoff copy points at the paused browser session (Issue #372)", () => {
  // A reset finished via a mail link in the user's default browser leaves this
  // session unauthenticated, so the copy must anchor the fix to this browser.
  const msg = handoffInstruction({ kind: "password-reset", evidence: "x" });
  assert.ok(msg.includes("一時停止中のブラウザ"));
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

test("clearWalls aborts on every wall kind when no handoff is wired (fail-safe, SEC-002)", async () => {
  // SEC-002 (#23): regardless of which wall kind is detected, the agent must
  // never proceed past it without a human resolving it — this holds even if a
  // future detector change introduces a kind not yet covered by handoff
  // wiring (a "false negative" in the handoff path, not the detector).
  const fixtures: { kind: WallDetection["kind"]; snap: PageSnapshot }[] = [
    { kind: "captcha", snap: snapshot({ wallMarkers: ["g-recaptcha"] }) },
    {
      kind: "mfa",
      snap: snapshot({
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
    },
    { kind: "email-verification", snap: snapshot({ visibleText: "確認メールを送信しました。" }) },
    {
      kind: "identity-verification",
      snap: snapshot({ visibleText: "本人確認のため、運転免許証をアップロードしてください。" }),
    },
    {
      kind: "password-reset",
      snap: snapshot({ visibleText: "パスワード再設定が必要です。" }),
    },
    {
      kind: "ambiguous",
      snap: snapshot({ visibleText: "通常と異なるアクセスを検知しました。" }),
    },
  ];

  for (const { kind, snap } of fixtures) {
    assert.equal(detectWall(snap)?.kind, kind);
    let reobserved = false;
    const out = await clearWalls(snap, {
      reobserve: async () => {
        reobserved = true;
        return snap;
      },
      log: () => {},
    });
    assert.equal(out.status, "abort", kind);
    assert.equal(out.snapshot, snap, kind);
    assert.equal(reobserved, false, kind);
  }
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
