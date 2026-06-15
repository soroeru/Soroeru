import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildSupportBundle, exportSupportBundleJson, redactDiagnosticText } from "../../src/app/diagnostics.js";
import { PocStore } from "../../src/store/store.js";

const PASSPHRASE = "unit-test-passphrase";

async function withStore(fn: (store: PocStore) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "catashiro-diag-"));
  try {
    const store = await PocStore.open(join(dir, "store.json"), PASSPHRASE);
    await fn(store);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("redactDiagnosticText masks common raw personal values and secrets", () => {
  const text = "email=taro@example.test card=4111 1111 1111 1111 phone=03-1234-5678 key=sk-test-secret";
  const redacted = redactDiagnosticText(text);
  assert.ok(!redacted.includes("taro@example.test"));
  assert.ok(!redacted.includes("4111 1111 1111 1111"));
  assert.ok(!redacted.includes("03-1234-5678"));
  assert.ok(!redacted.includes("sk-test-secret"));
  assert.match(redacted, /\[redacted\]/);
});

test("support bundle exports redacted local diagnostics without vault or raw values", async () => {
  await withStore(async (store) => {
    store.addDiagnosticEvent({
      type: "error",
      severity: "error",
      message: "failed for taro@example.test with card 4111 1111 1111 1111",
      metadata: {
        siteId: "example.test",
        note: "phone 03-1234-5678",
      },
    });

    const bundle = buildSupportBundle(store);
    assert.equal(bundle.schema, "catashiro-support-bundle-v1");
    assert.equal(bundle.privacy.redacted, true);
    assert.equal(bundle.app.name, "catashiro");
    assert.ok(bundle.runtime.node);
    assert.equal(bundle.diagnostics.length, 1);
    assert.equal(bundle.diagnostics[0]!.metadata?.siteId, "example.test");

    const json = exportSupportBundleJson(store);
    assert.ok(!json.includes("taro@example.test"));
    assert.ok(!json.includes("4111 1111 1111 1111"));
    assert.ok(!json.includes("03-1234-5678"));
    assert.ok(!json.includes("ciphertext"));
    assert.ok(!json.includes("kdf"));
  });
});
