// Google Password Manager CSV importer (REQ-018).
//
// Parses the CSV exported from Google Password Manager and bulk-imports
// each entry into the encrypted store as an `imported` site record.
//
// Credentials (username / password) are intentionally NOT written to the global
// profile keys here: Google exports per-site credentials, but `account.id` and
// `account.password` are single global fields — saving N rows would silently
// discard all but the last. Per-site credential storage is out of scope for this
// import; the site records themselves (accountState: "imported") are the value.
//
// The CSV itself is never written to disk; the caller must call store.save() after
// this function returns to persist the changes.

import type { PocStore } from "../store/store.js";
import { nextActionForAccountState } from "./records.js";

export interface ChromeCsvImportResult {
  imported: number;
  skipped: number;
  siteIds: string[];
}

/**
 * Expected header row for Google Password Manager exports.
 * The order is fixed; any other format is rejected.
 */
const EXPECTED_HEADERS = ["name", "url", "username", "password", "note"];

/**
 * Parse and import a Google Password Manager CSV export into the encrypted store.
 *
 * - Entries with unparseable URLs are skipped.
 * - Duplicate origins keep only the first entry encountered.
 * - store.save() is NOT called here; the caller is responsible for persisting.
 */
export function importChromeCsv(
  csvText: string,
  store: PocStore,
  now?: number,
): ChromeCsvImportResult {
  const ts = now ?? Date.now();
  const rows = parseCsv(csvText);
  if (rows.length === 0) return { imported: 0, skipped: 0, siteIds: [] };

  const headers = rows[0] ?? [];
  if (headers[0]?.startsWith("\ufeff")) headers[0] = headers[0].slice(1);
  if (headers.join(",") !== EXPECTED_HEADERS.join(",")) {
    throw new Error(
      `Google Passwords.csv ヘッダーが不正です。"name,url,username,password,note" の形式でエクスポートしてください。`
    );
  }

  let imported = 0;
  let skipped = 0;
  const siteIds: string[] = [];
  const seenOrigins = new Set<string>();

  for (let i = 1; i < rows.length; i++) {
    const cols = rows[i] ?? [];
    if (cols.length === 1 && cols[0] === "") continue;
    if (cols.length < 5) {
      skipped++;
      continue;
    }

    const [name, rawUrl] = cols as [string, string, string, string, string];

    let parsedUrl: URL;
    try {
      // egress: target-site — defaulting scheme for the site URL from the CSV entry
      const normalized = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
      parsedUrl = new URL(normalized);
    } catch {
      skipped++;
      continue;
    }
    // Reject bare-word hostnames with no dot — Google Password Manager exports real domain names.
    if (!parsedUrl.hostname.includes(".")) {
      skipped++;
      continue;
    }

    const origin = parsedUrl.origin;
    if (seenOrigins.has(origin)) {
      skipped++;
      continue;
    }
    seenOrigins.add(origin);

    const siteId = parsedUrl.host;

    // Skip if a record already exists — do not overwrite accountState,
    // filledFields, or mandates that the user built via normal registration.
    if (store.getSiteRecord(siteId)) {
      skipped++;
      continue;
    }

    const serviceName = name || parsedUrl.host.replace(/^www\./, "");

    store.upsertSiteRecord({
      origin,
      siteId,
      serviceName,
      registeredAt: ts,
      filledFields: [],
      accountState: "imported",
      status: "registered",
      lastCheckedAt: ts,
      nextAction: nextActionForAccountState("imported"),
    });

    // Credentials are intentionally not saved — see module-level comment.

    imported++;
    siteIds.push(siteId);
  }

  return { imported, skipped, siteIds };
}

/** Parse CSV rows, handling quoted commas, quotes, CRLFs, and newlines inside quoted fields. */
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
    const ch = csvText[i]!;
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
    } else if (ch === '"') {
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
