import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { FileLogger, redactLogText } from "../../src/logging/file-logger.js";

// Fake data only (docs/testing.md). Verifies the Issue #314 diagnostics log
// sink: structured JSONL entries, defense-in-depth redaction of secret-shaped
// substrings, and one-generation size rotation — never throwing on write.

async function tmpLogPath(): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "soroeru-file-logger-"));
  return { dir, path: join(dir, "logs", "soroeru.log") };
}

test("writes structured JSONL entries and reads them back", async () => {
  const { dir, path } = await tmpLogPath();
  try {
    const logger = new FileLogger(path);
    logger.info("vault", "vault unlocked");
    logger.warn("visibility", "site unreachable", { domain: "example.test", reason: "timeout" });

    const content = await logger.read();
    const lines = content
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(lines.length, 2);
    assert.equal(lines[0]?.["level"], "info");
    assert.equal(lines[0]?.["category"], "vault");
    assert.equal(lines[0]?.["message"], "vault unlocked");
    assert.equal(lines[1]?.["level"], "warn");
    assert.equal(lines[1]?.["domain"], "example.test");
    assert.equal(lines[1]?.["reason"], "timeout");
    assert.equal(typeof lines[0]?.["at"], "string");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("redacts secret-shaped substrings in messages and string fields before writing", async () => {
  const { dir, path } = await tmpLogPath();
  try {
    const logger = new FileLogger(path);
    logger.error("app", "unexpected error for user@example.test", {
      message: "card 4111 1111 1111 1111 rejected",
      count: 3,
    });

    const content = await logger.read();
    assert.equal(content.includes("user@example.test"), false);
    assert.equal(content.includes("4111 1111 1111 1111"), false);
    assert.ok(content.includes("[redacted]"));
    const entry = JSON.parse(content.trim()) as Record<string, unknown>;
    assert.equal(entry["count"], 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("read() returns empty string before any write and never throws", async () => {
  const { dir, path } = await tmpLogPath();
  try {
    const logger = new FileLogger(path);
    assert.equal(await logger.read(), "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("read() rethrows a genuine read failure instead of silently returning empty content", async () => {
  const dir = await mkdtemp(join(tmpdir(), "soroeru-file-logger-"));
  try {
    // A directory where the log file is expected to be: readFile fails with
    // EISDIR, not ENOENT, so this must propagate rather than look like "no log yet".
    const logger = new FileLogger(dir);
    await assert.rejects(() => logger.read());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rotates once the active file exceeds the size threshold, keeping one prior generation", async () => {
  const { dir, path } = await tmpLogPath();
  try {
    // Pre-seed a file already past the rotation threshold so the next write triggers it,
    // instead of writing megabytes of real log lines in this test.
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "x".repeat(5 * 1024 * 1024 + 1), "utf8");
    const logger = new FileLogger(path);
    logger.info("app", "after rotation");

    const content = await logger.read();
    // The prior (oversized filler) generation is included ahead of the fresh entry.
    assert.ok(content.startsWith("x".repeat(10)));
    assert.ok(content.includes("after rotation"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a caller-supplied field cannot clobber the reserved envelope keys", async () => {
  const { dir, path } = await tmpLogPath();
  try {
    const logger = new FileLogger(path);
    logger.warn("visibility", "site unreachable", { level: "not-a-real-level", category: "spoofed" });

    const content = await logger.read();
    const entry = JSON.parse(content.trim()) as Record<string, unknown>;
    assert.equal(entry["level"], "warn");
    assert.equal(entry["category"], "visibility");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("redactLogText leaves ordinary structural text untouched", () => {
  assert.equal(redactLogText("collection completed"), "collection completed");
  assert.equal(redactLogText("site unreachable: timeout"), "site unreachable: timeout");
});
