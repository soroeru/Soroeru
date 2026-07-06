// Forward otherwise-fatal main-process errors to the diagnostics log (Issue
// #314) before the process actually terminates, so a packaged-app crash
// leaves a plain-text trail the user can attach to a bug report.
//
// Node/Electron's default behavior for an unhandled `uncaughtException` /
// `unhandledRejection` is to terminate the process; registering a listener
// for either event *suppresses* that default (the process would otherwise
// keep running, possibly mid-vault-write). This module preserves the
// original "log then terminate" behavior explicitly via `proc.exit(1)` rather
// than silently trading crash-safety for a log line.
//
// Framework-free (no `electron` import) and decoupled from `SoroeruSession`
// (only the narrow `log` method it needs) so it is unit-testable with a fake
// `proc` and a fake logging target, without booting Electron or a vault.

import type { LogFields, LogLevel } from "../src/logging/logger.js";

export interface LoggingTarget {
  log(level: LogLevel, category: string, message: string, fields?: LogFields): void;
}

/** The narrow slice of `NodeJS.Process` this module needs, so tests can inject a fake. */
export interface ProcessLike {
  on(event: "uncaughtException", listener: (err: Error) => void): void;
  on(event: "unhandledRejection", listener: (reason: unknown) => void): void;
  exit(code: number): never;
}

export function registerCrashLogging(
  target: LoggingTarget,
  proc: ProcessLike = process as ProcessLike,
): void {
  proc.on("uncaughtException", (err) => {
    target.log("error", "app", "uncaught exception", { message: err.message });
    proc.exit(1);
  });
  proc.on("unhandledRejection", (reason) => {
    target.log("error", "app", "unhandled rejection", {
      message: reason instanceof Error ? reason.message : String(reason),
    });
    proc.exit(1);
  });
}
