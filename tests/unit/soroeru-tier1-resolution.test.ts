import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ResolutionOrchestrator } from "../../extension/resolution-orchestrator.js";
import { CloudClient } from "../../extension/cloud-client.js";
import { VaultSession } from "../../src/store/vault-session.js";
import { FileVaultPersistence } from "../../src/store/file-vault-persistence.js";
import { parsePageCommand, type PageCommand } from "../../src/shared/extension-messages.js";
import { validateFormSchema, type FormSchema } from "../../src/shared/cloud-contract.js";
const hash = "a".repeat(64);
const schema: FormSchema = { schemaId: hash, site: "example.com", formKey: hash, version: 1,
  pageFingerprints: [hash], fields: [{ anchor: "f-1", attributeKey: "email", required: true }, { anchor: "f-2", attributeKey: "phone.full", required: true }],
  confidence: 1, status: "active", provenance: "official" };
async function session(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "tier1-"));
  const path = join(dir, "vault.json");
  const session = new VaultSession({ persistence: new FileVaultPersistence(path), kdfAlgo: "pbkdf2-sha512", lockManager: { tryAcquire: async () => ({ release() {} }) } });
  await session.start(); await session.create("fake-test-passphrase-long");
  t.after(async () => { session.close(); await rm(dir, { recursive: true, force: true }); });
  return { session, path };
}
function enable(session: VaultSession, enabled: boolean) {
  session.vault.put("cloudSettings", { id: "cloud", telemetryEnabled: false, cloudAssistEnabled: enabled, validatorKey: "fake-local-validator", queue: [], updatedAt: 0 });
}
const local = { values: [{ attributeKey: "email" as const, itemId: "f-1", value: "fake@example.com" }], unresolved: [{ attributeKey: "phone.full" as const, reason: "anchor-not-found" as const }] };
test("Tier 1 sends only structure identifiers, preserves per-field failures, saves encrypted cache and reuses it offline", async t => {
  const { session: unlocked, path } = await session(t);
  enable(unlocked, true);
  const calls: unknown[] = [];
  const client = new CloudClient({ apiBaseUrl: "https://api.example/", fallbackBaseUrl: "https://fallback.example/" }, async (_url, init) => {
    calls.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ status: "active", schema }));
  });
  const commands: PageCommand[] = [];
  const send = async (command: PageCommand) => { commands.push(command); return command.command === "schemaFingerprint" ? hash : structuredClone(local); };
  const resolver = new ResolutionOrchestrator({ session: unlocked, client, clientVersion: "0.1.2", sendPageCommand: send, isActive: () => true });
  const result = await resolver.resolve("example.com");
  assert.deepEqual(result?.values, local.values); assert.deepEqual(result?.unresolved, local.unresolved);
  assert.deepEqual(calls, [{ site: "example.com", pageFingerprint: hash, clientVersion: "0.1.2" }]);
  const stored = await readFile(path, "utf8");
  assert.doesNotMatch(stored, /example\.com|fake@|formKey|pageFingerprints/);
  enable(unlocked, false);
  assert.equal((await resolver.resolve("example.com"))?.source, "cache");
  assert.equal(calls.length, 1);
  enable(unlocked, true);
  const offline = new ResolutionOrchestrator({ session: unlocked, client: { call: async () => { throw new Error("offline"); } }, clientVersion: "0.1.2", sendPageCommand: send, isActive: () => true });
  assert.equal((await offline.resolve("example.com"))?.source, "cache");
  assert.equal(commands.filter(c => c.command === "readSchema").length, 3);
});
test("wrong-site, low-confidence, missing schema and locked session never authorize a value read", async t => {
  const { session: unlocked } = await session(t); enable(unlocked, true);
  let reads = 0;
  for (const returned of [{ ...schema, site: "other.example" }, { ...schema, confidence: 0.1 }, null]) {
    const resolver = new ResolutionOrchestrator({ session: unlocked, client: { call: async () => ({ status: returned ? "active" : "none", schema: returned }) }, clientVersion: "0.1.2", isActive: () => true,
      sendPageCommand: async command => { if (command.command === "readSchema") reads++; return hash; } });
    assert.equal(await resolver.resolve("example.com"), null);
  }
  assert.equal(reads, 0);
  unlocked.lock();
  const resolver = new ResolutionOrchestrator({ session: unlocked, clientVersion: "0.1.2", isActive: () => true, sendPageCommand: async () => { throw new Error("must not command"); } });
  await assert.rejects(resolver.resolve("example.com"), /inactive/);
});
test("schema IPC and schema storage reject free selectors, PII-like strings and hidden extra data", () => {
  for (const anchor of ["#customer", "[value=secret]", ":root > input", ".name", "f-0"])
    assert.throws(() => parsePageCommand({ command: "readSchema", schema: { ...schema, fields: [{ ...schema.fields[0], anchor }] } }));
  for (const site of ["fake@example.com", "090-1234-5678.example", "4111111111111111.example"])
    assert.throws(() => validateFormSchema({ ...schema, site }));
  assert.throws(() => validateFormSchema({ ...schema, provenance: "feedback", fields: [{ anchor: "f-1", attributeKey: "card.number", required: true }] }));
  assert.throws(() => parsePageCommand({ command: "readSchema", schema, values: "fake" }));
  assert.deepEqual(parsePageCommand({ command: "readSchema", schema }), { command: "readSchema", schema });
});
test("Visibility run persists successful Tier 1 fields and checkpoints only unresolved fields for review", async t => {
  const { session: unlocked } = await session(t);
  const { DomainService } = await import("../../src/domain/domain-service.js");
  const { VisibilityRunner } = await import("../../src/automation/visibility-runner.js");
  const domain = new DomainService(unlocked.vault);
  const site = domain.upsertSiteAccount({ domain: "example.com", url: "https://example.com/profile", displayName: "Fake fixture" });
  const snapshot = { url: site.url!, title: "Fixture", fields: [], buttons: [], links: [{ href: "/logout", text: "ログアウト" }], visibleText: "会員情報", iframeSrcs: [], wallMarkers: [] };
  const runner = new VisibilityRunner({ domain, openSession: async () => ({ close: async () => {}, page: {
    goto: async () => {}, currentUrl: () => snapshot.url, snapshot: async () => snapshot,
    waitForReady: async () => {}, fillField: async () => {}, click: async () => {}, readValues: async () => { throw new Error("unresolved fields must not be read"); },
  } }), resolveSharedSchema: async () => structuredClone(local) });
  const result = await runner.runSite(site.id);
  assert.equal(result.status, "handoff"); assert.equal(result.disclosures, 1);
  assert.deepEqual(domain.listDisclosuresForSite(site.id).map(d => d.attributeKey), ["email"]);
  assert.equal(domain.getCheckpoint("visibility", site.id)?.status, "handoff");
});
