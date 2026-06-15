// Existing-account import (#84): values are extracted locally from a profile
// page, reviewed, then saved into the encrypted store. The mapper sees only the
// structural snapshot, never raw imported values.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { collectImportCandidates, saveImportedProfileValues } from "../../src/agent/importer.js";
import type { Mapper } from "../../src/agent/mapper.js";
import type { MappingPlan, PageLink, PageSnapshot, TermsAnalysis } from "../../src/types.js";
import { CatashiroApp } from "../../src/app/app.js";
import { AppRunner } from "../../src/app/runner.js";
import { startPocServer } from "../../sites/server.js";

const PASSPHRASE = "unit-test-passphrase";

class SpyMapper implements Mapper {
  readonly name = "deterministic";
  snapshots: PageSnapshot[] = [];

  discoverRegistrationLink(_links: PageLink[]): Promise<PageLink | undefined> {
    return Promise.resolve(undefined);
  }

  mapFields(snapshot: PageSnapshot): Promise<MappingPlan> {
    this.snapshots.push(snapshot);
    return Promise.resolve({
      entries: [
        { fieldId: "f-1", profileKey: "name.full" },
        { fieldId: "f-3", profileKey: "email" },
        { fieldId: "f-4", profileKey: "phone.full" },
        { fieldId: "f-5", profileKey: "postal.full" },
        { fieldId: "f-6", profileKey: "address.full" },
        { fieldId: "f-9", profileKey: "account.password" },
      ],
      checkboxes: [],
      unmappedRequired: [],
    });
  }

  analyzeTerms(): Promise<TermsAnalysis> {
    return Promise.resolve({ highRiskFlags: [], evidence: {}, prohibitsAutoCreation: false });
  }
}

test("existing-account import extracts local values without sending them to the mapper", async () => {
  const dir = await mkdtemp(join(tmpdir(), "af-poc-import-"));
  const site = await startPocServer();
  const browser = await chromium.launch({ headless: true });
  const app = new CatashiroApp({ stateDir: dir, idleLockMs: 0 });
  try {
    await app.unlock(PASSPHRASE);
    await seedRegisteredAccount(site.siteUrl("01-basic"));
    const page = await browser.newPage();
    const mapper = new SpyMapper();
    const runner = new AppRunner(app, mapper);

    const result = await runner.importExistingAccount(page, `${site.siteUrl("01-basic")}edit`);
    assert.equal(result.siteId, new URL(site.url).host);
    assert.equal(result.serviceName, "ベーシック商店");
    assert.deepEqual(
      result.candidates.map((candidate) => [candidate.profileKey, candidate.value]),
      [
        ["name.full", "既存 太郎"],
        ["email", "existing@example.test"],
        ["phone.full", "090-1111-2222"],
        ["postal.full", "100-0001"],
        ["address.full", "東京都千代田区1-1"],
      ],
    );
    assert.equal(result.candidates.find((candidate) => candidate.profileKey === "account.password"), undefined);
    assert.equal(mapper.snapshots.length, 1);
    assert.ok(!JSON.stringify(mapper.snapshots[0]).includes("existing@example.test"));
    assert.ok(!JSON.stringify(mapper.snapshots[0]).includes("Existing-Passw0rd!"));

    const record = await saveImportedProfileValues(app.store, result, {
      approved: true,
      edits: { [result.candidates.find((candidate) => candidate.profileKey === "phone.full")!.fieldId]: "090-3333-4444" },
    });
    assert.ok(record);
    assert.equal(app.store.getValue("email"), "existing@example.test");
    assert.equal(app.store.getValue("phone.full"), "090-3333-4444");
    assert.equal(record.accountState, "imported");
    assert.equal(record.nextAction, "reviewInventory");
    assert.equal(record.filledFields.length, 5);
    assert.ok(!JSON.stringify(app.store.listSiteRecords()).includes("existing@example.test"));
  } finally {
    await browser.close();
    await app.shutdown();
    await site.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("declining the import review leaves the vault and inventory unchanged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "af-poc-import-"));
  const app = new CatashiroApp({ stateDir: dir, idleLockMs: 0 });
  try {
    await app.unlock(PASSPHRASE);
    const record = await saveImportedProfileValues(
      app.store,
      {
        origin: "https://example.test",
        siteId: "example.test",
        serviceName: "Example",
        candidates: [{ fieldId: "f-1", label: "メールアドレス", profileKey: "email", value: "declined@example.test", maskedValue: "de***@example.test" }],
      },
      { approved: false },
    );
    assert.equal(record, undefined);
    assert.equal(app.store.getValue("email"), undefined);
    assert.equal(app.store.listSiteRecords().length, 0);
  } finally {
    await app.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});

async function seedRegisteredAccount(siteUrl: string): Promise<void> {
  const res = await fetch(new URL("register", siteUrl), {
    method: "POST",
    body: new URLSearchParams({
      fullname: "既存 太郎",
      kana: "キソン タロウ",
      email: "existing@example.test",
      tel: "090-1111-2222",
      zip: "100-0001",
      address: "東京都千代田区1-1",
      company: "既存商事",
      department: "総務部",
      login_id: "existing-taro",
      password: "Existing-Passw0rd!",
    }),
  });
  assert.equal(res.status, 200);
}
