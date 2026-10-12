// PRIV-001 (#20) + Issue #564: network egress is limited to (a) the target sites
// the user acts on, (b) the user's configured AI provider (non-extension only),
// and (c) Soroeru Cloud (docs/security.md §6).
// `checkNetworkEgress` is the static check behind `npm run poc -- check-egress`:
// every network-call site in src/, run/, electron/, extension/, cloud/, or
// native-host/ must carry a `// egress: <allowed-category>` annotation, and no
// telemetry/analytics dependency, no Google Cloud SDK in root package.json, and no
// GCP credential-like string in extension source may be present.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkNetworkEgress } from "../../src/dev/egress-check.js";

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
    await mkdir(join(root, "src/agent"), { recursive: true });
    await writeFile(
      join(root, "src/agent/bad.ts"),
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
    await mkdir(join(root, "src/agent"), { recursive: true });
    await writeFile(
      join(root, "src/agent/good.ts"),
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
    await mkdir(join(root, "src/agent"), { recursive: true });
    await writeFile(
      join(root, "src/agent/bad.ts"),
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
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "run"), { recursive: true });
    await writeMinimalPackageJson(root, { dependencies: { "@sentry/node": "^8.0.0" } });

    const result = checkNetworkEgress(root);
    assert.equal(result.violations.length, 1);
    assert.match(result.violations[0]!, /@sentry\/node.*sentry/);
  });
});

test("ignores sites/ (the local 127.0.0.1 PoC test-site server)", async () => {
  await withFixture(async (root) => {
    await mkdir(join(root, "sites"), { recursive: true });
    await writeFile(
      join(root, "sites/server.ts"),
      ["export async function call(url: string) {", "  const res = await fetch(url);", "  return res.text();", "}", ""].join("\n"),
      "utf8",
    );
    await writeMinimalPackageJson(root);

    const result = checkNetworkEgress(root);
    assert.deepEqual(result.violations, []);
    assert.equal(result.scannedFiles, 0);
  });
});

// Issue #564: extension/ must not use ai-provider annotation

test("flags extension file annotated with ai-provider (Issue #564)", async () => {
  await withFixture(async (root) => {
    await mkdir(join(root, "extension"), { recursive: true });
    await writeFile(
      join(root, "extension/ai-caller.ts"),
      [
        "export async function callAi(url: string) {",
        "  // egress: ai-provider — direct AI call from extension",
        "  const res = await fetch(url);",
        "  return res.text();",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeMinimalPackageJson(root);

    const result = checkNetworkEgress(root);
    assert.equal(result.violations.length, 1);
    assert.match(result.violations[0]!, /ai-provider/);
    assert.match(result.violations[0]!, /soroeru-cloud/);
  });
});

test("allows extension file annotated with soroeru-cloud (Issue #564)", async () => {
  await withFixture(async (root) => {
    await mkdir(join(root, "extension"), { recursive: true });
    await writeFile(
      join(root, "extension/cloud-client.ts"),
      [
        "export async function callCloud(url: string) {",
        "  // egress: soroeru-cloud — typed Cloud Run API",
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

test("allows non-extension file annotated with ai-provider (Issue #564)", async () => {
  await withFixture(async (root) => {
    await mkdir(join(root, "src/agent"), { recursive: true });
    await writeFile(
      join(root, "src/agent/ai.ts"),
      [
        "export async function callAi(url: string) {",
        "  // egress: ai-provider — Anthropic API",
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

// Issue #564: Google Cloud SDK must not appear in root package.json

test("flags Google Cloud SDK in root package.json (Issue #564)", async () => {
  await withFixture(async (root) => {
    await writeMinimalPackageJson(root, { dependencies: { "@google-cloud/firestore": "^9.0.0" } });

    const result = checkNetworkEgress(root);
    assert.equal(result.violations.length, 1);
    assert.match(result.violations[0]!, /@google-cloud\/firestore/);
    assert.match(result.violations[0]!, /cloud\/package\.json/);
  });
});

test("does not flag Google Cloud SDK package in cloud/ scan dir (Issue #564)", async () => {
  await withFixture(async (root) => {
    // cloud/src/ file with a soroeru-cloud annotated call passes; GCP SDK is only
    // forbidden in the ROOT package.json, not detected by the source-file scan.
    await mkdir(join(root, "cloud/src"), { recursive: true });
    await writeFile(
      join(root, "cloud/src/registry.ts"),
      [
        "export async function fetchSchema(url: string) {",
        "  // egress: soroeru-cloud — internal Cloud Run endpoint",
        "  const res = await fetch(url);",
        "  return res.json();",
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

// Issue #564: GCP credential patterns must not appear in extension source

test("flags GCP API key in extension source (Issue #564)", async () => {
  await withFixture(async (root) => {
    await mkdir(join(root, "extension"), { recursive: true });
    await writeFile(
      join(root, "extension/config.ts"),
      ['export const API_KEY = "AIzaSyD-9tSrke72I6EjBcQN_H4ArWuNwE7IjZE";', ""].join("\n"),
      "utf8",
    );
    await writeMinimalPackageJson(root);

    const result = checkNetworkEgress(root);
    assert.equal(result.violations.length, 1);
    assert.match(result.violations[0]!, /GCP credential/);
    assert.match(result.violations[0]!, /config\.ts:1:/);
  });
});

test("flags GCP service-account JSON marker in extension source (Issue #564)", async () => {
  await withFixture(async (root) => {
    await mkdir(join(root, "extension"), { recursive: true });
    await writeFile(
      join(root, "extension/creds.ts"),
      ['const cred = { "type": "service_account", "project_id": "my-proj" };', ""].join("\n"),
      "utf8",
    );
    await writeMinimalPackageJson(root);

    const result = checkNetworkEgress(root);
    assert.equal(result.violations.length, 1);
    assert.match(result.violations[0]!, /GCP credential/);
  });
});

test("does not flag GCP credential patterns outside extension/ (Issue #564)", async () => {
  await withFixture(async (root) => {
    // A cloud/ service file referencing its own service-account is outside the
    // extension credential check scope.
    await mkdir(join(root, "cloud/src"), { recursive: true });
    await writeFile(
      join(root, "cloud/src/auth.ts"),
      ['const cred = { "type": "service_account" };', ""].join("\n"),
      "utf8",
    );
    await writeMinimalPackageJson(root);

    const result = checkNetworkEgress(root);
    assert.deepEqual(result.violations, []);
  });
});

// Issue #564: cloud/ is included in the egress scan

test("flags unannotated network call in cloud/ source (Issue #564)", async () => {
  await withFixture(async (root) => {
    await mkdir(join(root, "cloud/src"), { recursive: true });
    await writeFile(
      join(root, "cloud/src/bad.ts"),
      ["export async function call(url: string) {", "  const res = await fetch(url);", "  return res.text();", "}", ""].join("\n"),
      "utf8",
    );
    await writeMinimalPackageJson(root);

    const result = checkNetworkEgress(root);
    assert.equal(result.violations.length, 1);
    assert.match(result.violations[0]!, /cloud\/src\/bad\.ts:2:.*fetch\(url\)/);
  });
});
