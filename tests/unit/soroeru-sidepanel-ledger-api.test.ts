import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPanelSoroeruApi, type PanelVisibilityHost } from "../../extension/panel/panel-api.js";
import { createFrameSavedPageRenderer } from "../../extension/panel/saved-page-frame-renderer.js";
import { SAVED_PAGE_FRAME_MESSAGES } from "../../extension/saved-page-frame-protocol.js";
import type { VisibilityRunResultView, VisibilityStatusView } from "../../electron/ipc/contract.js";
import type { RenderedSavedPage, SavedPageRenderer } from "../../src/automation/saved-page-core.js";
import { DomainService } from "../../src/domain/domain-service.js";
import type { SiteAccount } from "../../src/domain/entities.js";
import { MemoryLogger } from "../../src/logging/memory-logger.js";
import { FileVaultPersistence } from "../../src/store/file-vault-persistence.js";
import { VaultSession } from "../../src/store/vault-session.js";

const PASSPHRASE = "fake-sidepanel-passphrase-long";
const CSV = [
  "name,url,username,password,note",
  "Example Shop,https://shop.example.test/login,fake-user@example.test,fake-password-1,",
  "Example News,https://news.example.test/,fake-reader,fake-password-2,",
].join("\n");

const EMPTY_PAGE: RenderedSavedPage = {
  snapshot: {
    url: "about:blank",
    title: "saved",
    fields: [],
    buttons: [],
    links: [],
    visibleText: "",
    iframeSrcs: [],
    wallMarkers: [],
    displayValues: [],
  },
  values: {},
  displayValues: {},
};

async function unlockedSession(t: test.TestContext): Promise<VaultSession> {
  const dir = await mkdtemp(join(tmpdir(), "sidepanel-ledger-"));
  const session = new VaultSession({
    persistence: new FileVaultPersistence(join(dir, "vault.json")),
    kdfAlgo: "pbkdf2-sha512",
    lockManager: { tryAcquire: async () => ({ release() {} }) },
  });
  await session.start();
  await session.create(PASSPHRASE);
  t.after(async () => {
    session.close();
    await rm(dir, { recursive: true, force: true });
  });
  return session;
}

class FakeHost implements PanelVisibilityHost {
  running = false;
  readonly runs: string[] = [];
  aborted = 0;
  constructor(private readonly session: VaultSession) {}
  readonly service = {
    status: (): VisibilityStatusView => ({ running: this.running, awaitingHandoff: false }),
  };
  listSites(): SiteAccount[] {
    return this.session.state === "unlocked"
      ? new DomainService(this.session.vault).listSiteAccountsInManualOrder()
      : [];
  }
  async run(site: SiteAccount): Promise<VisibilityRunResultView> {
    this.runs.push(site.id);
    return { siteAccountId: site.id, status: "collected", disclosures: 2, relationships: 0, constraints: 0 };
  }
  resume(): boolean {
    return false;
  }
  abort(): void {
    this.aborted++;
  }
  onEvent(): () => void {
    return () => undefined;
  }
}

function panelApi(
  session: VaultSession,
  overrides: {
    renderer?: SavedPageRenderer;
    requestOrigins?: (origins: string[]) => Promise<boolean>;
    openTab?: (url: string) => Promise<void>;
  } = {},
) {
  const host = new FakeHost(session);
  const logger = new MemoryLogger();
  const api = createPanelSoroeruApi({
    session,
    host,
    logger,
    savedPageRenderer: overrides.renderer ?? (async () => EMPTY_PAGE),
    originsForSite: (site) => [`https://${site.domain}/*`],
    requestOrigins: overrides.requestOrigins ?? (async () => true),
    openTab: overrides.openTab ?? (async () => undefined),
    now: () => new Date("2026-10-14T00:00:00.000Z"),
  });
  return { api, host, logger };
}

test("the panel API imports a CSV into the panel vault and exposes masked ledger rows only", async (t) => {
  const session = await unlockedSession(t);
  const { api } = panelApi(session);

  const result = await api.csv.import(new TextEncoder().encode(CSV));
  assert.equal(result.ok, true);
  assert.equal(result.summary?.importedCredentials, 2);

  const rows = await api.ledger.siteDetails();
  assert.deepEqual(rows.map((row) => row.domain).sort(), ["news.example.test", "shop.example.test"]);
  const serialized = JSON.stringify(rows);
  assert.doesNotMatch(serialized, /fake-password-1|fake-password-2/);
  // The import is persisted, so a fresh domain view over the same vault sees it.
  assert.equal(new DomainService(session.vault).listSiteAccounts().length, 2);
});

test("the panel API reports locked and empty views while the vault is locked", async (t) => {
  const session = await unlockedSession(t);
  const { api } = panelApi(session);
  session.lock();

  assert.deepEqual(await api.csv.import(CSV), { ok: false, error: "locked" });
  assert.deepEqual(await api.ledger.sites(), []);
  assert.equal((await api.vault.status()).locked, true);
  assert.equal((await api.visibility.run("site-1")).status, "locked");
});

