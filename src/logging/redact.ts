// Browser-safe redaction shared by the file and in-memory diagnostics loggers
// (Issue #314, #569). Defense-in-depth only: callers must never log raw values.

import type { LogFields } from "./logger.js";

/** Same shape of secret-looking substrings redacted from the legacy support-bundle export (src/app/diagnostics.ts). */
const SECRETISH =
  /([A-Z2-7]{4}-){4,}|sk-[A-Za-z0-9_-]+|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|\b(?:\d[ -]?){12,19}\b|\b(?:\d{2,4}-?\d{3,4}-?\d{4})\b/g;

export function redactLogText(value: string): string {
  return value.replace(SECRETISH, "[redacted]");
}

export function redactFields(fields: LogFields | undefined): LogFields | undefined {
  if (!fields) return undefined;
  const redacted: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    redacted[key] = typeof value === "string" ? redactLogText(value) : value;
  }
  return redacted;
}
