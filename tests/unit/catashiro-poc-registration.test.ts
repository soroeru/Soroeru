// New-registration flow wired into the web UI (#81): `RegistrationSession`'s
// hook-pause state machine, and the `/registration/*` routes driving it
// end-to-end against the local PoC test sites (happy path, missing-data
// prompt, gate decline, auto-creation ban, payment guard).

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium, type Browser, type Page } from "playwright";
import { startPocServer, type PocServer } from "../../sites/server.js";
import { CatashiroApp } from "../../src/app/app.js";
import { startWebUiServer, type WebUiServerHandle } from "../../src/app/web-ui.js";
import { AppRunner, type AppRunnerHooks } from "../../src/app/runner.js";
import { RegistrationSession } from "../../src/app/registration-session.js";
import { DUMMY_PROFILE_SEED } from "../../src/profile.js";
import type { RegistrationResult } from "../../src/agent/agent.js";

const PASSPHRASE = "unit-test-passphrase";

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

/** Poll the sites tab until `predicate` matches; the registration run advances in the background. */
async function pollSites(server: WebUiServerHandle, predicate: (html: string) => boolean, timeoutMs = 20000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const html = await getHtml(server, "/?tab=sites");
    if (predicate(html)) return html;
    if (Date.now() > deadline) throw new Error(`timed out waiting for registration state; last html:\n${html}`);
    await sleep(100);
  }
}

/** The default launcher opens a headed browser; tests always run headless. */
const headlessChromium = async (): Promise<Browser> => chromium.launch({ headless: true });

/** Browser launcher that fails the test if it is ever called. */
const refuseLaunch = async (): Promise<Browser> => {
  throw new Error("unexpected browser launch");
};

