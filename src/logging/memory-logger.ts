// In-memory diagnostics log for the extension Side Panel (Issue #569). Same
// NDJSON line shape and redaction as `FileLogger`, but nothing is persisted:
// the buffer lives only as long as the panel and is capped by line count, so
// the Settings tab can export what happened in this panel session.

import type { LogFields, LogLevel, Logger } from "./logger.js";
import { redactFields, redactLogText } from "./redact.js";

const DEFAULT_MAX_LINES = 2000;

export class MemoryLogger implements Logger {
  private readonly lines: string[] = [];

  constructor(
    private readonly maxLines = DEFAULT_MAX_LINES,
    private readonly now: () => Date = () => new Date(),
  ) {}

  info(category: string, message: string, fields?: LogFields): void {
    this.write("info", category, message, fields);
  }

  warn(category: string, message: string, fields?: LogFields): void {
    this.write("warn", category, message, fields);
  }

  error(category: string, message: string, fields?: LogFields): void {
    this.write("error", category, message, fields);
  }

  /** The retained lines as newline-delimited JSON, oldest first. */
  read(): string {
    return this.lines.map((line) => `${line}\n`).join("");
  }

  private write(level: LogLevel, category: string, message: string, fields?: LogFields): void {
    try {
      // Reserved envelope keys are spread last so a caller field can never clobber them.
      const entry = {
        ...(fields ? redactFields(fields) : {}),
        at: this.now().toISOString(),
        level,
        category,
        message: redactLogText(message),
      };
      this.lines.push(JSON.stringify(entry));
      if (this.lines.length > this.maxLines) this.lines.splice(0, this.lines.length - this.maxLines);
    } catch {
      // Logging must never break the caller; a lost line is acceptable.
    }
  }
}
