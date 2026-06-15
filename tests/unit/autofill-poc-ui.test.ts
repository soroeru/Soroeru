// Local app UI (RFC-001 v3 §7, UI-001 / #17): menu dispatch, personal-data
// CRUD (incl. sensitive-field masking and passphrase re-entry to reveal),
// site inventory / mandate display, bulk-update gating, and settings
// (provider config, recovery key, encrypted export/import). I/O is driven
// through a scripted `UiIo` fake; no real terminal or browser is needed.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright";
import { AutofillApp } from "../../src/app/app.js";
import { AppRunner } from "../../src/app/runner.js";
import { AppUI, type UiIo } from "../../src/app/ui.js";
import type { Mapper } from "../../src/agent/mapper.js";

const PASSPHRASE = "unit-test-passphrase";

/** Browser launcher that fails the test if a UI flow ever launches a browser unexpectedly. */
const refuseLaunch = async (): Promise<Browser> => {
  throw new Error("unexpected browser launch");
};

type Answer = string | (() => string);

/** Scripted `UiIo`: `ask`/`confirm`/`askSecret` all draw from one ordered queue. */
class FakeIo implements UiIo {
  readonly logs: string[] = [];
  private readonly answers: Answer[];

  constructor(answers: Answer[]) {
    this.answers = [...answers];
  }

  private next(): string {
    const answer = this.answers.shift();
    if (answer === undefined) throw new Error("FakeIo: no more scripted answers");
    return typeof answer === "function" ? answer() : answer;
  }

  ask(_prompt: string): Promise<string> {
    return Promise.resolve(this.next());
  }

  confirm(_prompt: string): Promise<boolean> {
    return Promise.resolve(this.next().toLowerCase() === "y");
  }

  askSecret(_prompt: string): Promise<string> {
    return Promise.resolve(this.next());
  }

  log(message: string): void {
    this.logs.push(message);
  }
}