async function withRegistrationWebUi(
  fn: (ctx: { app: CatashiroApp; server: WebUiServerHandle; site: PocServer; token: string }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "af-poc-registration-"));
  const site = await startPocServer();
  const app = new CatashiroApp({ stateDir: dir, idleLockMs: 0, launchBrowserFn: headlessChromium });
  const server = await startWebUiServer({ app, port: 0 });
  try {
    const token = await unlockThroughUi(server);
    for (const seed of DUMMY_PROFILE_SEED) app.store.setProfileValue(seed.key, seed.label, seed.value);
    await app.store.save();
    await fn({ app, server, site, token });
  } finally {
    await server.close();
    await app.shutdown();
    await site.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("starting registration with an empty URL warns and does not launch a browser", async () => {
  const dir = await mkdtemp(join(tmpdir(), "af-poc-registration-"));
  const app = new CatashiroApp({ stateDir: dir, idleLockMs: 0, launchBrowserFn: refuseLaunch });
  const server = await startWebUiServer({ app, port: 0 });
  try {
    const token = await unlockThroughUi(server);
    const res = await post(server, "/registration/start", { csrf: token, url: "" });
    assert.equal(res.status, 303);
    assert.match(decodeURIComponent(res.headers.get("location") ?? ""), /サイトのURLを入力してください/);
  } finally {
    await server.close();
    await app.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});

test("registration happy path: 01-basic fills the form, shows the gate, and registers on approval", async () => {
  await withRegistrationWebUi(async ({ server, token, site }) => {
    const start = await post(server, "/registration/start", { csrf: token, url: site.siteUrl("01-basic") });
    assert.equal(start.status, 303);
    assert.match(decodeURIComponent(start.headers.get("location") ?? ""), /新規登録を開始しました/);

    const gateHtml = await pollSites(server, (html) => html.includes("確認ゲート"));
    assert.match(gateHtml, /ベーシック商店/);
    assert.match(gateHtml, /この内容で登録する/);

    await post(server, "/registration/gate-decision", { csrf: token, decision: "approve" });

    const doneHtml = await pollSites(server, (html) => html.includes("登録が完了しました"));
    assert.match(doneHtml, /閉じる/);

    await post(server, "/registration/dismiss", { csrf: token });
    const afterHtml = await getHtml(server, "/?tab=sites");
    assert.match(afterHtml, /<h3>新規登録<\/h3>/);
  });
});

test("registration with a missing field: 05-choices prompts for 「ご職業」, then registers once it is provided", async () => {
  await withRegistrationWebUi(async ({ server, token, site }) => {
    await post(server, "/registration/start", { csrf: token, url: site.siteUrl("05-choices") });

    const promptHtml = await pollSites(server, (html) => html.includes("追加情報の入力"));
    assert.match(promptHtml, /ご職業/);

    await post(server, "/registration/provide-data", { csrf: token, value: "会社員" });

    const gateHtml = await pollSites(server, (html) => html.includes("確認ゲート"));
    assert.match(gateHtml, /チョイス会員サービス/);

    await post(server, "/registration/gate-decision", { csrf: token, decision: "approve" });

    const doneHtml = await pollSites(server, (html) => html.includes("登録が完了しました"));
    assert.ok(doneHtml);
  });
});

test("registration: declining the gate ends the run as declined without submitting", async () => {
  await withRegistrationWebUi(async ({ server, token, site }) => {
    await post(server, "/registration/start", { csrf: token, url: site.siteUrl("01-basic") });
    await pollSites(server, (html) => html.includes("確認ゲート"));

    await post(server, "/registration/gate-decision", { csrf: token, decision: "decline" });

    const doneHtml = await pollSites(server, (html) => html.includes("ユーザーの判断で中止しました"));
    assert.ok(doneHtml);
  });
});

test("registration on an auto-creation-prohibited site: fills only and reports assisted fill", async () => {
  await withRegistrationWebUi(async ({ server, token, site }) => {
    await post(server, "/registration/start", { csrf: token, url: site.siteUrl("10-no-auto") });

    const gateHtml = await pollSites(server, (html) => html.includes("確認ゲート"));
    assert.match(gateHtml, /no-auto-creation|自動化された手段/);

    await post(server, "/registration/gate-decision", { csrf: token, decision: "approve" });

    const doneHtml = await pollSites(server, (html) => html.includes("入力のみ完了しました"));
    assert.ok(doneHtml);
  });
});

test("registration with card fields: approving without the card checkbox stops before filling card data (payment guard)", async () => {
  await withRegistrationWebUi(async ({ server, token, site }) => {
    await post(server, "/registration/start", { csrf: token, url: site.siteUrl("09-trial-card") });

    const gateHtml = await pollSites(server, (html) => html.includes("確認ゲート"));
    assert.match(gateHtml, /name="cardApproved"/);
    assert.match(gateHtml, /無料トライアル終了後の課金を承認/);

    // Approve the gate but leave `cardApproved` unchecked: guard 2 must stop
    // before any card value is filled or submitted.
    await post(server, "/registration/gate-decision", { csrf: token, decision: "approve" });

    const doneHtml = await pollSites(server, (html) => html.includes("ユーザーの判断で中止しました"));
    assert.ok(doneHtml);
  });
});

test("starting a new registration while one is in progress shows a warning", async () => {
  await withRegistrationWebUi(async ({ server, token, site }) => {
    await post(server, "/registration/start", { csrf: token, url: site.siteUrl("01-basic") });
    await pollSites(server, (html) => html.includes("確認ゲート"));

    const second = await post(server, "/registration/start", { csrf: token, url: site.siteUrl("01-basic") });
    assert.match(decodeURIComponent(second.headers.get("location") ?? ""), /別の登録処理が進行中です/);

    // Clean up the in-flight session so `withRegistrationWebUi`'s shutdown doesn't hang.
    await post(server, "/registration/gate-decision", { csrf: token, decision: "decline" });
    await pollSites(server, (html) => html.includes("ユーザーの判断で中止しました"));
  });
});

// --- RegistrationSession state machine (no real browser; wall hand-off is not
// exercised by any local test site, so it is covered at this level) ---------

function fakeResult(status: RegistrationResult["status"]): RegistrationResult {
  return { status, planned: [], gateShown: true, highRiskFlags: [], notes: [] };
}

/** A stub `AppRunner` whose `register()` is the test's hook script (no real browser). */
function fakeRunner(register: (page: Page, url: string, hooks: AppRunnerHooks) => Promise<RegistrationResult>): AppRunner {
  return { register } as unknown as AppRunner;
}

const FAKE_PAGE = {} as unknown as Page;

test("RegistrationSession: a missing-data prompt pauses the run until provideData resolves it", async () => {
  const runner = fakeRunner(async (_page, _url, hooks) => {
    const value = await hooks.promptUser("ご職業");
    assert.equal(value, "会社員");
    return fakeResult("registered");
  });

  const session = new RegistrationSession(runner, FAKE_PAGE, "http://example.test");
  session.start();
  await sleep(0);

  const awaiting = session.getState();
  assert.equal(awaiting.kind, "awaiting-data");
  assert.equal((awaiting as { label: string }).label, "ご職業");

  assert.equal(session.provideData("会社員"), true);
  await sleep(0);

  const done = session.getState();
  assert.equal(done.kind, "done");
  assert.equal((done as { result: RegistrationResult }).result.status, "registered");
});

test("RegistrationSession: the review-and-confirm gate pauses the run until decideGate resolves it", async () => {
  const runner = fakeRunner(async (_page, _url, hooks) => {
    const decision = await hooks.gate.decide({
      origin: "http://example.test",
      serviceName: "Example",
      fields: [],
      termsLinks: [],
      analysis: { highRiskFlags: [], evidence: {}, prohibitsAutoCreation: false },
      attestations: [],
    });
    return fakeResult(decision.approved ? "registered" : "declined");
  });

  const session = new RegistrationSession(runner, FAKE_PAGE, "http://example.test");
  session.start();
  await sleep(0);
  assert.equal(session.getState().kind, "awaiting-gate");

  assert.equal(session.decideGate({ approved: false, attestationApprovals: {}, cardApproved: false }), true);
  await sleep(0);

  const done = session.getState();
  assert.equal(done.kind, "done");
  assert.equal((done as { result: RegistrationResult }).result.status, "declined");
});

test("RegistrationSession: a wall hand-off pauses the run; resolving it resumes or aborts", async () => {
  const wall = { kind: "captcha" as const, evidence: "g-recaptcha" };

  const resumed = fakeRunner(async (_page, _url, hooks) => {
    const outcome = await hooks.handoff!(wall, "CAPTCHAが表示されました。解決してから再開してください。");
    return fakeResult(outcome === "resolved" ? "registered" : "manualHandoff");
  });

  const resumeSession = new RegistrationSession(resumed, FAKE_PAGE, "http://example.test");
  resumeSession.start();
  await sleep(0);
  const awaiting = resumeSession.getState();
  assert.equal(awaiting.kind, "awaiting-handoff");
  assert.deepEqual((awaiting as { wall: typeof wall }).wall, wall);

  assert.equal(resumeSession.resolveHandoff("resolved"), true);
  await sleep(0);
  const resumedDone = resumeSession.getState();
  assert.equal(resumedDone.kind, "done");
  assert.equal((resumedDone as { result: RegistrationResult }).result.status, "registered");

  const aborted = fakeRunner(async (_page, _url, hooks) => {
    const outcome = await hooks.handoff!(wall, "CAPTCHAが表示されました。解決してから再開してください。");
    return fakeResult(outcome === "resolved" ? "registered" : "manualHandoff");
  });

  const abortSession = new RegistrationSession(aborted, FAKE_PAGE, "http://example.test");
  abortSession.start();
  await sleep(0);
  assert.equal(abortSession.getState().kind, "awaiting-handoff");

  assert.equal(abortSession.resolveHandoff("abort"), true);
  await sleep(0);
  const abortDone = abortSession.getState();
  assert.equal(abortDone.kind, "done");
  assert.equal((abortDone as { result: RegistrationResult }).result.status, "manualHandoff");
});

test("RegistrationSession: an exception during register() surfaces as an error state", async () => {
  const runner = {
    register: async () => {
      throw new Error("boom");
    },
  } as unknown as AppRunner;

  const session = new RegistrationSession(runner, FAKE_PAGE, "http://example.test");
  session.start();
  await sleep(0);

  const state = session.getState();
  assert.equal(state.kind, "error");
  assert.equal((state as { message: string }).message, "boom");
});

test("RegistrationSession: resolver methods return false when nothing is pending", () => {
  const runner = {
    register: () => new Promise<RegistrationResult>(() => {}),
  } as unknown as AppRunner;

  const session = new RegistrationSession(runner, FAKE_PAGE, "http://example.test");
  // Before start(), the state is "running" and no hook has registered a resolver.
  assert.equal(session.provideData("x"), false);
  assert.equal(session.decideGate({ approved: true, attestationApprovals: {}, cardApproved: false }), false);
  assert.equal(session.resolveHandoff("resolved"), false);
});
