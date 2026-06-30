// New-registration flow wired into the web UI (#81): `RegistrationSession`'s
// hook-pause state machine, and the `/registration/*` routes driving it
// end-to-end against the local PoC test sites (happy path, missing-data
// prompt, gate decline, auto-creation ban, payment guard).

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { startPocServer, type PocServer } from "../../sites/server.js";
import { SoroeruApp } from "../../src/app/app.js";
import { startWebUiServer, type WebUiServerHandle } from "../../src/app/web-ui.js";
import { AppRunner, type AppRunnerHooks } from "../../src/app/runner.js";
import { RegistrationSession } from "../../src/app/registration-session.js";
import { DUMMY_PROFILE_SEED } from "../../src/profile.js";
import type { RegistrationResult } from "../../src/agent/agent.js";
import type { LocalCandidateDefinition } from "../../src/types.js";
import { getHtml, pollHtml, post, unlockThroughUi } from "./helpers/web-ui-client.js";
import { waitFor } from "./helpers/wait.js";

/** Poll the sites tab until `predicate` matches; the registration run advances in the background. */
function pollSites(server: WebUiServerHandle, predicate: (html: string) => boolean, timeoutMs = 60000): Promise<string> {
  return pollHtml(server, predicate, { path: "/?tab=sites", timeoutMs });
}

/** The default launcher opens a headed browser; tests always run headless. */
const headlessChromium = async (): Promise<Browser> => chromium.launch({ headless: true });

/** Browser launcher that fails the test if it is ever called. */
const refuseLaunch = async (): Promise<Browser> => {
  throw new Error("unexpected browser launch");
};

async function withRegistrationWebUi(
  fn: (ctx: { app: SoroeruApp; server: WebUiServerHandle; site: PocServer; token: string }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "af-poc-registration-"));
  const site = await startPocServer();
  const app = new SoroeruApp({ stateDir: dir, idleLockMs: 0, launchBrowserFn: headlessChromium });
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
  const app = new SoroeruApp({ stateDir: dir, idleLockMs: 0, launchBrowserFn: refuseLaunch });
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
    assert.match(afterHtml, /<h3>サイトを追加<\/h3>/);
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

test("registration prompts when a local candidate custom field has no stored value yet", async () => {
  await withRegistrationWebUi(async ({ app, server, token, site }) => {
    const now = Date.now();
    const candidate: LocalCandidateDefinition = {
      id: "candidate-choices-job",
      serviceName: "チョイス会員サービス",
      match: { urlPatterns: ["/site/05-choices/"] },
      fieldRules: [{ id: "job", profileKey: "custom.job", labelPattern: "ご職業" }],
      source: "observation",
      status: "candidate",
      createdAt: now,
      updatedAt: now,
    };
    app.store.upsertLocalCandidate(candidate);
    await app.store.save();

    await post(server, "/registration/start", { csrf: token, url: site.siteUrl("05-choices") });

    const promptHtml = await pollSites(server, (html) => html.includes("追加情報の入力"));
    assert.match(promptHtml, /ご職業/);

    await post(server, "/registration/provide-data", { csrf: token, value: "会社員" });
    await pollSites(server, (html) => html.includes("確認ゲート"));

    assert.equal(app.store.getValue("custom.job"), "会社員");

    await post(server, "/registration/gate-decision", { csrf: token, decision: "decline" });
    await pollSites(server, (html) => html.includes("ユーザーの判断で中止しました"));
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

test("registration with high-risk terms: 08-terms surfaces auto-renewal/third-party clauses and the adult attestation (guards 1 & 3)", async () => {
  await withRegistrationWebUi(async ({ server, token, site }) => {
    await post(server, "/registration/start", { csrf: token, url: site.siteUrl("08-terms") });

    const gateHtml = await pollSites(server, (html) => html.includes("確認ゲート"));
    assert.match(gateHtml, /テスト商事/);
    // Guard 1: high-risk clauses are surfaced with their human-readable labels and quoted evidence.
    assert.match(gateHtml, /自動更新・自動課金/);
    assert.match(gateHtml, /第三者提供・販売/);
    // Guard 3: the eligibility attestation is presented as an unchecked, user-decided checkbox.
    assert.match(gateHtml, /name="attest_[^"]+"/);
    assert.match(gateHtml, /私は18歳以上です/);

    await post(server, "/registration/gate-decision", { csrf: token, decision: "decline" });

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

type RegistrationState = ReturnType<RegistrationSession["getState"]>;

/** Wait until the session transitions into `kind`, returning the matching state. */
function waitForState(session: RegistrationSession, kind: RegistrationState["kind"]): Promise<RegistrationState> {
  return waitFor(() => {
    const state = session.getState();
    return state.kind === kind ? state : undefined;
  }, `session state "${kind}"`);
}

test("RegistrationSession: a missing-data prompt pauses the run until provideData resolves it", async () => {
  const runner = fakeRunner(async (_page, _url, hooks) => {
    const value = await hooks.promptUser("ご職業");
    assert.equal(value, "会社員");
    return fakeResult("registered");
  });

  const session = new RegistrationSession(runner, FAKE_PAGE, "http://example.test");
  session.start();

  const awaiting = await waitForState(session, "awaiting-data");
  assert.equal((awaiting as { label: string }).label, "ご職業");

  assert.equal(session.provideData("会社員"), true);

  const done = await waitForState(session, "done");
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
  await waitForState(session, "awaiting-gate");

  assert.equal(session.decideGate({ approved: false, attestationApprovals: {}, cardApproved: false }), true);

  const done = await waitForState(session, "done");
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
  const awaiting = await waitForState(resumeSession, "awaiting-handoff");
  assert.deepEqual((awaiting as { wall: typeof wall }).wall, wall);

  assert.equal(resumeSession.resolveHandoff("resolved"), true);
  const resumedDone = await waitForState(resumeSession, "done");
  assert.equal((resumedDone as { result: RegistrationResult }).result.status, "registered");

  const aborted = fakeRunner(async (_page, _url, hooks) => {
    const outcome = await hooks.handoff!(wall, "CAPTCHAが表示されました。解決してから再開してください。");
    return fakeResult(outcome === "resolved" ? "registered" : "manualHandoff");
  });

  const abortSession = new RegistrationSession(aborted, FAKE_PAGE, "http://example.test");
  abortSession.start();
  await waitForState(abortSession, "awaiting-handoff");

  assert.equal(abortSession.resolveHandoff("abort"), true);
  const abortDone = await waitForState(abortSession, "done");
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

  const state = await waitForState(session, "error");
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
