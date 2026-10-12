// SEC-002 (#23): `checkBypassDenylist` is the static check behind
// `npm run poc -- check-bypass`: no `dependencies` / `devDependencies` entry
// in package.json or cloud/package.json may match a CAPTCHA-solving or
// anti-bot/fingerprint-evasion package name (docs/security.md#site-operation-and-interruption, Issue #564).

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkBypassDenylist } from "../../src/dev/bypass-check.js";

// dist/compiled/tests/unit/<this file> -> repo root is four levels up.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

async function withFixture(fn: (root: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "af-poc-bypass-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeMinimalPackageJson(root: string, extra?: Record<string, unknown>): Promise<void> {
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "fixture", dependencies: {}, devDependencies: {}, ...extra }), "utf8");
}

test("real repo: no CAPTCHA-solving / anti-bot-evasion dependency is present", () => {
  const result = checkBypassDenylist(REPO_ROOT);
  assert.deepEqual(result.violations, []);
});

test("flags a CAPTCHA-solving dependency", async () => {
  await withFixture(async (root) => {
    await writeMinimalPackageJson(root, { dependencies: { "2captcha-ts": "^1.0.0" } });
    const result = checkBypassDenylist(root);
    assert.equal(result.violations.length, 1);
    assert.match(result.violations[0]!, /2captcha-ts.*2captcha/);
  });
});

test("flags an anti-bot/fingerprint-evasion devDependency", async () => {
  await withFixture(async (root) => {
    await writeMinimalPackageJson(root, { devDependencies: { "puppeteer-extra-plugin-stealth": "^2.0.0" } });
    const result = checkBypassDenylist(root);
    assert.equal(result.violations.length, 1);
    assert.match(result.violations[0]!, /puppeteer-extra-plugin-stealth.*stealth/);
  });
});

test("does not flag ordinary automation dependencies", async () => {
  await withFixture(async (root) => {
    await writeMinimalPackageJson(root, { dependencies: { playwright: "^1.60.0" }, devDependencies: { typescript: "^5.8.3" } });
    const result = checkBypassDenylist(root);
    assert.deepEqual(result.violations, []);
  });
});

// Issue #564: cloud/package.json is also scanned

test("flags a CAPTCHA-solving dependency in cloud/package.json (Issue #564)", async () => {
  await withFixture(async (root) => {
    await writeMinimalPackageJson(root);
    await mkdir(join(root, "cloud"), { recursive: true });
    await writeFile(
      join(root, "cloud", "package.json"),
      JSON.stringify({ name: "fixture-cloud", dependencies: { "capsolver-npm": "^1.0.0" }, devDependencies: {} }),
      "utf8",
    );

    const result = checkBypassDenylist(root);
    assert.equal(result.violations.length, 1);
    assert.match(result.violations[0]!, /cloud\/package\.json/);
    assert.match(result.violations[0]!, /capsolver-npm.*capsolver/);
  });
});

test("does not fail when cloud/package.json is absent (Issue #564)", async () => {
  await withFixture(async (root) => {
    await writeMinimalPackageJson(root);
    // no cloud/ directory — should not throw
    const result = checkBypassDenylist(root);
    assert.deepEqual(result.violations, []);
  });
});
