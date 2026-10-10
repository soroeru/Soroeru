import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SoroeruSession } from "../../electron/session.js";
import { DomainService } from "../../src/domain/domain-service.js";
import { FileVaultPersistence } from "../../src/store/file-vault-persistence.js";
import { VaultV2 } from "../../src/store/vault-v2.js";
import type { PageDriver, SiteSession } from "../../src/automation/page-driver.js";
import type { FormField, PageSnapshot } from "../../src/types.js";

// Fake data only (docs/testing.md). Regression test for Issue #303's persistence
// fix: a Visibility run mutates the domain (disclosures, relationships,
// constraints, evidence) but VaultV2 keeps records only in memory until
// `save()` is called — so `runVisibility()` must flush to disk, or the
// collected ledger silently vanishes when the user locks or quits.
const PASSPHRASE = "visibility-persistence-passphrase";

const CSV = [
  "name,url,username,password,note",
  "Example,https://example.test/account,user@example.test,fake-pass,",
].join("\n");

test("runVisibility persists collected disclosures to disk, not just in memory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "soroeru-vis-persist-"));
  const path = join(dir, "vault.json");
  try {
    // An account page holding one email value. The field id "email" matches the
    // runner's username-field heuristic, so a login attempt does happen — but it
    // is a no-op against the fake driver (same snapshot again, no password
    // field), and collection proceeds over the page's value.
    const page = new FakePageDriver(
      [snapshot("https://example.test/account", [field("email", { autocomplete: "email", labels: ["メールアドレス"] })])],
      { email: "user@example.test" },
    );
    const session = new SoroeruSession(path, {
      openSession: () => Promise.resolve(new FakeSession(page)),
    });
    assert.equal((await session.setup(PASSPHRASE)).ok, true);
    const imported = await session.importCsv(CSV);
    assert.equal(imported.ok, true);
    const siteId = imported.summary?.siteAccountIds[0];
    assert.ok(siteId, "CSV import must yield a site account id");

    const run = await session.runVisibility(siteId);
    assert.equal(run.status, "collected");
    assert.ok(run.disclosures >= 1, "the fake account page must yield a disclosure");

    // Re-open the vault fresh from disk (a separate instance from the
    // session's in-memory one): the collected disclosure must be there.
    const reopened = await VaultV2.open(new FileVaultPersistence(path), PASSPHRASE);
    try {
      const domain = new DomainService(reopened);
      const disclosures = domain.listDisclosuresForSite(siteId);
      assert.ok(
        disclosures.length >= 1,
        "collected disclosures must survive a reload from disk (vault.save() after the run)",
      );
    } finally {
      reopened.lock();
    }
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
