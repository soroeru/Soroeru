// FileLogger (Issue #314): the trusted main-process log sink. Writes newline-
// delimited JSON to a plain-text local file so the app can hand the user a
// downloadable diagnostics log (Settings tab) and so future debugging work can
// read it directly. MVP-scoped: unencrypted by design (the Issue's explicit
// trade-off — this carries operational/structural facts, never personal
// data), single-file with one-generation size rotation, synchronous writes
// (log volume is event-driven — logins, imports, runs — not per-frame).
//
// A redaction pass runs over every message/field string as defense-in-depth:
// callers are expected to never pass raw personal values (see logger.ts), but
// this catches an accidental email/card-number/API-key-shaped substring before
// it reaches disk. Never throws: a logging failure must not break the caller.

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { LogFields, LogLevel, Logger } from "./logger.js";

/** Rotate once the active file would exceed this size; keeps one prior generation. */
const MAX_LOG_BYTES = 5 * 1024 * 1024;

/** Same shape of secret-looking substrings redacted from the legacy support-bundle export (src/app/diagnostics.ts). */
const SECRETISH =
  /([A-Z2-7]{4}-){4,}|sk-[A-Za-z0-9_-]+|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|\b(?:\d[ -]?){12,19}\b|\b(?:\d{2,4}-?\d{3,4}-?\d{4})\b/g;

export function redactLogText(value: string): string {
  return value.replace(SECRETISH, "[redacted]");
}

function redactFields(fields: LogFields | undefined): LogFields | undefined {
  if (!fields) return undefined;
  const redacted: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    redacted[key] = typeof value === "string" ? redactLogText(value) : value;
  }
  return redacted;
}

export class FileLogger implements Logger {
  private ensuredDir = false;

  constructor(private readonly filePath: string) {}

  info(category: string, message: string, fields?: LogFields): void {
    this.write("info", category, message, fields);
  }

  warn(category: string, message: string, fields?: LogFields): void {
    this.write("warn", category, message, fields);
  }

  error(category: string, message: string, fields?: LogFields): void {
    this.write("error", category, message, fields);
  }

  /** Prior generation (if rotated) followed by the current file's contents, oldest first. */
  async read(): Promise<string> {
    const previousPath = `${this.filePath}.1`;
    const parts: string[] = [];
    for (const path of [previousPath, this.filePath]) {
      try {
        parts.push(await readFile(path, "utf8"));
      } catch {
        // Missing file (not yet created, or never rotated) — nothing to add.
      }
    }
    return parts.join("");
  }

  private write(level: LogLevel, category: string, message: string, fields?: LogFields): void {
    try {
      this.ensureDirSync();
      this.rotateIfNeeded();
      // Reserved envelope keys are spread last so a caller-supplied field
      // (e.g. one literally named "level") can never clobber them.
      const entry = {
        ...(fields ? redactFields(fields) : {}),
        at: new Date().toISOString(),
        level,
        category,
        message: redactLogText(message),
      };
      // persist: diagnostics-log
      appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, "utf8");
    } catch {
      // Logging must never crash the caller; a lost log line is acceptable.
    }
  }

  private ensureDirSync(): void {
    if (this.ensuredDir) return;
    this.ensuredDir = true;
    mkdirSync(dirname(this.filePath), { recursive: true });
  }

  private rotateIfNeeded(): void {
    if (!existsSync(this.filePath)) return;
    const { size } = statSync(this.filePath);
    if (size < MAX_LOG_BYTES) return;
    try {
      renameSync(this.filePath, `${this.filePath}.1`);
    } catch {
      // Best-effort rotation; if it fails the file just keeps growing this run.
    }
  }
}
