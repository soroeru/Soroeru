import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DomainService } from "../../src/domain/domain-service.js";
import type { SiteAccount } from "../../src/domain/entities.js";
import { VaultV2 } from "../../src/store/vault-v2.js";
import type { FormField, PageSnapshot } from "../../src/types.js";
import type { AiEngine, DecisionKind } from "../../src/automation/decision-engine.js";
import type { PageDriver, SiteSession } from "../../src/automation/page-driver.js";
import { VisibilityRunner } from "../../src/automation/visibility-runner.js";
import type { LogFields, Logger } from "../../src/logging/logger.js";
import { parseLogEntries, siteOutcomes } from "../../src/logging/collection-log-analysis.js";

const PASSPHRASE = "unit-test-passphrase";

async function openService(): Promise<{ dir: string; service: DomainService }> {
  const dir = await mkdtemp(join(tmpdir(), "soroeru-visibility-"));
  const vault = await VaultV2.open(join(dir, "vault.json"), PASSPHRASE);
  return { dir, service: new DomainService(vault) };
}

interface RecordedLogEntry {
  level: "info" | "warn" | "error";
  category: string;
  message: string;
  fields?: LogFields;
}

/** In-memory `Logger` spy (Issue #314) so tests can assert on failure-reason logging without touching disk. */
function recordingLogger(): { logger: Logger; entries: RecordedLogEntry[] } {
  const entries: RecordedLogEntry[] = [];
  const record =
    (level: RecordedLogEntry["level"]) =>
    (category: string, message: string, fields?: LogFields): void => {
      entries.push({ level, category, message, ...(fields ? { fields } : {}) });
    };
  return {
    entries,
    logger: { info: record("info"), warn: record("warn"), error: record("error") },
  };
}

