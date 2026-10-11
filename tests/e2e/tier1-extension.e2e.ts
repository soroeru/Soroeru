import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";

test("built extension injects classic content script and reads Tier 1 values directly under a lease", async t => {
  const dir = await mkdtemp(join(tmpdir(), "tier1-extension-"));
  const extension = join(dir, "extension");
  await cp(resolve("dist/extension"), extension, { recursive: true });
  const manifest = JSON.parse(await readFile(join(extension, "manifest.json"), "utf8"));
  // Fake fixture access in this disposable test build only; production permissions stay opt-in.
  manifest.host_permissions = ["https://schema-fixture.example/*"];
  await writeFile(join(extension, "manifest.json"), JSON.stringify(manifest));
  const context = await chromium.launchPersistentContext(join(dir, "profile"), { channel: "chromium", headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  t.after(async () => { await context.close(); await rm(dir, { recursive: true, force: true }); });
  await context.route("https://schema-fixture.example/**", route => route.fulfill({ contentType: "text/html", path: resolve("cloud/seeds/profile.html") }));
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  const extensionId = new URL(worker.url()).host;
  const fixture = await context.newPage();
  await fixture.goto("https://schema-fixture.example/profile");
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  const [stored] = JSON.parse(await readFile("cloud/seeds/official.json", "utf8"));
  const { validationCount: _v, distinctValidators: _d, failureCount: _f, createdAt: _c, updatedAt: _u, ...schema } = stored;
  const result = await panel.evaluate(async schema => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find(tab => tab.url?.startsWith("https://schema-fixture.example/"));
    if (!tab?.id) throw new Error("missing fixture tab");
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content-script.js"] });
    await chrome.tabs.sendMessage(tab.id, { version: 1, kind: "lease.bind", leaseId: "fake-lease", epoch: 1, origin: "https://schema-fixture.example", siteDomain: "schema-fixture.example" });
    const command = (requestId: string, command: unknown) => chrome.tabs.sendMessage(tab.id!, { version: 1, kind: "page.command", requestId, leaseId: "fake-lease", epoch: 1, command });
    const fingerprint = await command("fingerprint", { command: "schemaFingerprint" });
    const values = await command("read", { command: "readSchema", schema });
    const rejected = await chrome.tabs.sendMessage(tab.id, { version: 1, kind: "page.command", requestId: "stale", leaseId: "fake-lease", epoch: 0, command: { command: "readSchema", schema } });
    return { fingerprint, values, rejected };
  }, schema) as { fingerprint: { ok: boolean; payload: string }; values: { ok: boolean; payload: { values: { value: string }[]; unresolved: unknown[] } }; rejected: { kind: string; reason: string } };
  assert.equal(result.fingerprint.ok, true); assert.equal(result.fingerprint.payload, schema.pageFingerprints[0]);
  assert.equal(result.values.ok, true);
  assert.deepEqual(result.values.payload.values.map(v => v.value), ["fake@example.com", "090-0000-0000"]);
  assert.deepEqual(result.values.payload.unresolved, []);
  assert.equal(result.rejected.kind, "page.rejected"); assert.equal(result.rejected.reason, "stale-epoch");
});
