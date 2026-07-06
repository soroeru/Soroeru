import assert from "node:assert/strict";
import { test } from "node:test";
import { registerCrashLogging, type ProcessLike } from "../../electron/crash-logging.js";
import type { LogFields, LogLevel } from "../../src/logging/logger.js";

// Fake data only (docs/testing.md). Verifies Issue #314's crash-logging seam:
// a fatal main-process error is logged, and — since registering an
// uncaughtException/unhandledRejection listener suppresses Node's own
// terminate-on-fatal-error default — the process must still be made to exit
// explicitly rather than silently keep running in a possibly inconsistent
// state (the local AI review's Finding 1).

interface RecordedLogCall {
  level: LogLevel;
  category: string;
  message: string;
  fields: LogFields | undefined;
}

function fakeProcess(): {
  proc: ProcessLike;
  emit: { uncaughtException: (err: Error) => void; unhandledRejection: (reason: unknown) => void };
  exits: number[];
} {
  const listeners: {
    uncaughtException?: (err: Error) => void;
    unhandledRejection?: (reason: unknown) => void;
  } = {};
  const exits: number[] = [];
  const proc: ProcessLike = {
    on: (event, listener) => {
      if (event === "uncaughtException") listeners.uncaughtException = listener as (err: Error) => void;
      if (event === "unhandledRejection")
        listeners.unhandledRejection = listener as (reason: unknown) => void;
    },
    exit: (code: number): never => {
      exits.push(code);
      throw new Error(`process.exit(${code}) called`);
    },
  };
  return {
    proc,
    exits,
    emit: {
      uncaughtException: (err) => listeners.uncaughtException?.(err),
      unhandledRejection: (reason) => listeners.unhandledRejection?.(reason),
    },
  };
}

test("logs an uncaught exception and terminates the process (does not silently keep running)", () => {
  const { proc, emit, exits } = fakeProcess();
  const calls: RecordedLogCall[] = [];
  registerCrashLogging(
    { log: (level, category, message, fields) => calls.push({ level, category, message, fields }) },
    proc,
  );

  assert.throws(() => emit.uncaughtException(new Error("boom")));

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.level, "error");
  assert.equal(calls[0]?.category, "app");
  assert.equal(calls[0]?.message, "uncaught exception");
  assert.equal(calls[0]?.fields?.["message"], "boom");
  assert.deepEqual(exits, [1]);
});

test("logs an unhandled rejection (including a non-Error reason) and terminates the process", () => {
  const { proc, emit, exits } = fakeProcess();
  const calls: RecordedLogCall[] = [];
  registerCrashLogging(
    { log: (level, category, message, fields) => calls.push({ level, category, message, fields }) },
    proc,
  );

  assert.throws(() => emit.unhandledRejection("plain string rejection"));

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.message, "unhandled rejection");
  assert.equal(calls[0]?.fields?.["message"], "plain string rejection");
  assert.deepEqual(exits, [1]);
});