test("reveal requires re-entering the vault passphrase in the panel too", async (t) => {
  const session = await unlockedSession(t);
  const { api } = panelApi(session);
  await api.csv.import(CSV);
  const domain = new DomainService(session.vault);
  const site = domain.listSiteAccounts()[0]!;
  const disclosure = domain.addDisclosure({
    siteAccountId: site.id,
    attributeKey: "card.number",
    siteHeldValue: "4111111111111111",
    sourceKind: "manual-import",
    observedAt: 1,
  });

  assert.deepEqual(await api.ledger.reveal(disclosure.id, "wrong-passphrase-value"), {
    ok: false,
    error: "reauth-failed",
  });
  // The vault keeps only what the domain stores for a card (its last digits); reveal returns exactly that.
  const stored = domain.getDisclosure(disclosure.id)?.siteHeldValue;
  assert.ok(stored);
  assert.deepEqual(await api.ledger.reveal(disclosure.id, PASSPHRASE), { ok: true, value: stored });
});

test("prepare asks once for every queued site's origins and stops the batch when declined", async (t) => {
  const session = await unlockedSession(t);
  const requests: string[][] = [];
  let grant = true;
  const { api, host } = panelApi(session, {
    requestOrigins: async (origins) => {
      requests.push([...origins].sort());
      return grant;
    },
  });
  await api.csv.import(CSV);
  const ids = host.listSites().map((site) => site.id);

  assert.equal(await api.visibility.prepare?.(ids), true);
  assert.deepEqual(requests, [["https://news.example.test/*", "https://shop.example.test/*"]]);

  grant = false;
  assert.equal(await api.visibility.prepare?.(ids), false);

  const result = await api.visibility.run(ids[0]!);
  assert.equal(result.status, "collected");
  assert.deepEqual(host.runs, [ids[0]]);
  assert.equal((await api.visibility.run("missing-site")).status, "skipped");
});

test("a saved-page import holds the collection lock and never runs while a Visibility run is active", async (t) => {
  const session = await unlockedSession(t);
  let release!: () => void;
  const rendered: string[] = [];
  const { api, host } = panelApi(session, {
    renderer: async (html) => {
      rendered.push(html);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return EMPTY_PAGE;
    },
  });
  await api.csv.import(CSV);
  const site = host.listSites()[0]!;
  const html =
    "<!-- saved from url=(0035)https://shop.example.test/account -->\n<html><body>fake</body></html>";
  const data = new TextEncoder().encode(html);

  const importing = api.savedPage.import({ siteAccountId: site.id, fileName: "account.html", data });
  while (rendered.length === 0) await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await api.visibility.run(site.id)).status, "busy");
  release();
  const result = await importing;

  assert.equal(result.ok, true);
  assert.equal(result.summary?.sourceUrl, "https://shop.example.test/account");
  assert.equal(result.summary?.sourceHashPreview.length, 16);
  assert.equal(rendered[0], html);

  host.running = true;
  assert.deepEqual(await api.savedPage.import({ siteAccountId: site.id, fileName: "account.html", data }), {
    ok: false,
    error: "busy",
  });
});

test("a saved-page render failure is reported without a partial import", async (t) => {
  const session = await unlockedSession(t);
  const { api, host } = panelApi(session, {
    renderer: async () => {
      throw new Error("saved-page-render-timeout");
    },
  });
  await api.csv.import(CSV);
  const site = host.listSites()[0]!;
  const evidenceBefore = session.vault.list("evidence").length;

  const result = await api.savedPage.import({
    siteAccountId: site.id,
    fileName: "account.html",
    data: new TextEncoder().encode("<html></html>"),
  });

  assert.deepEqual(result, { ok: false, error: "import-failed" });
  assert.equal(session.vault.list("evidence").length, evidenceBefore);
});

test("opening a site uses the target-site URL only after an explicit call", async (t) => {
  const session = await unlockedSession(t);
  const opened: string[] = [];
  const { api, host } = panelApi(session, {
    openTab: async (url) => {
      opened.push(url);
    },
  });
  await api.csv.import(CSV);
  const shop = host.listSites().find((site) => site.domain === "shop.example.test")!;

  assert.deepEqual(opened, []);
  const result = await api.savedPage.openSite(shop.id);
  assert.equal(result.ok, true);
  assert.deepEqual(opened, ["https://shop.example.test/login"]);
  assert.deepEqual(await api.savedPage.openSite("missing-site"), { ok: false, error: "not-found" });
});

