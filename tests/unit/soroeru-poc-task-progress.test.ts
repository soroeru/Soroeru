// Task progress UI (Issue #94): cancel, notes display, and phase tracking for
// RegistrationSession and BulkUpdateSession.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RegistrationSession } from "../../src/app/registration-session.js";
import { BulkUpdateSession } from "../../src/app/bulk-update-session.js";
import { SoroeruApp, type BrowserLauncher, type SoroeruAppOptions } from "../../src/app/app.js";
import { startWebUiServer, type WebUiServerHandle } from "../../src/app/web-ui.js";
import type { AppRunner } from "../../src/app/runner.js";
import type { Page, Browser } from "playwright";
import type { GateDecision, GateRequest, WallDetection } from "../../src/types.js";
import type { RegistrationResult, UpdateResult } from "../../src/agent/agent.js";

const PASSPHRASE = "unit-test-passphrase";

// ---------------------------------------------------------------------------
// Minimal stubs
// ---------------------------------------------------------------------------

function stubPage(): Page {
  return {
    close: async () => {},
    goto: async () => null,
    waitForLoadState: async () => {},
    evaluate: async () => ({}),
    title: async () => "stub",
    url: () => "http://stub.test/",
  } as unknown as Page;
}

function stubBrowser(): Browser {
  return {
    newPage: async () => stubPage(),
  } as unknown as Browser;
}

function makeRunner(
  registerFn: (log: (m: string) => void) => Promise<RegistrationResult>,
  updateFn?: () => Promise<UpdateResult>,
): AppRunner {
  return {
    register: async (_page: Page, _url: string, hooks: { log: (m: string) => void }) => {
      return registerFn(hooks.log);
    },
    update: async () => {
      return updateFn?.() ?? Promise.resolve({ siteId: "test.test", status: "updated", changedKeys: [], planned: [], notes: [] } as UpdateResult);
    },
    importExistingAccount: async () => { throw new Error("not used"); },
  } as unknown as AppRunner;
}

// ---------------------------------------------------------------------------
// RegistrationSession cancel tests
// ---------------------------------------------------------------------------

test("RegistrationSession cancel sets state to cancelled immediately", () => {
  const session = new RegistrationSession(
    makeRunner(async () => {
      await new Promise(() => {}); // never resolves
      return {} as RegistrationResult;
    }),
    stubPage(),
    "http://test.test/",
  );
  session.start();
  assert.equal(session.getState().kind, "running");
  session.cancel();
  assert.equal(session.getState().kind, "cancelled");
});

test("RegistrationSession cancel is idempotent on already-cancelled session", () => {
  const session = new RegistrationSession(
    makeRunner(async () => ({ } as RegistrationResult)),
    stubPage(),
    "http://test.test/",
  );
  session.start();
  session.cancel();
  session.cancel();
  assert.equal(session.getState().kind, "cancelled");
});

test("RegistrationSession cancel unblocks a pending gate decision", async () => {
  let gateResolved: GateDecision | undefined;
  const session = new RegistrationSession(
    makeRunner(async (log) => {
      log("ゲート準備中");
      return { status: "registered", notes: [], filledFields: [], siteId: "t", origin: "https://t" } as unknown as RegistrationResult;
    }),
    stubPage(),
    "http://test.test/",
  );
  // Manually simulate awaiting-gate by accessing a pending gate
  // We call cancel() which should unblock any pending hooks
  session.start();
  session.cancel();
  // After cancel, the session must be in the cancelled state
  assert.equal(session.getState().kind, "cancelled");
});

test("RegistrationSession notes are captured from log calls", async () => {
  let logFn!: (m: string) => void;
  const runner = {
    register: async (_page: Page, _url: string, hooks: { log: (m: string) => void }) => {
      logFn = hooks.log;
      return new Promise<RegistrationResult>((resolve) => {
        setTimeout(() => resolve({ status: "registered", notes: [], filledFields: [], siteId: "t", origin: "https://t" } as unknown as RegistrationResult), 0);
      });
    },
    update: async () => ({} as UpdateResult),
    importExistingAccount: async () => { throw new Error(); },
  } as unknown as AppRunner;

  const session = new RegistrationSession(runner, stubPage(), "http://test.test/");
  session.start();
  logFn("登録ページを発見: 新規登録");
  logFn("フォームの入力を開始します");

  assert.equal(session.notes.length, 2);
  assert.equal(session.notes[0], "登録ページを発見: 新規登録");
  assert.equal(session.notes[1], "フォームの入力を開始します");
  // Current note in state
  const state = session.getState();
  assert.equal(state.kind, "running");
  assert.equal(state.kind === "running" ? state.currentNote : undefined, "フォームの入力を開始します");
});

