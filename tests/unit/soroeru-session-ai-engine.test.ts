import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SoroeruSession } from "../../electron/session.js";
import type { AiProvider, CompleteJsonOptions } from "../../src/agent/ai/provider.js";
import type { AiEngine, DecisionKind } from "../../src/automation/decision-engine.js";
import type { PageDriver, SiteSession } from "../../src/automation/page-driver.js";
import type { FormField, PageSnapshot } from "../../src/types.js";

// Fake data only (docs/testing.md). Covers Issue #310's SoroeruSession-level
// wiring:
// - an injected `aiEngine` (the test-only override in `SoroeruSessionOptions`)
//   reaches a real `runVisibility()` call end to end through
//   `VisibilityService` -> `VisibilityRunner` -> `DecisionEngine`, and —
//   unlike the production `.env`-sourced instance — is never rebuilt or
//   cleared across lock/unlock cycles;
// - the production `refreshAiEngine()` path itself (a real `AiEngineImpl`
//   built from a provider and wired through) is exercised offline via
//   `aiProviderFactory` (a test-only override for `aiProviderFromEnv`), so no
//   real network egress is needed to cover it;
// - without any override/configured provider, a run is unchanged (no AI).
const PASSPHRASE = "session-ai-engine-passphrase";

const CSV = [
  "name,url,username,password,note",
  "Example,https://example.test/account,user@example.test,fake-pass,",
].join("\n");

