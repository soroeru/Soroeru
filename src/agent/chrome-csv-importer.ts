// Chrome Password Manager CSV importer (REQ-018).
//
// Parses the CSV exported from Chrome's built-in password manager and bulk-imports
// each entry into the encrypted store as an `imported` site record. Credentials
// (loginId / password) are saved as profile values in the encrypted store.
//
// The CSV itself is never written to disk; the caller must call store.save() after
// this function returns to persist the changes.

import type { PocStore } from "../store/store.js";
import { nextActionForAccountState } from "./records.js";

export interface ChromeCsvImportResult {
  imported: number;
  skipped: number;
}

/**
 * Expected header row for Chrome Password Manager exports.
 * The order is fixed; any other format is rejected.
 */
const EXPECTED_HEADERS = ["name", "url", "username", "password"];

/**
 * Parse and import a Chrome Password Manager CSV export into the encrypted store.
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
  const lines = csvText.split(/\r?\n/);
  if (lines.length === 0) return { imported: 0, skipped: 0 };

  const headerLine = lines[0]?.trim() ?? "";
  const headers = parseRow(headerLine);
  if (headers.join(",") !== EXPECTED_HEADERS.join(",")) {
    throw new Error(
      `ChromeCSV ヘッダーが不正です。"name,url,username,password" の形式でエクスポートしてください。`
    );
  }

  let imported = 0;
  let skipped = 0;
  const seenOrigins = new Set<string>();

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;

    const cols = parseRow(line);
    if (cols.length < 4) {
      skipped++;
      continue;
    }

    const [name, rawUrl, username, password] = cols as [string, string, string, string];

    let parsedUrl: URL;
    try {
      // egress: target-site — defaulting scheme for the site URL from the CSV entry
      const normalized = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
      parsedUrl = new URL(normalized);
    } catch {
      skipped++;
      continue;
    }
    // Reject bare-word hostnames with no dot — Chrome always exports real domain names.
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

    if (username) {
      store.setProfileValue("account.id", "ログインID", username);
    }
    if (password) {
      store.setProfileValue("account.password", "パスワード", password);
    }

    imported++;
  }

  return { imported, skipped };
}

/** Split a single CSV row, handling double-quoted fields with internal commas/quotes. */
function parseRow(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
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
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}
