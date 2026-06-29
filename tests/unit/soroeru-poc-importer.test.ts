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
import { SoroeruApp } from "../../src/app/app.js";
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
  const app = new SoroeruApp({ stateDir: dir, idleLockMs: 0 });
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
  const app = new SoroeruApp({ stateDir: dir, idleLockMs: 0 });
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

test("review-before-save: accepting with edits updates the store and returns a site record", async () => {
  const dir = await mkdtemp(join(tmpdir(), "af-poc-import-review-"));
  const app = new SoroeruApp({ stateDir: dir, idleLockMs: 0 });
  try {
    await app.unlock(PASSPHRASE);
    const importResult = {
      origin: "https://review.example.test",
      siteId: "review.example.test",
      serviceName: "Review テストサービス",
      candidates: [
        { fieldId: "c-1", label: "氏名", profileKey: "name.full" as const, value: "レビュー 太郎", maskedValue: "レビュー ***" },
        { fieldId: "c-2", label: "メールアドレス", profileKey: "email" as const, value: "review@example.test", maskedValue: "re***@example.test" },
        { fieldId: "c-3", label: "電話番号", profileKey: "phone.full" as const, value: "090-0000-0001", maskedValue: "090-****-0001" },
      ],
    };

    // User edits the phone number before saving
    const record = await saveImportedProfileValues(app.store, importResult, {
      approved: true,
      edits: { "c-3": "090-9999-9999" },
    });

    assert.ok(record, "record must be created on approval");
    assert.equal(app.store.getValue("name.full"), "レビュー 太郎");
    assert.equal(app.store.getValue("email"), "review@example.test");
    assert.equal(app.store.getValue("phone.full"), "090-9999-9999", "edited value must override imported value");
    assert.equal(record.accountState, "imported");
    assert.equal(record.filledFields.length, 3);
    // Site record must not store raw values
    assert.ok(!JSON.stringify(app.store.listSiteRecords()).includes("review@example.test"));
  } finally {
    await app.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});

test("review-before-save: accepting without edits stores all candidates as-is", async () => {
  const dir = await mkdtemp(join(tmpdir(), "af-poc-import-noedits-"));
  const app = new SoroeruApp({ stateDir: dir, idleLockMs: 0 });
  try {
    await app.unlock(PASSPHRASE);
    const importResult = {
      origin: "https://noedits.example.test",
      siteId: "noedits.example.test",
      serviceName: "NoEdits テストサービス",
      candidates: [
        { fieldId: "n-1", label: "メールアドレス", profileKey: "email" as const, value: "noedits@example.test", maskedValue: "no***@example.test" },
      ],
    };

    const record = await saveImportedProfileValues(app.store, importResult, { approved: true });
    assert.ok(record);
    assert.equal(app.store.getValue("email"), "noedits@example.test");
    assert.equal(record.filledFields.length, 1);
  } finally {
    await app.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});

test("import from account settings page: readonly inputs are excluded by the scanner and yield no candidates", async () => {
  // The scanner (scan.ts) intentionally skips readonly inputs so the agent
  // never tries to fill them. The /account fixture renders pre-populated
  // readonly inputs, so collectImportCandidates returns an empty list.
  // Users who want to import should navigate to the /edit page instead.
  const dir = await mkdtemp(join(tmpdir(), "af-poc-import-account-"));
  const site = await startPocServer();
  const browser = await chromium.launch({ headless: true });
  const app = new SoroeruApp({ stateDir: dir, idleLockMs: 0 });
  try {
    await app.unlock(PASSPHRASE);
    await seedRegisteredAccount(site.siteUrl("01-basic"));
    const browserPage = await browser.newPage();
    const mapper = new SpyMapper();
    const runner = new AppRunner(app, mapper);

    const result = await runner.importExistingAccount(browserPage, `${site.siteUrl("01-basic")}account`);
    assert.equal(result.siteId, new URL(site.url).host);
    // Readonly inputs are not editable, so the scanner skips them → no candidates
    assert.equal(result.candidates.length, 0, "readonly inputs must not produce import candidates");
    // The mapper must still have seen the structural snapshot (not the raw values)
    assert.equal(mapper.snapshots.length, 1);
    assert.ok(!JSON.stringify(mapper.snapshots[0]).includes("existing@example.test"));
  } finally {
    await browser.close();
    await app.shutdown();
    await site.close();
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