test("visibility runner logs in, collects redacted evidence, disclosures, relationships, and checkpoints", async () => {
  const { dir, service } = await openService();
  try {
    const site = service.upsertSiteAccount({
      domain: "example.test",
      url: "https://example.test/login",
      displayName: "Example",
    });
    service.addCredential({
      siteAccountId: site.id,
      username: "user@example.test",
      password: "fake-pass",
      source: "csv-import",
    });
    service.setPersonalAttribute({
      attributeKey: "email",
      label: "メール",
      value: "new@example.test",
      valueType: "email",
    });

    const page = new FakePageDriver(
      [
        snapshot("https://example.test/login", [
          field("login-email", { type: "email", autocomplete: "username", labels: ["メールアドレス"] }),
          field("login-password", {
            type: "password",
            autocomplete: "current-password",
            labels: ["パスワード"],
          }),
        ]),
        snapshot(
          "https://example.test/account",
          [
            field("profile-email", { type: "email", autocomplete: "email", labels: ["メールアドレス"] }),
            field("profile-phone", { autocomplete: "tel", labels: ["電話番号"] }),
          ],
          "メールマガジンを購読中です。継続課金があります。",
        ),
      ],
      {
        "profile-email": "old@example.test",
        "profile-phone": "090-1234-5678",
      },
    );

    const runner = new VisibilityRunner({
      domain: service,
      openSession: () => Promise.resolve(new FakeSession(page)),
      now: () => 1_700_000_000_000,
    });

    const result = await runner.runSite(site.id);

    assert.equal(result.status, "collected");
    assert.equal(result.disclosures, 2);
    assert.equal(page.filled["login-email"], "user@example.test");
    assert.equal(page.filled["login-password"], "fake-pass");
    assert.deepEqual(page.clicked, ["button[type=submit]"]);

    const disclosures = service.listDisclosuresForSite(site.id);
    assert.equal(disclosures.length, 2);
    assert.equal(disclosures.find((d) => d.attributeKey === "email")?.staleState, "stale");
    assert.equal(disclosures.find((d) => d.attributeKey === "phone.full")?.staleState, "unknown");
    assert.equal(disclosures.find((d) => d.attributeKey === "email")?.siteHeldValue, "old@example.test");
    assert.equal(disclosures.find((d) => d.attributeKey === "phone.full")?.siteHeldValue, "090-1234-5678");
    assert.ok(disclosures.every((d) => d.normalizedValueHash));

    const evidence = service.listEvidence();
    assert.equal(evidence.length, 2);
    assert.ok(
      evidence.every((item) => item.maskedSnippet && !item.maskedSnippet.includes("old@example.test")),
    );
    assert.ok(evidence.every((item) => item.normalizedHash));

    assert.equal(service.listAccountRelationshipsForSite(site.id).length, 2);
    assert.equal(service.getCheckpoint("visibility", site.id)?.status, "done");
    assert.equal(page.closed, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("visibility runner consults the optional AiEngine when the RuleEngine cannot confidently decide (Issue #310 wiring)", async () => {
  const { dir, service } = await openService();
  try {
    const site = service.upsertSiteAccount({
      domain: "ai-wiring.example.test",
      url: "https://ai-wiring.example.test/account",
      displayName: "AI Wiring",
    });
    // No credential: the runner skips login and goes straight to exploration,
    // whose DecisionEngine.decide calls are the only ones VisibilityRunner
    // actually wires an AiEngine into today (login-page/form/result still use
    // the plain login-handler.ts heuristics directly, not DecisionEngine).
    const page = new FakePageDriver(
      [
        snapshot("https://ai-wiring.example.test/account", [
          field("acct-email", { type: "email", autocomplete: "email", labels: ["メールアドレス"] }),
        ]),
      ],
      { "acct-email": "user@example.test" },
    );

    const consulted: DecisionKind[] = [];
    const fakeAiEngine: AiEngine = {
      consult: (request) => {
        consulted.push(request.kind);
        return Promise.resolve(null); // let the safe default apply; only presence-of-consult is under test
      },
    };

    const runner = new VisibilityRunner({
      domain: service,
      openSession: () => Promise.resolve(new FakeSession(page)),
      aiEngine: fakeAiEngine,
      now: () => 1_700_000_000_000,
    });

    const result = await runner.runSite(site.id);

    assert.equal(result.status, "collected");
    assert.ok(
      consulted.includes("find-profile-links"),
      `expected an AiEngine consultation for find-profile-links; got ${JSON.stringify(consulted)}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("visibility runner explores multiple pages after login and collects disclosures from each page", async () => {
  const { dir, service } = await openService();
  try {
    const site = service.upsertSiteAccount({
      domain: "multi.example.test",
      url: "https://multi.example.test/login",
      displayName: "Multi",
    });
    service.addCredential({
      siteAccountId: site.id,
      username: "user@example.test",
      password: "fake-pass",
      source: "csv-import",
    });
    service.setPersonalAttribute({
      attributeKey: "email",
      label: "メール",
      value: "new@example.test",
      valueType: "email",
    });

    const page = new FakePageDriver(
      [
        snapshot("https://multi.example.test/login", [
          field("login-email", { type: "email", autocomplete: "username", labels: ["メールアドレス"] }),
          field("login-password", {
            type: "password",
            autocomplete: "current-password",
            labels: ["パスワード"],
          }),
        ]),
        {
          ...snapshot("https://multi.example.test/account", [
            field("profile-email", { type: "email", autocomplete: "email", labels: ["メールアドレス"] }),
          ]),
          links: [{ href: "https://multi.example.test/profile", text: "プロフィール" }],
        },
        snapshot("https://multi.example.test/profile", [
          field("profile-email-2", { type: "email", autocomplete: "email", labels: ["メールアドレス"] }),
        ]),
      ],
      {
        "profile-email": "old@example.test",
        "profile-email-2": "second@example.test",
      },
    );

    const runner = new VisibilityRunner({
      domain: service,
      openSession: () => Promise.resolve(new FakeSession(page)),
      now: () => 1_700_000_000_000,
    });

    const result = await runner.runSite(site.id);

    assert.equal(result.status, "collected");
    assert.equal(result.disclosures, 2);
    const disclosures = service.listDisclosuresForSite(site.id);
    assert.equal(disclosures.length, 2);
    assert.equal(disclosures.find((d) => d.attributeKey === "email")?.siteHeldValue, "old@example.test");
    assert.equal(disclosures.filter((d) => d.attributeKey === "email").length, 2);
    assert.equal(service.getCheckpoint("visibility", site.id)?.status, "done");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("visibility runner resumes when a wall is detected during page exploration", async () => {
  const { dir, service } = await openService();
  try {
    const site = service.upsertSiteAccount({
      domain: "wall-later.example.test",
      url: "https://wall-later.example.test/login",
      displayName: "Wall Later",
    });
    service.addCredential({
      siteAccountId: site.id,
      username: "user@example.test",
      password: "fake-pass",
      source: "csv-import",
    });

    const walledProfile = snapshot("https://wall-later.example.test/profile", [], "captcha required");
    walledProfile.wallMarkers = ["recaptcha"];
    const page = new FakePageDriver(
      [
        snapshot("https://wall-later.example.test/login", [
          field("login-email", { type: "email", autocomplete: "username", labels: ["メールアドレス"] }),
          field("login-password", {
            type: "password",
            autocomplete: "current-password",
            labels: ["パスワード"],
          }),
        ]),
        {
          ...snapshot("https://wall-later.example.test/account", [], "概要"),
          links: [{ href: "https://wall-later.example.test/profile", text: "プロフィール" }],
        },
        walledProfile,
        snapshot("https://wall-later.example.test/profile", [
          field("profile-email", { type: "email", autocomplete: "email", labels: ["メールアドレス"] }),
        ]),
      ],
      {
        "profile-email": "user@example.test",
      },
    );
    let handoffs = 0;

    const runner = new VisibilityRunner({
      domain: service,
      openSession: () => Promise.resolve(new FakeSession(page)),
      handoff: async () => {
        handoffs++;
        return "resolved";
      },
    });

    const result = await runner.runSite(site.id);

    assert.equal(result.status, "collected");
    assert.equal(result.disclosures, 1);
    assert.equal(handoffs, 1);
    assert.equal(service.listConstraints().filter((constraint) => constraint.kind === "wall").length, 1);
    assert.equal(service.getCheckpoint("visibility", site.id)?.status, "done");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("visibility runner records a wall constraint and resumes after human handoff", async () => {
  const { dir, service } = await openService();
  try {
    const site = service.upsertSiteAccount({
      domain: "mfa.example.test",
      url: "https://mfa.example.test/login",
      displayName: "MFA",
    });
    service.addCredential({
      siteAccountId: site.id,
      username: "user",
      password: "fake-pass",
      source: "csv-import",
    });

    const page = new FakePageDriver(
      [
        snapshot("https://mfa.example.test/login", [
          field("email", { autocomplete: "username", labels: ["ログインID"] }),
          field("password", { type: "password", autocomplete: "current-password", labels: ["パスワード"] }),
        ]),
        snapshot("https://mfa.example.test/otp", [
          field("otp", { autocomplete: "one-time-code", labels: ["認証コード"] }),
        ]),
        snapshot("https://mfa.example.test/email-check", [], "確認メールを送信しました"),
        snapshot("https://mfa.example.test/account", [
          field("email-current", { autocomplete: "email", labels: ["メールアドレス"] }),
        ]),
      ],
      {
        "email-current": "user@example.test",
      },
    );
    let handoffs = 0;

    const runner = new VisibilityRunner({
      domain: service,
      openSession: () => Promise.resolve(new FakeSession(page)),
      handoff: async () => {
        handoffs++;
        return "resolved";
      },
    });

    const result = await runner.runSite(site.id);

    assert.equal(result.status, "collected");
    assert.equal(handoffs, 2);
    assert.equal(service.listConstraints().filter((constraint) => constraint.kind === "wall").length, 2);
    assert.equal(service.listDisclosuresForSite(site.id).length, 1);
    assert.equal(service.getCheckpoint("visibility", site.id)?.status, "done");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("visibility runner reports the actual wall constraint count when handoff cannot clear chained walls", async () => {
  const { dir, service } = await openService();
  try {
    const site = service.upsertSiteAccount({
      domain: "blocked.example.test",
      url: "https://blocked.example.test/login",
      displayName: "Blocked",
    });
    const page = new FakePageDriver([
      snapshot("https://blocked.example.test/captcha", [], "私はロボットではありません"),
      snapshot("https://blocked.example.test/otp", [
        field("otp", { autocomplete: "one-time-code", labels: ["認証コード"] }),
      ]),
    ]);
    const runner = new VisibilityRunner({
      domain: service,
      openSession: () => Promise.resolve(new FakeSession(page)),
      handoff: async () => "resolved",
      maxHandoffs: 1,
    });

    const result = await runner.runSite(site.id);

    assert.equal(result.status, "handoff");
    assert.equal(result.constraints, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("visibility runner surfaces automation-prohibiting terms as a constraint", async () => {
  const { dir, service } = await openService();
  try {
    const site = service.upsertSiteAccount({
      domain: "tos.example.test",
      url: "https://tos.example.test/account",
      displayName: "ToS",
    });
    const page = new FakePageDriver(
      [
        snapshot(
          "https://tos.example.test/account",
          [field("email", { autocomplete: "email", labels: ["メールアドレス"] })],
          "No automated access is prohibited. newsletter",
        ),
      ],
      {
        email: "user@example.test",
      },
    );

    const runner = new VisibilityRunner({
      domain: service,
      openSession: () => Promise.resolve(new FakeSession(page)),
    });

    const result = await runner.runSite(site.id);

    assert.equal(result.status, "collected");
    assert.equal(service.listConstraints()[0]?.kind, "tos-automation-prohibition");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("visibility runner records failed checkpoint when opening the browser session fails", async () => {
  const { dir, service } = await openService();
  try {
    const site = service.upsertSiteAccount({
      domain: "launch-fail.example.test",
      url: "https://launch-fail.example.test/login",
      displayName: "Launch Fail",
    });
    const runner = new VisibilityRunner({
      domain: service,
      openSession: async () => {
        throw new Error("browser launch failed");
      },
    });

    const result = await runner.runSite(site.id);

    assert.equal(result.status, "failed");
    assert.equal(service.getCheckpoint("visibility", site.id)?.status, "failed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("visibility runner does not click arbitrary buttons when credentials exist but no login fields are present", async () => {
  const { dir, service } = await openService();
  try {
    const site = service.upsertSiteAccount({
      domain: "already-in.example.test",
      url: "https://already-in.example.test/account",
      displayName: "Already In",
    });
    service.addCredential({
      siteAccountId: site.id,
      username: "user",
      password: "fake-pass",
      source: "csv-import",
    });
    const page = new FakePageDriver(
      [
        {
          ...snapshot("https://already-in.example.test/account", [
            field("email-current", { autocomplete: "email", labels: ["メールアドレス"] }),
          ]),
          buttons: [{ selector: "button.delete", text: "削除" }],
        },
      ],
      {
        "email-current": "user@example.test",
      },
    );
    const runner = new VisibilityRunner({
      domain: service,
      openSession: () => Promise.resolve(new FakeSession(page)),
    });

    const result = await runner.runSite(site.id);

    assert.equal(result.status, "collected");
    assert.deepEqual(page.clicked, []);
    assert.equal(service.listDisclosuresForSite(site.id).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("visibility runner reuses an authenticated session without navigating to login or sending credentials", async () => {
  const { dir, service } = await openService();
  try {
    const site = service.upsertSiteAccount({
      domain: "authenticated.example.test",
      url: "https://authenticated.example.test/account",
      displayName: "Authenticated",
    });
    service.addCredential({
      siteAccountId: site.id,
      username: "user@example.test",
      password: "fake-pass",
      source: "csv-import",
    });
    const authenticated = {
      ...snapshot("https://authenticated.example.test/account", [], "", [
        { valueId: "profile-email", labelText: "メールアドレス", nearbyText: "" },
      ]),
      links: [
        { href: "https://authenticated.example.test/logout", text: "ログアウト" },
        { href: "https://authenticated.example.test/mypage", text: "マイページ" },
      ],
    };
    const loginTrap = snapshot("https://authenticated.example.test/login", [
      field("login-email", { type: "email", autocomplete: "username", labels: ["メールアドレス"] }),
      field("login-password", {
        type: "password",
        autocomplete: "current-password",
        labels: ["パスワード"],
      }),
    ]);
    const page = new FakePageDriver([authenticated, loginTrap], {}, { "profile-email": "user@example.test" });
    const { logger, entries } = recordingLogger();
    const runner = new VisibilityRunner({
      domain: service,
      openSession: () => Promise.resolve(new FakeSession(page)),
      logger,
    });

    const result = await runner.runSite(site.id);

    assert.equal(result.status, "collected");
    assert.equal(page.visited.includes("https://authenticated.example.test/login"), false);
    assert.deepEqual(page.filled, {});
    assert.deepEqual(page.clicked, []);
    assert.equal(service.listDisclosuresForSite(site.id).length, 1);
    const reuseLog = entries.find((entry) => entry.message === "reusing authenticated browser session");
    assert.deepEqual(reuseLog?.fields, {
      domain: "authenticated.example.test",
      reason: "visible-logout-control",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

for (const identityCase of [
  {
    name: "missing",
    fields: [] as FormField[],
    values: {},
  },
  {
    name: "mismatched",
    fields: [field("profile-email", { autocomplete: "email", labels: ["メールアドレス"] })],
    values: { "profile-email": "other-user@example.test" },
  },
  {
    name: "ambiguous",
    fields: [
      field("primary-email", { autocomplete: "email", labels: ["メールアドレス"] }),
      field("secondary-email", { autocomplete: "email", labels: ["予備メールアドレス"] }),
    ],
    values: {
      "primary-email": "user@example.test",
      "secondary-email": "other-user@example.test",
    },
  },
] as const) {
  test(`visibility runner falls back to login when the authenticated-session identity is ${identityCase.name}`, async () => {
    const { dir, service } = await openService();
    try {
      const site = service.upsertSiteAccount({
        domain: `${identityCase.name}.example.test`,
        url: `https://${identityCase.name}.example.test/account`,
        displayName: identityCase.name,
      });
      service.addCredential({
        siteAccountId: site.id,
        username: "user@example.test",
        password: "fake-pass",
        source: "csv-import",
      });
      const initial = {
        ...snapshot(`https://${identityCase.name}.example.test/account`, [...identityCase.fields]),
        links: [
          { href: `https://${identityCase.name}.example.test/logout`, text: "ログアウト" },
          { href: `https://${identityCase.name}.example.test/mypage`, text: "マイページ" },
        ],
      };
      const login = snapshot(`https://${identityCase.name}.example.test/login`, [
        field("login-email", { autocomplete: "username", labels: ["メールアドレス"] }),
        field("login-password", {
          type: "password",
          autocomplete: "current-password",
          labels: ["パスワード"],
        }),
      ]);
      const account = snapshot(`https://${identityCase.name}.example.test/account`, [
        field("collected-email", { autocomplete: "email", labels: ["メールアドレス"] }),
      ]);
      const page = new FakePageDriver([initial, login, account], {
        ...identityCase.values,
        "collected-email": "user@example.test",
      });
      const { logger, entries } = recordingLogger();
      const runner = new VisibilityRunner({
        domain: service,
        openSession: () => Promise.resolve(new FakeSession(page)),
        logger,
      });

      await runner.runSite(site.id);

      assert.equal(page.filled["login-email"], "user@example.test");
      assert.equal(page.filled["login-password"], "fake-pass");
      assert.equal(entries.some((entry) => entry.message === "reusing authenticated browser session"), false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("visibility runner does not treat a logout marker as authenticated on a partial login step", async () => {
  const { dir, service } = await openService();
  try {
    const site = service.upsertSiteAccount({
      domain: "partial-marker.example.test",
      url: "https://partial-marker.example.test/login",
      displayName: "Partial Marker",
    });
    service.addCredential({
      siteAccountId: site.id,
      username: "user@example.test",
      password: "fake-pass",
      source: "csv-import",
    });
    const partialLogin = {
      ...snapshot("https://partial-marker.example.test/login", [
        field("account-entry", { type: "email", labels: ["メールアドレス"] }),
      ]),
      links: [{ href: "https://partial-marker.example.test/logout", text: "ログアウト" }],
    };
    const account = snapshot("https://partial-marker.example.test/account", [
      field("profile-email", { type: "email", autocomplete: "email", labels: ["メールアドレス"] }),
    ]);
    const page = new FakePageDriver([partialLogin, account, account], {
      "account-entry": "user@example.test",
      "profile-email": "user@example.test",
    });
    const runner = new VisibilityRunner({
      domain: service,
      openSession: () => Promise.resolve(new FakeSession(page)),
    });

    await runner.runSite(site.id);

    assert.equal(page.filled["account-entry"], "user@example.test");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("visibility runner falls back to login when only an ambiguous account marker is present", async () => {
  const { dir, service } = await openService();
  try {
    const site = service.upsertSiteAccount({
      domain: "ambiguous.example.test",
      url: "https://ambiguous.example.test/",
      displayName: "Ambiguous",
    });
    service.addCredential({
      siteAccountId: site.id,
      username: "user@example.test",
      password: "fake-pass",
      source: "csv-import",
    });
    const landing = {
      ...snapshot("https://ambiguous.example.test/", []),
      links: [{ href: "https://ambiguous.example.test/mypage", text: "マイページ" }],
    };
    const login = snapshot("https://ambiguous.example.test/login", [
      field("login-email", { type: "email", autocomplete: "username", labels: ["メールアドレス"] }),
      field("login-password", {
        type: "password",
        autocomplete: "current-password",
        labels: ["パスワード"],
      }),
    ]);
    const account = snapshot("https://ambiguous.example.test/account", [
      field("profile-email", { type: "email", autocomplete: "email", labels: ["メールアドレス"] }),
    ]);
    const page = new FakePageDriver([landing, login, account], {
      "profile-email": "user@example.test",
    });
    const runner = new VisibilityRunner({
      domain: service,
      openSession: () => Promise.resolve(new FakeSession(page)),
    });

    await runner.runSite(site.id);

    assert.equal(page.filled["login-email"], "user@example.test");
    assert.equal(page.filled["login-password"], "fake-pass");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("visibility runner discovers a same-site login page and stores that URL on the site account", async () => {
  const { dir, service } = await openService();
  try {
    const site = service.upsertSiteAccount({
      domain: "example.test",
      url: "https://example.test/",
      displayName: "Example",
    });
    service.addCredential({
      siteAccountId: site.id,
      username: "user@example.test",
      password: "fake-pass",
      source: "csv-import",
    });

    const page = new FakePageDriver(
      [
        {
          ...snapshot("https://example.test/", [], "トップページ"),
          links: [
            { href: "https://example.test/help", text: "ヘルプ" },
            { href: "https://example.test/login", text: "ログイン" },
          ],
        },
        snapshot("https://example.test/login", [
          field("login-email", { type: "email", autocomplete: "username", labels: ["メールアドレス"] }),
          field("login-password", {
            type: "password",
            autocomplete: "current-password",
            labels: ["パスワード"],
          }),
        ]),
        snapshot("https://example.test/account", [
          field("profile-email", { type: "email", autocomplete: "email", labels: ["メールアドレス"] }),
        ]),
      ],
      {
        "profile-email": "user@example.test",
      },
    );

    const runner = new VisibilityRunner({
      domain: service,
      openSession: () => Promise.resolve(new FakeSession(page)),
    });

    const result = await runner.runSite(site.id);

    assert.equal(result.status, "collected");
    assert.deepEqual(page.visited, ["https://example.test/", "https://example.test/login"]);
    assert.equal(service.getSiteAccount(site.id)?.url, "https://example.test/login");
    assert.equal(service.listDisclosuresForSite(site.id).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("visibility runner collects read-only display values (text-rendered account info, not form fields)", async () => {
  const { dir, service } = await openService();
  try {
    const site = service.upsertSiteAccount({
      domain: "profile.example.test",
      url: "https://profile.example.test/account",
      displayName: "Profile",
    });
    service.addCredential({
      siteAccountId: site.id,
      username: "user",
      password: "fake-pass",
      source: "csv-import",
    });
    service.setPersonalAttribute({
      attributeKey: "email",
      label: "メール",
      value: "current@example.test",
      valueType: "email",
    });

    // The account page has NO editable form fields; the registered values are
    // rendered as text (e.g. a <dl>), surfaced as displayValues by the scanner.
    const accountPage = snapshot("https://profile.example.test/account", [], "登録情報", [
      { valueId: "d-1", labelText: "メールアドレス", nearbyText: "" },
      { valueId: "d-2", labelText: "電話番号", nearbyText: "" },
    ]);
    const page = new FakePageDriver(
      [accountPage],
      {},
      {
        "d-1": "old@example.test",
        "d-2": "090-1234-5678",
      },
    );
    const runner = new VisibilityRunner({
      domain: service,
      openSession: () => Promise.resolve(new FakeSession(page)),
      now: () => 1_700_000_000_000,
    });

    const result = await runner.runSite(site.id);

    assert.equal(result.status, "collected");
    assert.equal(result.disclosures, 2);
    const disclosures = service.listDisclosuresForSite(site.id);
    assert.equal(disclosures.find((d) => d.attributeKey === "email")?.staleState, "stale");
    assert.equal(disclosures.find((d) => d.attributeKey === "email")?.siteHeldValue, "old@example.test");
    assert.equal(disclosures.find((d) => d.attributeKey === "phone.full")?.siteHeldValue, "090-1234-5678");
    assert.ok(disclosures.every((d) => d.normalizedValueHash));
    // The redacted evidence must not contain the raw display value.
    const evidenceJson = JSON.stringify(service.listEvidence());
    assert.equal(evidenceJson.includes("old@example.test"), false);
    assert.equal(service.getCheckpoint("visibility", site.id)?.status, "done");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("visibility runner skips a non-web credential (e.g. android://) without marking it unreachable", async () => {
  const { dir, service } = await openService();
  try {
    const site = service.upsertSiteAccount({
      domain: "com.example.app",
      url: "android://hash@com.example.app/",
      displayName: "Example App",
    });
    service.addCredential({
      siteAccountId: site.id,
      username: "user",
      password: "fake-pass",
      source: "csv-import",
    });
    let opened = false;
    const runner = new VisibilityRunner({
      domain: service,
      openSession: () => {
        opened = true;
        return Promise.resolve(new FakeSession(new FakePageDriver([])));
      },
    });

    const result = await runner.runSite(site.id);

    assert.equal(result.status, "skipped");
    assert.equal(opened, false, "a non-web credential must not open a browser session");
    const constraint = service.listConstraints().find((c) => c.kind === "unknown-state");
    assert.ok(constraint?.detail.startsWith("non-web-credential:"));
    assert.notEqual(service.getCheckpoint("visibility", site.id)?.status, "done");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- Issue #351: SSO login hand-off (Problem 1 / Problem 2) ---

test("visibility runner hands off on SSO-only login page and collects after resolve", async () => {
  const { dir, service } = await openService();
  try {
    const site = service.upsertSiteAccount({
      domain: "sso-only.example.test",
      url: "https://sso-only.example.test/login",
      displayName: "SsoOnly",
    });
    service.addCredential({
      siteAccountId: site.id,
      username: "user@example.test",
      password: "fake-pass",
      source: "csv-import",
    });
    const ssoPage = snapshot("https://sso-only.example.test/login", [], "SSOログイン");
    ssoPage.buttons = [{ selector: "button.google", text: "Googleでログイン" }];
    const accountPage = snapshot("https://sso-only.example.test/account", [
      field("email", { type: "email", autocomplete: "email", labels: ["メールアドレス"] }),
    ]);
    const page = new FakePageDriver([ssoPage, accountPage, accountPage], { email: "user@example.test" });
    let handoffs = 0;
    let offeredCredential = false;
    const runner = new VisibilityRunner({
      domain: service,
      openSession: () => Promise.resolve(new FakeSession(page)),
      handoff: async (input) => {
        handoffs++;
        assert.match(input.instruction, /IDとパスワードの入力欄が見つかりませんでした/);
        assert.match(input.instruction, /Google/);
        assert.match(input.instruction, /あなた自身でSSOログイン/);
        assert.equal(input.credential, undefined);
        if (input.credential) offeredCredential = true;
        return "resolved";
      },
    });

    const result = await runner.runSite(site.id);

    assert.equal(result.status, "collected");
    assert.equal(handoffs, 1);
    assert.equal(offeredCredential, false);
    assert.equal(
      page.clicked.includes("button.google"),
      false,
      "SSO controls must never be auto-clicked",
    );
    const constraint = service.listConstraints().find((c) => c.detail.startsWith("sso-login-required:"));
    assert.ok(constraint);
    assert.match(constraint.detail, /google/);
    const checkpoint = service.getCheckpoint("visibility", site.id);
    assert.equal(checkpoint?.status, "done");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("visibility runner reports handoff when SSO-only login is aborted", async () => {
  const { dir, service } = await openService();
  try {
    const site = service.upsertSiteAccount({
      domain: "sso-abort.example.test",
      url: "https://sso-abort.example.test/login",
      displayName: "SsoAbort",
    });
    service.addCredential({
      siteAccountId: site.id,
      username: "user",
      password: "fake-pass",
      source: "csv-import",
    });
    const ssoPage = snapshot("https://sso-abort.example.test/login", [], "login");
    ssoPage.buttons = [{ selector: "a.apple", text: "Appleでサインイン" }];
    const page = new FakePageDriver([ssoPage, ssoPage]);
    const { logger, entries } = recordingLogger();
    const runner = new VisibilityRunner({
      domain: service,
      openSession: () => Promise.resolve(new FakeSession(page)),
      handoff: async () => "abort",
      logger,
    });

    const result = await runner.runSite(site.id);

    assert.equal(result.status, "handoff");
    const constraint = service.listConstraints().find((c) => c.detail.startsWith("sso-login-required:"));
    assert.ok(constraint);
    assert.match(constraint.detail, /apple/);
    const log = entries.find((e) => e.message === "sso login required");
    assert.equal(log?.fields?.["domain"], "sso-abort.example.test");
    assert.equal(typeof log?.fields?.["providers"], "string");
    assert.match(String(log?.fields?.["providers"]), /apple/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("visibility runner offers SSO fallback with credential after ID/PW failure; abort is login-failed", async () => {
  const { dir, service } = await openService();
  try {
    const site = service.upsertSiteAccount({
      domain: "sso-fallback.example.test",
      url: "https://sso-fallback.example.test/login",
      displayName: "SsoFallback",
    });
    service.addCredential({
      siteAccountId: site.id,
      username: "user",
      password: "fake-pass",
      source: "csv-import",
    });
    const loginWithSso = snapshot("https://sso-fallback.example.test/login", [
      field("email", { type: "email", autocomplete: "username", labels: ["メールアドレス"] }),
      field("password", { type: "password", autocomplete: "current-password", labels: ["パスワード"] }),
    ]);
    loginWithSso.buttons = [
      { selector: "button[type=submit]", text: "ログイン" },
      { selector: "button.line", text: "LINEでログイン" },
    ];
    const page = new FakePageDriver([loginWithSso, loginWithSso, loginWithSso]);
    let handoffInput: { instruction: string; credential?: unknown } | undefined;
    const runner = new VisibilityRunner({
      domain: service,
      openSession: () => Promise.resolve(new FakeSession(page)),
      handoff: async (input) => {
        handoffInput = input;
        return "abort";
      },
    });

    const result = await runner.runSite(site.id);

    assert.equal(result.status, "login-failed");
    assert.ok(handoffInput);
    assert.match(handoffInput.instruction, /IDとパスワードでのログインができませんでした/);
    assert.match(handoffInput.instruction, /LINE/);
    assert.ok(handoffInput.credential, "Problem 2 must offer the imported credential for manual re-try");
    const ssoConstraint = service.listConstraints().find((c) => c.detail.startsWith("sso-fallback-suggested:"));
    assert.ok(ssoConstraint);
    assert.match(ssoConstraint.detail, /line/);
    const loginConstraint = service.listConstraints().find((c) => c.detail.startsWith("login-incomplete:"));
    assert.ok(loginConstraint);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("visibility runner collects after SSO fallback resolve when ID/PW failed", async () => {
  const { dir, service } = await openService();
  try {
    const site = service.upsertSiteAccount({
      domain: "sso-fallback-ok.example.test",
      url: "https://sso-fallback-ok.example.test/login",
      displayName: "SsoFallbackOk",
    });
    service.addCredential({
      siteAccountId: site.id,
      username: "user",
      password: "fake-pass",
      source: "csv-import",
    });
    const loginWithSso = snapshot("https://sso-fallback-ok.example.test/login", [
      field("email", { type: "email", autocomplete: "username", labels: ["メールアドレス"] }),
      field("password", { type: "password", autocomplete: "current-password", labels: ["パスワード"] }),
    ]);
    loginWithSso.buttons = [
      { selector: "button[type=submit]", text: "ログイン" },
      { selector: "button.google", text: "Googleでログイン" },
    ];
    const accountPage = snapshot("https://sso-fallback-ok.example.test/account", [
      field("email", { type: "email", autocomplete: "email", labels: ["メールアドレス"] }),
    ]);
    // initial login-page, after-login still login, post-SSO resolve, after-login wall check, explore
    const page = new FakePageDriver(
      [loginWithSso, loginWithSso, accountPage, accountPage, accountPage],
      { email: "user@example.test" },
    );
    let handoffs = 0;
    const runner = new VisibilityRunner({
      domain: service,
      openSession: () => Promise.resolve(new FakeSession(page)),
      handoff: async (input) => {
        handoffs++;
        assert.match(input.instruction, /IDとパスワードでのログインができませんでした/);
        assert.ok(input.credential);
        return "resolved";
      },
    });

    const result = await runner.runSite(site.id);

    assert.equal(result.status, "collected");
    assert.equal(handoffs, 1);
    assert.equal(page.clicked.includes("button.google"), false);
    const ssoConstraint = service.listConstraints().find((c) => c.detail.startsWith("sso-fallback-suggested:"));
    assert.ok(ssoConstraint);
    assert.match(ssoConstraint.detail, /google/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("visibility runner still fills a username-only first step (partial login form regression)", async () => {
  const { dir, service } = await openService();
  try {
    const site = service.upsertSiteAccount({
      domain: "partial-login.example.test",
      url: "https://partial-login.example.test/login",
      displayName: "PartialLogin",
    });
    service.addCredential({
      siteAccountId: site.id,
      username: "user@example.test",
      password: "fake-pass",
      source: "csv-import",
    });
    // Username-only step with an incidental SSO-looking control must not steal the flow:
    // we still fill the username field (multi-step login regression guard).
    const usernameOnly = snapshot("https://partial-login.example.test/login", [
      field("email", { type: "email", autocomplete: "username", labels: ["メールアドレス"] }),
    ]);
    usernameOnly.buttons = [
      { selector: "button.next", text: "次へ" },
      { selector: "button.google", text: "Googleでログイン" },
    ];
    const accountPage = snapshot("https://partial-login.example.test/account", [
      field("email", { type: "email", autocomplete: "email", labels: ["メールアドレス"] }),
    ]);
    const page = new FakePageDriver([usernameOnly, accountPage, accountPage], {
      email: "user@example.test",
    });
    let ssoHandoffs = 0;
    const runner = new VisibilityRunner({
      domain: service,
      openSession: () => Promise.resolve(new FakeSession(page)),
      handoff: async (input) => {
        if (input.instruction.includes("SSO") || input.instruction.includes("SSOログイン")) {
          ssoHandoffs++;
        }
        return "resolved";
      },
    });

    const result = await runner.runSite(site.id);

    assert.equal(page.filled["email"], "user@example.test", "username-only step must still be filled");
    assert.equal(ssoHandoffs, 0, "partial form with a username field is not Problem 1 SSO-only");
    assert.ok(result.status === "collected" || result.status === "no-data" || result.status === "login-failed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("visibility runner keeps login-failed without SSO handoff when ID/PW fails and no SSO exists (regression)", async () => {
  const { dir, service } = await openService();
  try {
    const site = service.upsertSiteAccount({
      domain: "no-sso-stuck.example.test",
      url: "https://no-sso-stuck.example.test/login",
      displayName: "NoSsoStuck",
    });
    service.addCredential({
      siteAccountId: site.id,
      username: "user",
      password: "fake-pass",
      source: "csv-import",
    });
    const loginOnly = snapshot("https://no-sso-stuck.example.test/login", [
      field("email", { type: "email", autocomplete: "username", labels: ["メールアドレス"] }),
      field("password", { type: "password", autocomplete: "current-password", labels: ["パスワード"] }),
    ]);
    let handoffs = 0;
    const page = new FakePageDriver([loginOnly, loginOnly]);
    const runner = new VisibilityRunner({
      domain: service,
      openSession: () => Promise.resolve(new FakeSession(page)),
      handoff: async () => {
        handoffs++;
        return "resolved";
      },
    });

    const result = await runner.runSite(site.id);

    assert.equal(result.status, "login-failed");
    assert.equal(handoffs, 0, "must not invent an SSO hand-off when no SSO control exists");
    assert.equal(
      service.listConstraints().some((c) => c.detail.includes("sso-")),
      false,
    );
    const constraint = service.listConstraints().find((c) => c.detail.startsWith("login-incomplete:"));
    assert.ok(constraint);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("visibility runner offers SSO handoff at most once per site run", async () => {
  const { dir, service } = await openService();
  try {
    const site = service.upsertSiteAccount({
      domain: "sso-once.example.test",
      url: "https://sso-once.example.test/login",
      displayName: "SsoOnce",
    });
    service.addCredential({
      siteAccountId: site.id,
      username: "user",
      password: "fake-pass",
      source: "csv-import",
    });
    // SSO-only page; after "resolve" still the same SSO login page (user did not finish).
    const ssoPage = snapshot("https://sso-once.example.test/login", [], "SSO");
    ssoPage.buttons = [{ selector: "button.google", text: "Googleでログイン" }];
    const page = new FakePageDriver([ssoPage, ssoPage, ssoPage, ssoPage]);
    let handoffs = 0;
    const runner = new VisibilityRunner({
      domain: service,
      openSession: () => Promise.resolve(new FakeSession(page)),
      handoff: async () => {
        handoffs++;
        return "resolved";
      },
    });

    const result = await runner.runSite(site.id);

    assert.equal(handoffs, 1, "SSO hand-off is single-shot; do not re-prompt in the same run");
    // Still on login with no collectable data after a no-op "resolve".
    assert.ok(result.status === "no-data" || result.status === "collected");
    assert.equal(result.disclosures, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("visibility runner reports login-failed (not collected) when a password field remains and nothing was collected", async () => {
  const { dir, service } = await openService();
  try {
    const site = service.upsertSiteAccount({
      domain: "stuck.example.test",
      url: "https://stuck.example.test/login",
      displayName: "stuck.example.test",
    });
    service.addCredential({
      siteAccountId: site.id,
      username: "user",
      password: "fake-pass",
      source: "csv-import",
    });
    // Both snapshots are the same login page: the login click never advanced past it.
    const loginSnapshot = snapshot("https://stuck.example.test/login", [
      field("email", { type: "email", autocomplete: "username", labels: ["メールアドレス"] }),
      field("password", { type: "password", autocomplete: "current-password", labels: ["パスワード"] }),
    ]);
    loginSnapshot.siteName = "Generic Login Portal";
    const page = new FakePageDriver([loginSnapshot, loginSnapshot], {});
    const { logger, entries } = recordingLogger();
    const runner = new VisibilityRunner({
      domain: service,
      openSession: () => Promise.resolve(new FakeSession(page)),
      logger,
    });

    const result = await runner.runSite(site.id);

    assert.equal(result.status, "login-failed");
    assert.equal(result.disclosures, 0);
    assert.equal(service.listDisclosuresForSite(site.id).length, 0);
    assert.equal(service.getSiteAccount(site.id)?.displayName, "stuck.example.test");
    assert.notEqual(service.getCheckpoint("visibility", site.id)?.status, "done");
    const constraint = service.listConstraints().find((c) => c.kind === "unknown-state");
    assert.ok(constraint?.detail.startsWith("login-incomplete:"));
    // Issue #314: the diagnostics log must record the login-failure reason so a
    // downloaded log can distinguish this from an unreachable site or a generic error.
    const loginFailureLog = entries.find((e) => e.level === "warn" && e.message.startsWith("login failed"));
    assert.equal(loginFailureLog?.fields?.["domain"], "stuck.example.test");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("visibility runner does not rename a site from a partial login page", async () => {
  const { dir, service } = await openService();
  try {
    const site = service.upsertSiteAccount({
      domain: "partial-stuck.example.test",
      url: "https://partial-stuck.example.test/login",
      displayName: "partial-stuck.example.test",
    });
    service.addCredential({
      siteAccountId: site.id,
      username: "user",
      password: "fake-pass",
      source: "csv-import",
    });
    const usernameOnly = snapshot("https://partial-stuck.example.test/login", [
      field("username", { autocomplete: "username", labels: ["ログインID"] }),
    ]);
    usernameOnly.siteName = "Generic Login Portal";
    const page = new FakePageDriver([usernameOnly, usernameOnly], {});
    const runner = new VisibilityRunner({
      domain: service,
      openSession: () => Promise.resolve(new FakeSession(page)),
    });

    await runner.runSite(site.id);

    assert.equal(service.getSiteAccount(site.id)?.displayName, "partial-stuck.example.test");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("visibility runner still reports login-failed when a stuck login page also has an unrelated dynamic-attribute candidate field", async () => {
  const { dir, service } = await openService();
  try {
    const site = service.upsertSiteAccount({
      domain: "stuck-with-extra-field.example.test",
      url: "https://stuck-with-extra-field.example.test/login",
      displayName: "StuckWithExtraField",
    });
    service.addCredential({
      siteAccountId: site.id,
      username: "user",
      password: "fake-pass",
      source: "csv-import",
    });
    // Both snapshots are the same login page: the login click never advanced past it.
    // The page also has an unrelated required field (e.g. a promo/referral code) that
    // the classifier cannot map — recording a dynamic-attribute candidate must not
    // mask the fact that login itself never succeeded.
    const loginSnapshot = snapshot("https://stuck-with-extra-field.example.test/login", [
      field("email", { type: "email", autocomplete: "username", labels: ["メールアドレス"] }),
      field("password", { type: "password", autocomplete: "current-password", labels: ["パスワード"] }),
      field("referral", { required: true, labels: ["紹介コード"] }),
    ]);
    const page = new FakePageDriver([loginSnapshot, loginSnapshot], { referral: "ABC123" });
    const runner = new VisibilityRunner({
      domain: service,
      openSession: () => Promise.resolve(new FakeSession(page)),
    });

    const result = await runner.runSite(site.id);

    assert.equal(result.status, "login-failed");
    assert.equal(result.disclosures, 0);
    assert.equal(service.listDisclosuresForSite(site.id).length, 0);
    assert.notEqual(service.getCheckpoint("visibility", site.id)?.status, "done");
    const constraint = service.listConstraints().find((c) => c.kind === "unknown-state");
    assert.ok(constraint?.detail.startsWith("login-incomplete:"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("visibility runner reports no-data (not collected) when the page yields no collectable values", async () => {
  const { dir, service } = await openService();
  try {
    const site = service.upsertSiteAccount({
      domain: "empty.example.test",
      url: "https://empty.example.test/account",
      displayName: "Empty",
    });
    service.addCredential({
      siteAccountId: site.id,
      username: "user",
      password: "fake-pass",
      source: "csv-import",
    });
    // Already past login (no login fields), but readValues returns nothing.
    const page = new FakePageDriver([snapshot("https://empty.example.test/account", [], "ようこそ")], {});
    const runner = new VisibilityRunner({
      domain: service,
      openSession: () => Promise.resolve(new FakeSession(page)),
    });

    const result = await runner.runSite(site.id);

    assert.equal(result.status, "no-data");
    assert.equal(result.disclosures, 0);
    assert.notEqual(service.getCheckpoint("visibility", site.id)?.status, "done");
    const constraint = service.listConstraints().find((c) => c.kind === "unknown-state");
    assert.ok(constraint?.detail.startsWith("no-collectable-data:"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("visibility runner reports collected (not no-data) when only a dynamic-attribute candidate is found", async () => {
  const { dir, service } = await openService();
  try {
    const site = service.upsertSiteAccount({
      domain: "unknownfield.example.test",
      url: "https://unknownfield.example.test/account",
      displayName: "UnknownField",
    });
    // Already past login (no login fields); the page has one required field the
    // deterministic classifier cannot map to any known/validated attribute.
    const page = new FakePageDriver(
      [
        snapshot("https://unknownfield.example.test/account", [
          field("occupation", { required: true, labels: ["職業"] }),
        ]),
      ],
      { occupation: "会社員" },
    );
    const runner = new VisibilityRunner({
      domain: service,
      openSession: () => Promise.resolve(new FakeSession(page)),
    });

    const result = await runner.runSite(site.id);

    assert.equal(result.status, "collected");
    assert.equal(result.disclosures, 0);
    assert.equal(service.getCheckpoint("visibility", site.id)?.status, "done");
    const candidate = service.listDynamicAttributeCandidates()[0];
    assert.equal(candidate?.label, "職業");
    assert.equal(candidate?.status, "candidate");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("visibility runner records an unreachable URL without leaking credentials", async () => {
  const { dir, service } = await openService();
  try {
    const site = service.upsertSiteAccount({
      domain: "gone.example.test",
      url: "https://gone.example.test/login",
      displayName: "Gone",
    });
    service.addCredential({
      siteAccountId: site.id,
      username: "real-user-canary",
      password: "real-password-canary",
      source: "csv-import",
    });
    const page = new FakePageDriver([]);
    page.gotoError = new Error("page.goto: net::ERR_NAME_NOT_RESOLVED at https://gone.example.test/login");

    const { logger, entries } = recordingLogger();
    const runner = new VisibilityRunner({
      domain: service,
      openSession: () => Promise.resolve(new FakeSession(page)),
      logger,
    });

    const result = await runner.runSite(site.id);

    assert.equal(result.status, "unreachable");
    const constraint = service.listConstraints().find((item) => item.kind === "unknown-state");
    assert.ok(constraint);
    assert.equal(constraint.detail, "access-unreachable: dns-not-found");
    const serialized = JSON.stringify({
      constraints: service.listConstraints(),
      evidence: service.listEvidence(),
    });
    assert.equal(serialized.includes("real-user-canary"), false);
    assert.equal(serialized.includes("real-password-canary"), false);
    // Issue #314: the diagnostics log must carry the fine-grained reason (dns-not-found)
    // distinct from a generic "failed", and must never carry the credential.
    const unreachableLog = entries.find((e) => e.category === "visibility" && e.message === "site unreachable");
    assert.equal(unreachableLog?.fields?.["reason"], "dns-not-found");
    const serializedLog = JSON.stringify(entries);
    assert.equal(serializedLog.includes("real-user-canary"), false);
    assert.equal(serializedLog.includes("real-password-canary"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runner log entries round-trip through the collection-log analysis (Issue #317)", async () => {
  // Pins the runner↔analyzer contract on real runner output: if a runner log
  // message or field name is reworded, the site drops out of the analysis and
  // this test fails — the hand-written fixtures in
  // soroeru-collection-log-analysis.test.ts alone would not notice.
  const { dir, service } = await openService();
  try {
    const { logger, entries } = recordingLogger();

    const dns = service.upsertSiteAccount({
      domain: "dns.example.test",
      url: "https://dns.example.test/login",
      displayName: "DNS",
    });
    const dnsPage = new FakePageDriver([snapshot("https://dns.example.test/login", [])]);
    dnsPage.gotoError = new Error("page.goto: net::ERR_NAME_NOT_RESOLVED");
    await new VisibilityRunner({
      domain: service,
      openSession: () => Promise.resolve(new FakeSession(dnsPage)),
      logger,
    }).runSite(dns.id);

    const walledSite = service.upsertSiteAccount({
      domain: "wall.example.test",
      url: "https://wall.example.test/login",
      displayName: "Wall",
    });
    const walled = snapshot("https://wall.example.test/login", [], "私はロボットではありません");
    walled.wallMarkers = ["recaptcha"];
    await new VisibilityRunner({
      domain: service,
      openSession: () => Promise.resolve(new FakeSession(new FakePageDriver([walled]))),
      logger,
    }).runSite(walledSite.id);

    const canceledSite = service.upsertSiteAccount({
      domain: "cancel.example.test",
      url: "https://cancel.example.test/",
      displayName: "Cancel",
    });
    await new VisibilityRunner({
      domain: service,
      openSession: () => Promise.resolve(new FakeSession(new FakePageDriver([]))),
      isCanceled: () => true,
      logger,
    }).runSite(canceledSite.id);

    // Serialize the captured entries the same way the FileLogger envelope
    // does (fields spread first, envelope keys last), then run the analysis.
    const logText = entries
      .map((entry) =>
        JSON.stringify({
          ...entry.fields,
          at: "2026-07-06T00:00:00.000Z",
          level: entry.level,
          category: entry.category,
          message: entry.message,
        }),
      )
      .join("\n");
    const outcomes = siteOutcomes(parseLogEntries(logText));

    const bySite = new Map(outcomes.map((outcome) => [outcome.site, outcome.category]));
    assert.equal(bySite.get("dns.example.test"), "unreachable:dns-not-found");
    assert.equal(bySite.get("wall.example.test"), "wall:captcha");
    assert.equal(bySite.get("cancel.example.test"), "canceled");
    // One outcome per site: the domain join must hold for every terminal
    // entry (a siteAccountId-keyed duplicate would show up as a fourth row).
    assert.equal(outcomes.length, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

class FakeSession implements SiteSession {
  constructor(readonly page: FakePageDriver) {}

  async close(): Promise<void> {
    this.page.closed = true;
  }
}

class FakePageDriver implements PageDriver {
  filled: Record<string, string> = {};
  clicked: string[] = [];
  visited: string[] = [];
  gotoError: Error | undefined;
  closed = false;
  private index = 0;

  constructor(
    private readonly snapshots: PageSnapshot[],
    private readonly values: Record<string, string> = {},
    private readonly displayValues: Record<string, string> = {},
  ) {}

  async readDisplayValues(): Promise<Record<string, string>> {
    return this.displayValues;
  }

  async goto(url: string): Promise<void> {
    this.visited.push(url);
    if (this.gotoError) throw this.gotoError;
  }

  async waitForReady(): Promise<void> {}

  currentUrl(): string {
    return this.snapshots[Math.min(this.index, this.snapshots.length - 1)]?.url ?? "";
  }

  async snapshot(): Promise<PageSnapshot> {
    const snapshot = this.snapshots[Math.min(this.index, this.snapshots.length - 1)];
    this.index++;
    if (!snapshot) throw new Error("no snapshot");
    return snapshot;
  }

  async readValues(): Promise<Record<string, string>> {
    return this.values;
  }

  async fillField(fieldId: string, value: string): Promise<void> {
    this.filled[fieldId] = value;
  }

  async click(selector: string): Promise<void> {
    this.clicked.push(selector);
  }
}

function snapshot(
  url: string,
  fields: FormField[],
  visibleText = "",
  displayValues: PageSnapshot["displayValues"] = [],
): PageSnapshot {
  return {
    url,
    title: "Test",
    fields,
    buttons: [{ selector: "button[type=submit]", text: "ログイン" }],
    links: [],
    visibleText,
    iframeSrcs: [],
    wallMarkers: [],
    displayValues,
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
