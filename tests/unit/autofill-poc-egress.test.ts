// PRIV-001 (#20): network egress is limited to (a) the target sites the user
// acts on and (b) the user's configured AI provider (docs/security.md §6).
// `checkNetworkEgress` is the static check behind `npm run poc -- check-egress`:
// every network-call site in poc/autofill-agent/{src,run} must carry a
// `// egress: target-site|ai-provider` annotation, and no telemetry/analytics
// dependency may be present in package.json.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkNetworkEgress } from "../../poc/autofill-agent/src/dev/egress-check.js";

// dist/compiled/tests/unit/<this file> -> repo root is four levels up.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

async function withFixture(fn: (root: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "af-poc-egress-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeMinimalPackageJson(root: string, extra?: Record<string, unknown>): Promise<void> {
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "fixture", dependencies: {}, devDependencies: {}, ...extra }), "utf8");
}

test("real repo: every network-call site is annotated and no telemetry dependency is present", () => {
  const result = checkNetworkEgress(REPO_ROOT);
  assert.deepEqual(result.violations, []);
  assert.ok(result.scannedFiles > 0);
});

test("flags an unannotated network call", async () => {
  await withFixture(async (root) => {
    await mkdir(join(root, "poc/autofill-agent/src/agent"), { recursive: true });
    await writeFile(
      join(root, "poc/autofill-agent/src/agent/bad.ts"),
      ["export async function call(url: string) {", "  const res = await fetch(url);", "  return res.text();", "}", ""].join("\n"),
      "utf8",
    );
    await writeMinimalPackageJson(root);

    const result = checkNetworkEgress(root);
    assert.equal(result.violations.length, 1);
    assert.match(result.violations[0]!, /bad\.ts:2:.*fetch\(url\)/);
  });
});

test("does not flag a network call annotated with an allowed egress category", async () => {
  await withFixture(async (root) => {
    await mkdir(join(root, "poc/autofill-agent/src/agent"), { recursive: true });
    await writeFile(
      join(root, "poc/autofill-agent/src/agent/good.ts"),
      [
        "export async function call(url: string) {",
        "  // egress: target-site — terms link on the site the user is registering on",
        "  const res = await fetch(url);",
        "  return res.text();",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeMinimalPackageJson(root);

    const result = checkNetworkEgress(root);
    assert.deepEqual(result.violations, []);
  });
});

test("rejects an annotation category that is not on the allowlist", async () => {
  await withFixture(async (root) => {
    await mkdir(join(root, "poc/autofill-agent/src/agent"), { recursive: true });
    await writeFile(
      join(root, "poc/autofill-agent/src/agent/bad.ts"),
      ["export async function call(url: string) {", "  // egress: analytics-backend", "  const res = await fetch(url);", "  return res.text();", "}", ""].join(
        "\n",
      ),
      "utf8",
    );
    await writeMinimalPackageJson(root);

    const result = checkNetworkEgress(root);
    assert.equal(result.violations.length, 1);
  });
});

test("flags a telemetry/analytics dependency in package.json", async () => {
  await withFixture(async (root) => {
    await mkdir(join(root, "poc/autofill-agent/src"), { recursive: true });
    await mkdir(join(root, "poc/autofill-agent/run"), { recursive: true });
    await writeMinimalPackageJson(root, { dependencies: { "@sentry/node": "^8.0.0" } });

    const result = checkNetworkEgress(root);
    assert.equal(result.violations.length, 1);
    assert.match(result.violations[0]!, /@sentry\/node.*sentry/);
  });
});

test("ignores poc/autofill-agent/sites/ (the local 127.0.0.1 PoC test-site server)", async () => {
  await withFixture(async (root) => {
    await mkdir(join(root, "poc/autofill-agent/sites"), { recursive: true });
    await writeFile(
      join(root, "poc/autofill-agent/sites/server.ts"),
      ["export async function call(url: string) {", "  const res = await fetch(url);", "  return res.text();", "}", ""].join("\n"),
      "utf8",
    );
    await writeMinimalPackageJson(root);

    const result = checkNetworkEgress(root);
    assert.deepEqual(result.violations, []);
    assert.equal(result.scannedFiles, 0);
  });
});