async function withApp(fn: (app: AutofillApp, runner: AppRunner) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "af-poc-ui-"));
  try {
    const app = new AutofillApp({ stateDir: dir, idleLockMs: 0, launchBrowserFn: refuseLaunch });
    await app.unlock(PASSPHRASE);
    const runner = new AppRunner(app, {} as unknown as Mapper);
    await fn(app, runner);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("run() exits immediately on 0 / empty / q", async () => {
  await withApp(async (app, runner) => {
    for (const exitChoice of ["0", "", "q"]) {
      const io = new FakeIo([exitChoice]);
      await new AppUI(app, runner, io).run();
      assert.equal(app.isUnlocked, true);
    }
  });
});

test("run() reports an unknown choice and keeps looping", async () => {
  await withApp(async (app, runner) => {
    const io = new FakeIo(["z", "0"]);
    await new AppUI(app, runner, io).run();
    assert.ok(io.logs.includes("不明な選択です"));
  });
});

test("run() prompts for re-unlock after idle lock; declining ends the session", async () => {
  await withApp(async (app, runner) => {
    await app.store.save();
    app.lock();
    const io = new FakeIo([""]); // empty passphrase declines re-unlock
    await new AppUI(app, runner, io).run();
    assert.equal(app.isUnlocked, false);
    assert.ok(io.logs.some((l) => l.includes("アイドルタイムアウト")));
  });
});

test("run() resumes the main menu after a successful re-unlock", async () => {
  await withApp(async (app, runner) => {
    await app.store.save();
    app.lock();
    const io = new FakeIo([PASSPHRASE, "0"]);
    await new AppUI(app, runner, io).run();
    assert.equal(app.isUnlocked, true);
  });
});

test("profile menu: add a known field", async () => {
  await withApp(async (app, runner) => {
    // Pick the first available KNOWN_PROFILE_KEYS entry ("name.full" / 氏名).
    const io = new FakeIo(["1", "a", "1", "山田太郎", "0", "0"]);
    await new AppUI(app, runner, io).run();
    assert.equal(app.store.getValue("name.full"), "山田太郎");
    assert.ok(io.logs.includes("保存しました"));
  });
});

test("profile menu: add a custom field with default match terms", async () => {
  await withApp(async (app, runner) => {
    const io = new FakeIo(["1", "a", "c", "favColor", "好きな色", "", "青", "0", "0"]);
    await new AppUI(app, runner, io).run();
    const entry = app.store.profile.get("custom.favColor");
    assert.ok(entry);
    assert.equal(entry?.label, "好きな色");
    assert.equal(entry?.value, "青");
    assert.deepEqual(entry?.matchTerms, ["好きな色"]);
  });
});

test("profile menu: edit an existing field", async () => {
  await withApp(async (app, runner) => {
    app.store.setProfileValue("email", "メールアドレス", "old@example.test");
    const io = new FakeIo(["1", "e", "1", "new@example.test", "0", "0"]);
    await new AppUI(app, runner, io).run();
    assert.equal(app.store.getValue("email"), "new@example.test");
    assert.ok(io.logs.includes("更新しました"));
  });
});

test("profile menu: lists card values masked", async () => {
  await withApp(async (app, runner) => {
    app.store.setProfileValue("card.number", "カード番号", "4242424242424242");
    app.store.setProfileValue("card.cvv", "セキュリティコード", "123");
    const io = new FakeIo(["1", "0", "0"]);
    await new AppUI(app, runner, io).run();
    assert.ok(io.logs.some((l) => l.includes("**** **** **** 4242")));
    assert.ok(io.logs.some((l) => l.includes("[card.cvv]") && l.includes("••••••")));
    assert.ok(!io.logs.some((l) => l.includes("4242424242424242")));
    assert.ok(!io.logs.some((l) => l.includes("= 123")));
  });
});

test("profile menu: revealing a sensitive field requires the master passphrase", async () => {
  await withApp(async (app, runner) => {
    app.store.setProfileValue("card.cvv", "セキュリティコード", "123");

    const ok = new FakeIo(["1", "r", "1", PASSPHRASE, "0", "0"]);
    await new AppUI(app, runner, ok).run();
    assert.ok(ok.logs.includes("セキュリティコード [card.cvv] = 123"));

    const bad = new FakeIo(["1", "r", "1", "wrong-passphrase", "0", "0"]);
    await new AppUI(app, runner, bad).run();
    assert.ok(bad.logs.some((l) => l.includes("パスフレーズが一致しません")));
    assert.ok(!bad.logs.some((l) => l.includes("= 123")));
  });
});

test("profile menu: delete requires confirmation", async () => {
  await withApp(async (app, runner) => {
    app.store.setProfileValue("phone.full", "電話番号", "090-1234-5678");

    const declined = new FakeIo(["1", "d", "1", "n", "0", "0"]);
    await new AppUI(app, runner, declined).run();
    assert.ok(app.store.profile.has("phone.full"));

    const confirmed = new FakeIo(["1", "d", "1", "y", "0", "0"]);
    await new AppUI(app, runner, confirmed).run();
    assert.ok(!app.store.profile.has("phone.full"));
    assert.ok(confirmed.logs.includes("削除しました"));
  });
});

test("site menu: view shows filled fields and mandates", async () => {
  await withApp(async (app, runner) => {
    app.store.upsertSiteRecord({
      origin: "https://example.test",
      siteId: "example",
      serviceName: "Example Service",
      registeredAt: Date.now(),
      filledFields: [],
      status: "registered",
    });
    app.store.addMandate({
      origin: "https://example.test",
      authorizedAt: Date.now(),
      submittedFieldKeys: ["email"],
      highRiskFlags: [],
      attestationsApproved: [],
      result: "registered",
    });

    const io = new FakeIo(["2", "v", "1", "0", "0"]);
    await new AppUI(app, runner, io).run();
    assert.ok(io.logs.some((l) => l.includes("Example Service (https://example.test)")));
    assert.ok(io.logs.some((l) => l.includes("mandates (1):")));
    assert.ok(io.logs.some((l) => l.includes("result=registered")));
  });
});

test("site menu: delete requires confirmation", async () => {
  await withApp(async (app, runner) => {
    app.store.upsertSiteRecord({
      origin: "https://example.test",
      siteId: "example",
      serviceName: "Example Service",
      registeredAt: Date.now(),
      filledFields: [],
      status: "registered",
    });

    const io = new FakeIo(["2", "d", "1", "y", "0", "0"]);
    await new AppUI(app, runner, io).run();
    assert.equal(app.store.getSiteRecord("example"), undefined);
  });
});

test("bulk update: nothing to do when no site has stale fields", async () => {
  await withApp(async (app, runner) => {
    app.store.upsertSiteRecord({
      origin: "https://example.test",
      siteId: "example",
      serviceName: "Example Service",
      registeredAt: Date.now(),
      filledFields: [],
      status: "registered",
    });

    const io = new FakeIo(["3", "0"]);
    await new AppUI(app, runner, io).run();
    assert.ok(io.logs.includes("更新が必要なサイトはありません"));
  });
});

test("new registration: an empty URL cancels without launching a browser", async () => {
  await withApp(async (app, runner) => {
    const io = new FakeIo(["4", "", "0"]);
    await new AppUI(app, runner, io).run(); // refuseLaunch would throw if a browser were launched
  });
});

test("settings: AI provider configuration validates required fields before saving", async () => {
  await withApp(async (app, runner) => {
    await new AppUI(app, runner, new FakeIo(["5", "p", "not-a-provider", "0", "0"])).run();
    assert.equal(app.store.getSettings(), undefined);

    const noModel = new FakeIo(["5", "p", "openai", "", "0", "0"]);
    await new AppUI(app, runner, noModel).run();
    assert.equal(app.store.getSettings(), undefined);
    assert.ok(noModel.logs.includes("モデル名は必須です"));

    const noKey = new FakeIo(["5", "p", "openai", "gpt-5.4", "", "0", "0"]);
    await new AppUI(app, runner, noKey).run();
    assert.equal(app.store.getSettings(), undefined);
    assert.ok(noKey.logs.includes("APIキーは必須です"));

    const ok = new FakeIo(["5", "p", "openai", "gpt-5.4", "sk-test", "0", "0"]);
    await new AppUI(app, runner, ok).run();
    assert.deepEqual(app.store.getSettings(), { provider: "openai", model: "gpt-5.4", apiKey: "sk-test" });
    assert.ok(ok.logs.includes("保存しました"));
  });
});

test("settings: revealing the API key requires the master passphrase", async () => {
  await withApp(async (app, runner) => {
    app.store.setProviderSettings({ provider: "openai", model: "gpt-5.4", apiKey: "sk-test" });
    await app.store.save();

    const ok = new FakeIo(["5", "k", PASSPHRASE, "0", "0"]);
    await new AppUI(app, runner, ok).run();
    assert.ok(ok.logs.some((l) => l.includes("apiKey=sk-test")));

    const bad = new FakeIo(["5", "k", "wrong-passphrase", "0", "0"]);
    await new AppUI(app, runner, bad).run();
    assert.ok(bad.logs.some((l) => l.includes("パスフレーズが一致しません")));
    assert.ok(!bad.logs.some((l) => l.includes("sk-test")));
  });
});

test("settings: generate, verify, and remove a recovery key", async () => {
  await withApp(async (app, runner) => {
    const recoveryKeyRe = /^([A-Z2-7]{4}-){12}[A-Z2-7]{4}$/;
    const gen: FakeIo = new FakeIo([
      "5",
      "g",
      "", // "press Enter to continue" after the one-time display
      "y", // verify the recovery key
      () => gen.logs.find((l: string) => recoveryKeyRe.test(l)) ?? "",
      "0",
      "0",
    ]);
    await new AppUI(app, runner, gen).run();
    assert.equal(app.store.hasRecoveryKey, true);
    assert.ok(gen.logs.includes("検証成功"));

    const remove = new FakeIo(["5", "x", "y", "0", "0"]);
    await new AppUI(app, runner, remove).run();
    assert.equal(app.store.hasRecoveryKey, false);
  });
});

test("settings: encrypted export / import roundtrip", async () => {
  await withApp(async (app, runner) => {
    app.store.setProfileValue("email", "メールアドレス", "user@example.test");
    await app.store.save();

    const dir = await mkdtemp(join(tmpdir(), "af-poc-ui-export-"));
    try {
      const exportPath = join(dir, "export.json");
      const exportIo = new FakeIo(["5", "e", exportPath, "0", "0"]);
      await new AppUI(app, runner, exportIo).run();
      assert.ok(exportIo.logs.some((l) => l.includes(exportPath)));
      const exported = JSON.parse(await readFile(exportPath, "utf8")) as { version: number };
      assert.equal(exported.version, 1);

      const destPath = join(dir, "restored.json");
      const importIo = new FakeIo(["5", "i", exportPath, destPath, PASSPHRASE, "0", "0"]);
      await new AppUI(app, runner, importIo).run();
      assert.ok(importIo.logs.some((l) => l.includes(`復元しました: ${destPath}`)));
      const restored = JSON.parse(await readFile(destPath, "utf8")) as { version: number };
      assert.equal(restored.version, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test("settings: import refuses to target the currently-open store file", async () => {
  await withApp(async (app, runner) => {
    await app.store.save();
    const io = new FakeIo(["5", "i", app.storeFilePath, app.storeFilePath, "0", "0"]);
    await new AppUI(app, runner, io).run();
    assert.ok(io.logs.some((l) => l.includes("現在開いているストアへの上書きはできません")));
  });
});