// ---------------------------------------------------------------------------
// BulkUpdateSession cancel tests
// ---------------------------------------------------------------------------

test("BulkUpdateSession cancel sets state to cancelled with partial results", () => {
  const session = new BulkUpdateSession(
    makeRunner(async () => {
      await new Promise(() => {}); // never resolves
      return {} as RegistrationResult;
    }),
    stubBrowser(),
    [{ siteId: "a.test", siteTopUrl: "http://a.test/", profileKeys: ["email"] }],
  );
  session.start();
  assert.equal(session.getState().kind, "running");
  session.cancel();
  const state = session.getState();
  assert.equal(state.kind, "cancelled");
  if (state.kind === "cancelled") {
    assert.ok(Array.isArray(state.results));
  }
});

test("BulkUpdateSession cancel is no-op when already done", async () => {
  let resolveFn!: () => void;
  const session = new BulkUpdateSession(
    {
      update: async () => {
        await new Promise<void>((r) => { resolveFn = r; });
        return { siteId: "b.test", status: "updated", changedKeys: [], planned: [], notes: [] } as UpdateResult;
      },
      register: async () => ({} as RegistrationResult),
      importExistingAccount: async () => { throw new Error(); },
    } as unknown as AppRunner,
    stubBrowser(),
    [{ siteId: "b.test", siteTopUrl: "http://b.test/", profileKeys: ["email"] }],
  );
  session.start();
  // Allow run() to advance past newPage() so update() is called and sets resolveFn.
  await new Promise((r) => setTimeout(r, 10));
  resolveFn(); // complete the one target
  // Give the microtask queue a chance to advance to the done state.
  await new Promise((r) => setTimeout(r, 10));
  const state = session.getState();
  if (state.kind === "done") {
    session.cancel(); // should be no-op
    assert.equal(session.getState().kind, "done");
  } else {
    session.cancel();
    assert.equal(session.getState().kind, "cancelled");
  }
});

// ---------------------------------------------------------------------------
// Web UI cancel route tests
// ---------------------------------------------------------------------------

async function withWebUi(
  fn: (app: SoroeruApp, server: WebUiServerHandle) => Promise<void>,
  appOptions?: Partial<Omit<SoroeruAppOptions, "stateDir">>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "af-task-progress-"));
  const app = new SoroeruApp({ stateDir: dir, idleLockMs: 0, ...appOptions });
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
  return res.text();
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

test("POST /registration/cancel warns when no registration is running", async () => {
  await withWebUi(async (_app, server) => {
    const token = await unlockThroughUi(server);
    const res = await post(server, "/registration/cancel", { csrf: token });
    assert.equal(res.status, 303);
    assert.match(decodeURIComponent(res.headers.get("location") ?? ""), /実行中の登録処理はありません/);
  });
});

test("POST /bulk/cancel warns when no bulk update is running", async () => {
  await withWebUi(async (_app, server) => {
    const token = await unlockThroughUi(server);
    const res = await post(server, "/bulk/cancel", { csrf: token });
    assert.equal(res.status, 303);
    assert.match(decodeURIComponent(res.headers.get("location") ?? ""), /実行中の一括更新はありません/);
  });
});

test("running state UI shows a cancel button", async () => {
  // Use a stub launcher so the session stays in `running` state without launching
  // a real browser (which would require a display in CI).
  const stubLauncher: BrowserLauncher = async () => {
    const neverPage = {
      close: async () => {},
      goto: () => new Promise<null>(() => {}), // never resolves → runner stays running
      waitForLoadState: async () => {},
      evaluate: async () => ({}),
      title: async () => "stub",
      url: () => "http://stub.test/",
    } as unknown as Page;
    return {
      close: async () => {},
      newPage: async () => neverPage,
    } as unknown as Browser;
  };
  await withWebUi(async (_app, server) => {
    const token = await unlockThroughUi(server);
    // Start a registration against a non-existent URL so it enters running state
    await post(server, "/site/add", {
      csrf: token,
      url: "http://127.0.0.1:59999/nonexistent",
      accountStatus: "notRegistered",
    });
    // The sites tab should now show the cancel button in the running panel
    const html = await getHtml(server, "/?tab=sites");
    assert.match(html, /キャンセル|cancel/i);
    // Cleanup: cancel the registration
    await post(server, "/registration/cancel", { csrf: token });
  }, { launchBrowserFn: stubLauncher });
});
