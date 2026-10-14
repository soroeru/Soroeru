// Core CSV importer (RFC-002 §4.4 / §5.1 / §6): parse a Google / Chrome Password
// Manager export entirely locally and seed Vault v2 with Site Account and
// (encrypted) Credential records. This module is UI-independent so the
// Visibility runner (#159) and the import UI (#160) share one safe path.
//
// Safety invariants (RFC-002 §8.2):
//   - Parse locally only; no network, no disk writes here (the vault owns
//     persistence and encrypts every credential at rest).
//   - Validate byte size and row count BEFORE importing anything.
//   - Never log username / password / note (this module has no logging at all).
//   - Discard the raw CSV byte buffer after parsing: a passed Uint8Array is
//     zeroed. (Decoded strings and the vault's in-memory plaintext still hold
//     the values — V8 strings cannot be wiped — so this scopes only to the raw
//     buffer; values are never logged or re-exported.)
//   - Never re-export plaintext credentials; the result is counts only.
//   - Recommend (never perform) deletion of the user's source CSV file.

import type { DomainService } from "./domain-service.js";

/** Hard cap on the raw CSV size; a personal password export is far smaller. */
export const MAX_CSV_BYTES = 5 * 1024 * 1024;

/** Hard cap on data rows, validated before any record is written. */
export const MAX_CSV_ROWS = 10_000;

/** Fixed Google / Chrome Password Manager export header, in order. */
const EXPECTED_HEADERS = ["name", "url", "username", "password", "note"] as const;

export type CsvImportErrorReason = "too-large" | "too-many-rows" | "empty" | "bad-header";

export class CsvImportError extends Error {
  constructor(
    readonly reason: CsvImportErrorReason,
    message: string,
  ) {
    super(message);
    this.name = "CsvImportError";
  }
}

/** Counts only — never any raw username / password / note value. */
export interface CsvImportSummary {
  totalDataRows: number;
  importedCredentials: number;
  sitesCreated: number;
  sitesMatched: number;
  skipped: number;
  siteAccountIds: string[];
  /** The UI should prompt the user to delete their source CSV; it must not auto-delete. */
  recommendSourceDeletion: boolean;
}

export interface CsvImportInput {
  /** Raw CSV as text or bytes. A passed Uint8Array is zeroed after parsing. */
  data: string | Uint8Array;
}

/**
 * Import a password-manager CSV into the vault via the DomainService. Throws
 * `CsvImportError` for oversize / malformed input; otherwise returns a
 * sanitized summary. The caller must `vault.save()` to persist.
 */
export function importPasswordCsv(domain: DomainService, input: CsvImportInput): CsvImportSummary {
  // 1. Validate byte size before doing anything else.
  const byteLength =
    typeof input.data === "string" ? new TextEncoder().encode(input.data).byteLength : input.data.byteLength;
  if (byteLength > MAX_CSV_BYTES) {
    if (input.data instanceof Uint8Array) input.data.fill(0);
    throw new CsvImportError("too-large", `CSV exceeds the ${MAX_CSV_BYTES}-byte limit`);
  }

  // 2. Decode to text, then discard the raw byte buffer.
  let csvText: string;
  if (typeof input.data === "string") {
    csvText = input.data;
  } else {
    // ignoreBOM keeps a leading BOM in the text; the header check below strips it.
    csvText = new TextDecoder("utf-8", { ignoreBOM: true }).decode(input.data);
    input.data.fill(0); // best-effort: do not leave plaintext credentials in the buffer
  }

  try {
    // Detect emptiness explicitly so the caller gets an accurate reason (the
    // parser always yields at least one row, so a row-count check cannot).
    if (csvText.trim() === "") throw new CsvImportError("empty", "CSV is empty");

    const rows = parseCsv(csvText);
    const headers = [...(rows[0] ?? [])];
    if (headers[0]?.startsWith("﻿")) headers[0] = headers[0].slice(1);
    if (headers.join(",") !== EXPECTED_HEADERS.join(",")) {
      throw new CsvImportError(
        "bad-header",
        'CSV header must be "name,url,username,password,note"',
      );
    }

    const dataRows = rows.slice(1).filter((cols) => !(cols.length === 1 && cols[0] === ""));

    // 3. Validate row count before importing any record.
    if (dataRows.length > MAX_CSV_ROWS) {
      throw new CsvImportError("too-many-rows", `CSV exceeds the ${MAX_CSV_ROWS}-row limit`);
    }

    return importRows(domain, dataRows);
  } finally {
    // 4. Drop our reference to the decoded text. (V8 cannot be forced to wipe an
    //    immutable string, but we keep no other copy and never log it.)
    csvText = "";
    void csvText;
  }
}

