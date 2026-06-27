import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainService } from "../../src/domain/domain-service.js";
import {
  CsvImportError,
  MAX_CSV_BYTES,
  MAX_CSV_ROWS,
  importPasswordCsv,
} from "../../src/domain/csv-import.js";
import { VaultV2 } from "../../src/store/vault-v2.js";

// Fake data only (docs/testing.md). Verifies RFC-002 §4.4 / §8.2 import safety.
const PASSPHRASE = "csv-import-test-passphrase";
const HEADER = "name,url,username,password,note";

async function tmpVaultPath(): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "soroeru-csv-"));
  return { dir, path: join(dir, "vault.json") };
}

async function withDomain(fn: (d: DomainService, v: VaultV2, path: string) => Promise<void>): Promise<void> {
  const { dir, path } = await tmpVaultPath();
  try {
    const vault = await VaultV2.open(path, PASSPHRASE);
    await fn(new DomainService(vault), vault, path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("seeds Site Account and Credential records from a valid CSV", async () => {
  await withDomain(async (domain) => {
    const csv = [
      HEADER,
      "Example,https://www.example.com/login,alice@example.test,s3cret-pw,personal",
      "Shop,https://shop.example.test,alice2,hunter2,",
    ].join("\n");

    const summary = importPasswordCsv(domain, { data: csv });
    assert.equal(summary.totalDataRows, 2);
    assert.equal(summary.importedCredentials, 2);
    assert.equal(summary.sitesCreated, 2);
    assert.equal(summary.skipped, 0);
    assert.equal(summary.recommendSourceDeletion, true);

    // www. stripped, host lowercased.
    const domains = domain.listSiteAccounts().map((s) => s.domain).sort();
    assert.deepEqual(domains, ["example.com", "shop.example.test"]);

    const site = domain.listSiteAccounts().find((s) => s.domain === "example.com");
    assert.ok(site);
    const creds = domain.listCredentialsForSite(site.id);
    assert.equal(creds.length, 1);
    assert.equal(creds[0]?.username, "alice@example.test");
    assert.equal(creds[0]?.password, "s3cret-pw");
    assert.equal(creds[0]?.note, "personal");
    assert.equal(creds[0]?.source, "csv-import");
  });
});

test("the result summary leaks no raw username / password / note", async () => {
  await withDomain(async (domain) => {
    const csv = [HEADER, "Bank,https://bank.example.test,bob,TopSecretPw,memo-note"].join("\n");
    const summary = importPasswordCsv(domain, { data: csv });
    const serialized = JSON.stringify(summary);
    assert.equal(serialized.includes("TopSecretPw"), false);
    assert.equal(serialized.includes("bob"), false);
    assert.equal(serialized.includes("memo-note"), false);
  });
});

test("credentials are encrypted at rest (no plaintext password on disk)", async () => {
  await withDomain(async (domain, vault, path) => {
    const csv = [HEADER, "Mail,https://mail.example.test,carol,Pl4inTextPw,note"].join("\n");
    importPasswordCsv(domain, { data: csv });
    await vault.save();

    const onDisk = await readFile(path, "utf8");
    assert.equal(onDisk.includes("Pl4inTextPw"), false);
    assert.equal(onDisk.includes("carol"), false);

    // Reopening decrypts the seeded credential.
    const reopened = await VaultV2.open(path, PASSPHRASE);
    const d2 = new DomainService(reopened);
    const site = d2.listSiteAccounts().find((s) => s.domain === "mail.example.test");
    assert.ok(site);
    assert.equal(d2.listCredentialsForSite(site.id)[0]?.password, "Pl4inTextPw");
  });
});

test("re-importing the same CSV is idempotent (no duplicate credentials)", async () => {
  await withDomain(async (domain) => {
    const csv = [HEADER, "Example,https://example.test,alice,pw1,"].join("\n");
    const first = importPasswordCsv(domain, { data: csv });
    assert.equal(first.importedCredentials, 1);
    assert.equal(first.sitesCreated, 1);

    const second = importPasswordCsv(domain, { data: csv });
    assert.equal(second.importedCredentials, 0);
    assert.equal(second.sitesCreated, 0);
    assert.equal(second.sitesMatched, 1);
    assert.equal(second.skipped, 1);
    assert.equal(domain.listSiteAccounts().length, 1);
  });
});

test("zeroes a passed Uint8Array buffer after parsing", async () => {
  await withDomain(async (domain) => {
    const csv = [HEADER, "Example,https://example.test,alice,pw1,"].join("\n");
    const buffer = new TextEncoder().encode(csv);
    importPasswordCsv(domain, { data: buffer });
    assert.ok(buffer.every((b) => b === 0), "raw CSV buffer must be zeroed after import");
  });
});

test("skips rows with unparseable or single-label URLs", async () => {
  await withDomain(async (domain) => {
    const csv = [
      HEADER,
      "Bad,not a url,alice,pw,",
      "Local,http://localhost,bob,pw,",
      "Good,https://ok.example.test,carol,pw,",
    ].join("\n");
    const summary = importPasswordCsv(domain, { data: csv });
    assert.equal(summary.importedCredentials, 1);
    assert.equal(summary.skipped, 2);
  });
});

test("rejects an oversize CSV before importing", async () => {
  await withDomain(async (domain) => {
    const big = new Uint8Array(MAX_CSV_BYTES + 1);
    assert.throws(
      () => importPasswordCsv(domain, { data: big }),
      (err) => err instanceof CsvImportError && err.reason === "too-large",
    );
    assert.equal(domain.listSiteAccounts().length, 0);
  });
});

test("rejects a CSV with too many rows before importing", async () => {
  await withDomain(async (domain) => {
    const lines = [HEADER];
    for (let i = 0; i < MAX_CSV_ROWS + 1; i++) {
      lines.push(`Site${i},https://s${i}.example.test,u${i},p${i},`);
    }
    assert.throws(
      () => importPasswordCsv(domain, { data: lines.join("\n") }),
      (err) => err instanceof CsvImportError && err.reason === "too-many-rows",
    );
    // Nothing imported: row count is validated before any write.
    assert.equal(domain.listSiteAccounts().length, 0);
  });
});

test("parses quoted fields: embedded commas, escaped quotes, multi-line notes", async () => {
  await withDomain(async (domain) => {
    const csv = [
      HEADER,
      // password contains a comma; note is multi-line and contains an escaped quote.
      'Example,https://example.test,alice,"pw,with,commas","line one\nline ""two"""',
    ].join("\n");

    const summary = importPasswordCsv(domain, { data: csv });
    assert.equal(summary.importedCredentials, 1);

    const site = domain.listSiteAccounts().find((s) => s.domain === "example.test");
    assert.ok(site);
    const cred = domain.listCredentialsForSite(site.id)[0];
    assert.equal(cred?.password, "pw,with,commas");
    assert.equal(cred?.note, 'line one\nline "two"');
  });
});

test("treats a double-quote mid unquoted field as a literal", async () => {
  await withDomain(async (domain) => {
    const csv = [HEADER, 'Example,https://example.test,alice,5" pw,'].join("\n");
    const summary = importPasswordCsv(domain, { data: csv });
    assert.equal(summary.importedCredentials, 1);
    const site = domain.listSiteAccounts().find((s) => s.domain === "example.test");
    assert.ok(site);
    assert.equal(domain.listCredentialsForSite(site.id)[0]?.password, '5" pw');
  });
});

test("dedups a duplicate (site, username) row within a single import", async () => {
  await withDomain(async (domain) => {
    const csv = [
      HEADER,
      "Example,https://example.test,alice,pw1,",
      "Example,https://example.test,alice,pw1,",
    ].join("\n");
    const summary = importPasswordCsv(domain, { data: csv });
    assert.equal(summary.importedCredentials, 1);
    assert.equal(summary.skipped, 1);
    const site = domain.listSiteAccounts().find((s) => s.domain === "example.test");
    assert.ok(site);
    assert.equal(domain.listCredentialsForSite(site.id).length, 1);
  });
});

test("preserves a note containing an unquoted comma (extra columns rejoined)", async () => {
  await withDomain(async (domain) => {
    const csv = [HEADER, "Example,https://example.test,alice,pw,part one,part two"].join("\n");
    const summary = importPasswordCsv(domain, { data: csv });
    assert.equal(summary.importedCredentials, 1);
    const site = domain.listSiteAccounts().find((s) => s.domain === "example.test");
    assert.ok(site);
    assert.equal(domain.listCredentialsForSite(site.id)[0]?.note, "part one,part two");
  });
});

test("accepts a UTF-8 BOM-prefixed header (Windows export)", async () => {
  await withDomain(async (domain) => {
    const csv = "﻿" + [HEADER, "Example,https://example.test,alice,pw,"].join("\n");
    const summary = importPasswordCsv(domain, { data: csv });
    assert.equal(summary.importedCredentials, 1);
    assert.equal(summary.sitesCreated, 1);
  });
});

test("rejects an empty CSV with the 'empty' reason", async () => {
  await withDomain(async (domain) => {
    assert.throws(
      () => importPasswordCsv(domain, { data: "   \n" }),
      (err) => err instanceof CsvImportError && err.reason === "empty",
    );
  });
});

test("rejects a CSV with the wrong header", async () => {
  await withDomain(async (domain) => {
    const csv = ["url,login,secret", "https://example.test,alice,pw"].join("\n");
    assert.throws(
      () => importPasswordCsv(domain, { data: csv }),
      (err) => err instanceof CsvImportError && err.reason === "bad-header",
    );
  });
});