test("the exported panel log carries counts and redacts value-shaped text", async (t) => {
  const session = await unlockedSession(t);
  const { api, logger } = panelApi(session);
  await api.csv.import(CSV);
  logger.warn("test", "contact fake-user@example.test failed", { note: "card 4111 1111 1111 1111" });

  const exported = await api.logs.export();
  assert.equal(exported.ok, true);
  assert.equal(exported.fileName, "soroeru-log-2026-10-14T00-00-00-000Z.log");
  const lines = (exported.content ?? "")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(lines[0]?.["category"], "csv-import");
  assert.equal(lines[0]?.["importedCredentials"], 2);
  assert.doesNotMatch(exported.content ?? "", /fake-user@example\.test|4111 1111|fake-password/);
});

test("the memory logger keeps only the newest lines", () => {
  const logger = new MemoryLogger(2);
  logger.info("a", "first");
  logger.info("b", "second");
  logger.info("c", "third");
  assert.deepEqual(
    logger
      .read()
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { category: string }).category),
    ["b", "c"],
  );
});

// --- Frame renderer protocol (no DOM in Node: a minimal fake frame) ---

class FakeFrame {
  removed = false;
  src = "";
  tabIndex = 0;
  readonly style = { cssText: "" };
  readonly posted: unknown[] = [];
  readonly contentWindow = { postMessage: (message: unknown) => this.posted.push(message) };
  setAttribute(): void {}
  remove(): void {
    this.removed = true;
  }
}

function fakeEnvironment(timeoutMs = 1000) {
  const frames: FakeFrame[] = [];
  const listeners = new Set<(event: MessageEvent<unknown>) => void>();
  const env = {
    document: {
      createElement: () => {
        const frame = new FakeFrame();
        frames.push(frame);
        return frame;
      },
      body: { append: () => undefined },
    } as unknown as Document,
    window: {
      addEventListener: (_type: string, listener: (event: MessageEvent<unknown>) => void) =>
        listeners.add(listener),
      removeEventListener: (_type: string, listener: (event: MessageEvent<unknown>) => void) =>
        listeners.delete(listener),
    } as unknown as Pick<Window, "addEventListener" | "removeEventListener">,
    origin: "chrome-extension://fakeid",
    frameUrl: "chrome-extension://fakeid/saved-page-frame.html",
    createNonce: () => "nonce-1",
    timeoutMs,
  };
  const deliver = (source: unknown, origin: string, data: unknown): void => {
    for (const listener of [...listeners]) listener({ source, origin, data } as MessageEvent<unknown>);
  };
  return { env, frames, listeners, deliver };
}

test("the frame renderer answers only its own frame and nonce, then removes the frame", async () => {
  const { env, frames, listeners, deliver } = fakeEnvironment();
  const rendering = createFrameSavedPageRenderer(env)("<html>fake</html>");
  const frame = frames[0]!;
  assert.equal(frame.src, env.frameUrl);

  deliver({}, env.origin, { type: SAVED_PAGE_FRAME_MESSAGES.ready });
  assert.deepEqual(frame.posted, []);
  deliver(frame.contentWindow, "https://evil.example.test", { type: SAVED_PAGE_FRAME_MESSAGES.ready });
  assert.deepEqual(frame.posted, []);

  deliver(frame.contentWindow, env.origin, { type: SAVED_PAGE_FRAME_MESSAGES.ready });
  assert.deepEqual(frame.posted, [
    { type: SAVED_PAGE_FRAME_MESSAGES.render, nonce: "nonce-1", html: "<html>fake</html>" },
  ]);
  deliver(frame.contentWindow, env.origin, {
    type: SAVED_PAGE_FRAME_MESSAGES.rendered,
    nonce: "other",
    result: EMPTY_PAGE,
  });
  assert.equal(frame.removed, false);

  deliver(frame.contentWindow, env.origin, {
    type: SAVED_PAGE_FRAME_MESSAGES.rendered,
    nonce: "nonce-1",
    result: EMPTY_PAGE,
  });
  assert.deepEqual(await rendering, EMPTY_PAGE);
  assert.equal(frame.removed, true);
  assert.equal(listeners.size, 0);
});

test("the frame renderer rejects malformed results and timeouts", async () => {
  const malformed = fakeEnvironment();
  const rendering = createFrameSavedPageRenderer(malformed.env)("<html></html>");
  const frame = malformed.frames[0]!;
  malformed.deliver(frame.contentWindow, malformed.env.origin, {
    type: SAVED_PAGE_FRAME_MESSAGES.rendered,
    nonce: "nonce-1",
    result: { snapshot: { fields: [] }, values: { f1: 42 }, displayValues: {} },
  });
  await assert.rejects(rendering, /saved-page-render-failed/);
  assert.equal(frame.removed, true);

  const silent = fakeEnvironment(10);
  await assert.rejects(
    createFrameSavedPageRenderer(silent.env)("<html></html>"),
    /saved-page-render-timeout/,
  );
  assert.equal(silent.frames[0]?.removed, true);
  assert.equal(silent.listeners.size, 0);
});