function importRows(domain: DomainService, dataRows: string[][]): CsvImportSummary {
  const summary: CsvImportSummary = {
    totalDataRows: dataRows.length,
    importedCredentials: 0,
    sitesCreated: 0,
    sitesMatched: 0,
    skipped: 0,
    siteAccountIds: [],
    recommendSourceDeletion: true,
  };

  // Cache existing sites by domain so repeated imports stay idempotent.
  const sitesByDomain = new Map<string, string>();
  for (const site of domain.listSiteAccounts()) sitesByDomain.set(site.domain, site.id);
  const seededIds = new Set<string>();

  // Seen (siteId, username) pairs, primed from the vault, so credential dedup is
  // O(1) per row instead of re-scanning the credential table each iteration.
  const credentialKey = (siteId: string, username: string): string => `${siteId}\u0000${username}`;
  const seenCredentials = new Set<string>();
  for (const siteId of sitesByDomain.values()) {
    for (const cred of domain.listCredentialsForSite(siteId)) {
      seenCredentials.add(credentialKey(siteId, cred.username));
    }
  }

  for (const cols of dataRows) {
    if (cols.length < EXPECTED_HEADERS.length) {
      summary.skipped++;
      continue;
    }
    const [name, rawUrl, username, password] = cols as [string, string, string, string];
    // A non-Chrome / hand-edited export may leave an unquoted comma in `note`,
    // producing extra columns; rejoin them so the note is preserved, not truncated.
    const note = cols.slice(4).join(",");

    const parsed = normalizeSiteUrl(rawUrl);
    if (!parsed) {
      summary.skipped++;
      continue;
    }

    let siteId = sitesByDomain.get(parsed.domain);
    if (siteId === undefined) {
      const account = domain.upsertSiteAccount({
        domain: parsed.domain,
        url: parsed.anchor,
        displayName: name || parsed.domain,
      });
      siteId = account.id;
      sitesByDomain.set(parsed.domain, siteId);
      summary.sitesCreated++;
    } else if (!seededIds.has(siteId)) {
      summary.sitesMatched++;
    }
    if (!seededIds.has(siteId)) {
      seededIds.add(siteId);
      summary.siteAccountIds.push(siteId);
    }

    // Seed-only dedup: skip a credential we already hold for this
    // (site, username) pair — including a duplicate row earlier in this same
    // file. We intentionally do NOT update an existing credential's password
    // here; refreshing rotated secrets is the Bulk Update slice's job.
    const key = credentialKey(siteId, username);
    if (seenCredentials.has(key)) {
      summary.skipped++;
      continue;
    }
    seenCredentials.add(key);

    const credentialInput: Parameters<DomainService["addCredential"]>[0] = {
      siteAccountId: siteId,
      username,
      password,
      source: "csv-import",
    };
    if (note) credentialInput.note = note;
    domain.addCredential(credentialInput);
    summary.importedCredentials++;
  }

  return summary;
}

/** Lowercase host with a leading `www.` stripped; returns the login anchor URL too. */
function normalizeSiteUrl(rawUrl: string): { domain: string; anchor: string } | undefined {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) return undefined;
  let url: URL;
  try {
    // egress: target-site — defaulting the scheme for the site URL from the CSV entry (no network call)
    const withScheme = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
    url = new URL(withScheme);
  } catch {
    return undefined;
  }
  // Soroeru collects from websites only. Password-manager exports also carry
  // non-web credentials (e.g. Android apps as `android://<hash>@<package>`);
  // reject any non-http(s) scheme so they are skipped, not mis-imported as a
  // site that can only ever be "unreachable".
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  const host = url.hostname.toLowerCase();
  // Password-manager exports carry real domains; reject bare single-label hosts.
  if (!host.includes(".")) return undefined;
  const domain = host.replace(/^www\./, "");
  return { domain, anchor: url.href };
}

/** Minimal RFC-4180-ish CSV parser: handles quoted commas, escaped quotes, CR/LF. */
function parseCsv(csvText: string): string[][] {
  const rows: string[][] = [];
  let fields: string[] = [];
  let current = "";
  let inQuotes = false;

  const finishField = (): void => {
    fields.push(current);
    current = "";
  };
  const finishRow = (): void => {
    finishField();
    rows.push(fields);
    fields = [];
  };

  for (let i = 0; i < csvText.length; i++) {
    const ch = csvText[i] as string;
    if (inQuotes) {
      if (ch === '"') {
        if (csvText[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"' && current === "") {
      // A double-quote is special only at the start of a field (RFC 4180);
      // anywhere else it is a literal character.
      inQuotes = true;
    } else if (ch === ",") {
      finishField();
    } else if (ch === "\n") {
      finishRow();
    } else if (ch === "\r") {
      if (csvText[i + 1] === "\n") i++;
      finishRow();
    } else {
      current += ch;
    }
  }
  if (current !== "" || fields.length > 0 || csvText.length === 0) finishRow();
  return rows;
}
