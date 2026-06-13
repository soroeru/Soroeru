// PRIV-002 (#21): local persistence is limited to the encrypted storage
// abstraction, the encrypted export/import (SEC-003 / #44), and the masked
// measurement output (docs/security.md §3). `checkLocalPersistence` is the
// static check behind `npm run poc -- check-persistence`: every local-write
// site in poc/autofill-agent/{src,run} must carry a
// `// persist: encrypted-store|encrypted-export|measurement-output` annotation.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkLocalPersistence } from "../../poc/autofill-agent/src/dev/privacy-check.js";

// dist/compiled/tests/unit/<this file> -> repo root is four levels up.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

async function withFixture(fn: (root: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "af-poc-privacy-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("real repo: every local-write site is annotated", () => {
  const result = checkLocalPersistence(REPO_ROOT);
  assert.deepEqual(result.violations, []);
  assert.ok(result.scannedFiles > 0);
});

test("flags an unannotated local write", async () => {
  await withFixture(async (root) => {
    await mkdir(join(root, "poc/autofill-agent/src/store"), { recursive: true });
    await writeFile(
      join(root, "poc/autofill-agent/src/store/bad.ts"),
      ["export async function save(path: string, data: string) {", "  await writeFile(path, data, \"utf8\");", "}", ""].join("\n"),
      "utf8",
    );

    const result = checkLocalPersistence(root);
    assert.equal(result.violations.length, 1);
    assert.match(result.violations[0]!, /bad\.ts:2:.*writeFile\(path, data/);
  });
});

test("does not flag a local write annotated with an allowed persist category", async () => {
  await withFixture(async (root) => {
    await mkdir(join(root, "poc/autofill-agent/src/store"), { recursive: true });
    await writeFile(
      join(root, "poc/autofill-agent/src/store/good.ts"),
      [
        "export async function save(path: string, data: string) {",
        "  // persist: encrypted-store — AES-256-GCM encrypted records only",
        "  await writeFile(path, data, \"utf8\");",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = checkLocalPersistence(root);
    assert.deepEqual(result.violations, []);
  });
});

test("rejects an annotation category that is not on the allowlist", async () => {
  await withFixture(async (root) => {
    await mkdir(join(root, "poc/autofill-agent/src/store"), { recursive: true });
    await writeFile(
      join(root, "poc/autofill-agent/src/store/bad.ts"),
      ["export async function save(path: string, data: string) {", "  // persist: plaintext-cache", "  await writeFile(path, data, \"utf8\");", "}", ""].join(
        "\n",
      ),
      "utf8",
    );

    const result = checkLocalPersistence(root);
    assert.equal(result.violations.length, 1);
  });
});

test("ignores poc/autofill-agent/sites/ (the local 127.0.0.1 PoC test-site server)", async () => {
  await withFixture(async (root) => {
    await mkdir(join(root, "poc/autofill-agent/sites"), { recursive: true });
    await writeFile(
      join(root, "poc/autofill-agent/sites/server.ts"),
      ["export async function save(path: string, data: string) {", "  await writeFile(path, data, \"utf8\");", "}", ""].join("\n"),
      "utf8",
    );

    const result = checkLocalPersistence(root);
    assert.deepEqual(result.violations, []);
    assert.equal(result.scannedFiles, 0);
  });
});