test("an injected aiEngine override reaches a real runVisibility() call and survives a lock/unlock cycle", async () => {
  const dir = await mkdtemp(join(tmpdir(), "soroeru-session-ai-"));
  const path = join(dir, "vault.json");
  try {
    const page = new FakePageDriver(
      [
        snapshot("https://example.test/account", [
          field("email", { autocomplete: "email", labels: ["メールアドレス"] }),
        ]),
      ],
      { email: "user@example.test" },
    );
    const consulted: DecisionKind[] = [];
    const fakeAiEngine: AiEngine = {
      consult: (request) => {
        consulted.push(request.kind);
        return Promise.resolve(null);
      },
    };
    const session = new SoroeruSession(path, {
      openSession: () => Promise.resolve(new FakeSession(page)),
      aiEngine: fakeAiEngine,
    });
    assert.equal((await session.setup(PASSPHRASE)).ok, true);
    const imported = await session.importCsv(CSV);
    const siteId = imported.summary?.siteAccountIds[0];
    assert.ok(siteId, "CSV import must yield a site account id");

    const firstRun = await session.runVisibility(siteId);
    assert.equal(firstRun.status, "collected");
    assert.ok(consulted.length > 0, "the injected aiEngine must be consulted during a real run");

    // Unlike the production per-unlock rebuild, a test-injected override must
    // not be cleared on lock() or replaced on the next unlock().
    consulted.length = 0;
    assert.equal(session.lock().ok, true);
    assert.equal((await session.unlock(PASSPHRASE)).ok, true);
    const secondRun = await session.runVisibility(siteId);
    assert.equal(secondRun.status, "collected");
    assert.ok(
      consulted.length > 0,
      "the same injected aiEngine override must still be wired in after a lock/unlock cycle",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("aiProviderFactory builds a real AiEngineImpl and wires it through a real run, offline", async () => {
  const dir = await mkdtemp(join(tmpdir(), "soroeru-session-ai-"));
  const path = join(dir, "vault.json");
  try {
    const page = new FakePageDriver(
      [
        snapshot("https://example.test/account", [
          field("email", { autocomplete: "email", labels: ["メールアドレス"] }),
        ]),
      ],
      { email: "user@example.test" },
    );
    // No links on the page: find-profile-links can't confidently rule-match,
    // so DecisionEngine actually consults the AiEngine built from this provider.
    const provider = new StubProvider({ links: [], continue: false, confidence: 0.5 });
    const session = new SoroeruSession(path, {
      openSession: () => Promise.resolve(new FakeSession(page)),
      aiProviderFactory: () => provider,
    });
    assert.equal((await session.setup(PASSPHRASE)).ok, true);
    const imported = await session.importCsv(CSV);
    const siteId = imported.summary?.siteAccountIds[0];
    assert.ok(siteId, "CSV import must yield a site account id");

    const run = await session.runVisibility(siteId);

    assert.equal(run.status, "collected");
    assert.ok(
      provider.calls.length > 0,
      "the real AiEngineImpl built from aiProviderFactory must actually call the provider during a real run",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("without an injected override and without a configured provider, a run behaves exactly as before (no AI)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "soroeru-session-ai-"));
  const path = join(dir, "vault.json");
  const savedOpenAiKey = process.env["OPENAI_API_KEY"];
  const savedAnthropicKey = process.env["ANTHROPIC_API_KEY"];
  delete process.env["OPENAI_API_KEY"];
  delete process.env["ANTHROPIC_API_KEY"];
  try {
    const page = new FakePageDriver(
      [
        snapshot("https://example.test/account", [
          field("email", { autocomplete: "email", labels: ["メールアドレス"] }),
        ]),
      ],
      { email: "user@example.test" },
    );
    const session = new SoroeruSession(path, { openSession: () => Promise.resolve(new FakeSession(page)) });
    assert.equal((await session.setup(PASSPHRASE)).ok, true);
    const imported = await session.importCsv(CSV);
    const siteId = imported.summary?.siteAccountIds[0];
    assert.ok(siteId, "CSV import must yield a site account id");

    const run = await session.runVisibility(siteId);
    assert.equal(run.status, "collected");
  } finally {
    if (savedOpenAiKey !== undefined) process.env["OPENAI_API_KEY"] = savedOpenAiKey;
    if (savedAnthropicKey !== undefined) process.env["ANTHROPIC_API_KEY"] = savedAnthropicKey;
    await rm(dir, { recursive: true, force: true });
  }
});

/** A minimal AiProvider fake: records every prompt and always returns the same canned response. */
class StubProvider implements AiProvider {
  readonly id = "stub:test";
  readonly calls: CompleteJsonOptions[] = [];
  constructor(private readonly response: unknown) {}
  completeJson(options: CompleteJsonOptions): Promise<unknown> {
    this.calls.push(options);
    return Promise.resolve(this.response);
  }
}

class FakeSession implements SiteSession {
  constructor(readonly page: FakePageDriver) {}
  async close(): Promise<void> {
    this.page.closed = true;
  }
}

class FakePageDriver implements PageDriver {
  closed = false;
  private index = 0;
  constructor(
    private readonly snapshots: PageSnapshot[],
    private readonly values: Record<string, string> = {},
  ) {}
  async goto(): Promise<void> {}
  async waitForReady(): Promise<void> {}
  currentUrl(): string {
    return this.snapshots[Math.min(this.index, this.snapshots.length - 1)]?.url ?? "";
  }
  async snapshot(): Promise<PageSnapshot> {
    const snap = this.snapshots[Math.min(this.index, this.snapshots.length - 1)];
    this.index++;
    if (!snap) throw new Error("no snapshot");
    return snap;
  }
  async readValues(): Promise<Record<string, string>> {
    return this.values;
  }
  async fillField(): Promise<void> {}
  async click(): Promise<void> {}
}

function snapshot(url: string, fields: FormField[], visibleText = ""): PageSnapshot {
  return {
    url,
    title: "Test",
    fields,
    buttons: [{ selector: "button[type=submit]", text: "ログイン" }],
    links: [],
    visibleText,
    iframeSrcs: [],
    wallMarkers: [],
  };
}

function field(fieldId: string, overrides: Partial<FormField>): FormField {
  return {
    fieldId,
    tag: "input",
    type: "text",
    name: "",
    id: fieldId,
    autocomplete: "",
    required: false,
    placeholder: "",
    labels: [],
    nearbyText: "",
    ...overrides,
  };
}
