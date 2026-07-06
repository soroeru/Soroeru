// Structured app-diagnostics logging seam (Issue #314). This is deliberately
// separate from the encrypted vault: it exists so the user can attach a
// plain-text log to a bug report and so an AI/human debugging Soroeru can read
// it directly as a file, without touching vault data. Callers must never pass
// a raw personal value (canonical attribute, disclosure, credential, card
// data, passphrase, recovery key, storageState) through `fields` — only
// structural facts (site domain, status/reason codes, counts). `FileLogger`
// (./file-logger.ts) applies a redaction pass as defense-in-depth, but that is
// a safety net, not a license to log values on purpose.

export type LogLevel = "info" | "warn" | "error";

export type LogFieldValue = string | number | boolean | undefined;
export type LogFields = Record<string, LogFieldValue>;

export interface Logger {
  info(category: string, message: string, fields?: LogFields): void;
  warn(category: string, message: string, fields?: LogFields): void;
  error(category: string, message: string, fields?: LogFields): void;
}

/** Default for callers that do not opt into file-backed logging (e.g. most unit tests). */
export const noopLogger: Logger = {
  info() {},
  warn() {},
  error() {},
};
