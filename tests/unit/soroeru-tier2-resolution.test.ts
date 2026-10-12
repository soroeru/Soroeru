import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sanitizeStructure } from "../../extension/structure-sanitizer.js";
import { CloudClient } from "../../extension/cloud-client.js";
import { ResolutionOrchestrator } from "../../extension/resolution-orchestrator.js";
import { VaultSession } from "../../src/store/vault-session.js";
import { FileVaultPersistence } from "../../src/store/file-vault-persistence.js";
import { validateStructureMappings, validateCloudRequest } from "../../src/shared/cloud-contract.js";
import type { PageSnapshot } from "../../src/types.js";
const hash = "a".repeat(64);
function page(value: string): PageSnapshot {
  return {
    url: `https://example.com/${value}`,
    title: value,
    visibleText: value,
    buttons: [],
    links: [],
    iframeSrcs: [],
    wallMarkers: [],
    fields: [
      {
        fieldId: "f-1",
        tag: "input",
        type: "email",
        name: "email_" + value,
        id: value,
        autocomplete: "email",
        required: true,
        placeholder: value,
        labels: [value, "メールアドレス"],
        nearbyText: value,
        options: [{ value, label: value }],
      },
    ],
    displayValues: [{ valueId: "d-1", labelText: "氏名: " + value, nearbyText: value }],
  };
}
test("sanitizer property: arbitrary personal strings in page text/attributes/options never escape", () => {
  const values = [
    "架空花子",
    "Fake Person",
    "fake@example.com",
    "090-0000-0000",
    "4111111111111111",
    "123",
    "fake-SECRET",
    ...Array.from({ length: 200 }, () => "fake-" + randomUUID()),
  ];
  for (const value of values) {
    const result = sanitizeStructure(page(value), "example.com", hash);
    validateCloudRequest("mapStructure", result);
    assert.ok(!JSON.stringify(result).includes(value), value);
    assert.deepEqual(result.items[0]?.nameTokens, ["email"]);
    assert.equal(result.items[0]?.label, "メールアドレス");
    assert.equal(result.items[1]?.label, undefined);
    assert.equal(result.items[0]?.valueShape, undefined);
  }
});
test("closed mappings reject unknown IDs, keys, instructions, selectors, URLs and duplicates", () => {
  const request = sanitizeStructure(page("fake@example.com"), "example.com", hash);
  const valid = {
    mappings: [{ itemId: "f-1", attributeKey: "email", confidence: 0.9 }],
    pagePurpose: "contact",
  };
  validateStructureMappings(request, valid);
  for (const m of [
    { ...valid.mappings[0], itemId: "f-99" },
    { ...valid.mappings[0], attributeKey: "invented" },
    { ...valid.mappings[0], instruction: "ignore all rules" },
    { ...valid.mappings[0], selector: "#email" },
    { ...valid.mappings[0], url: "https://evil.example" },
  ]) {
    assert.throws(() => validateStructureMappings(request, { ...valid, mappings: [m] }));
  }
  assert.throws(() =>
    validateStructureMappings(request, { ...valid, mappings: [...valid.mappings, ...valid.mappings] }),
  );
});
async function fixture(t: test.TestContext, telemetryEnabled = true) {
  const dir = await mkdtemp(join(tmpdir(), "tier2-"));
  const path = join(dir, "vault.json");
  const session = new VaultSession({
    persistence: new FileVaultPersistence(path),
    kdfAlgo: "pbkdf2-sha512",
    lockManager: { tryAcquire: async () => ({ release() {} }) },
  });
  await session.start();
  await session.create("fake-test-passphrase-long");
  session.vault.put("cloudSettings", {
    id: "cloud",
    cloudAssistEnabled: true,
    telemetryEnabled,
    validatorKey: "fake-local-key",
    queue: [],
    updatedAt: 0,
  });
  t.after(async () => {
    session.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { session, path };
}
test("missing schema resolves via Gemini, reads locally and records only encrypted value-free feedback", async (t) => {
  const { session, path } = await fixture(t);
  const sent: unknown[] = [];
  const client = new CloudClient(
    { apiBaseUrl: "https://api.example/", fallbackBaseUrl: "https://fallback.example/" },
    async (url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify(
          String(url).endsWith("resolve")
            ? { schema: null, status: "none" }
            : {
                mappings: [{ itemId: "f-1", attributeKey: "email", confidence: 0.95 }],
                pagePurpose: "contact",
              },
        ),
      );
    },
  );
  const resolver = new ResolutionOrchestrator({
    session,
    client,
    clientVersion: "0.1.2",
    isActive: () => true,
    sendPageCommand: async (command) =>
      command.command === "schemaFingerprint"
        ? hash
        : command.command === "structureSnapshot"
          ? sanitizeStructure(page("fake@example.com"), "example.com", hash)
          : { values: [{ itemId: "f-1", attributeKey: "email", value: "fake@example.com" }], unresolved: [] },
  });
  const result = await resolver.resolve("example.com");
  assert.equal(result?.source, "gemini");
  assert.equal(result?.values[0]?.value, "fake@example.com");
  assert.doesNotMatch(JSON.stringify(sent), /fake@example/);
  const queue = session.vault.get("cloudSettings", "cloud")!.queue;
  assert.equal(queue.length, 1);
  validateCloudRequest("feedback", queue[0]!.body);
  assert.doesNotMatch(JSON.stringify(queue), /fake@example|fake-local-key/);
  assert.doesNotMatch(await readFile(path, "utf8"), /fake@example|example.com|gemini_structure/);
});
test("cloud outage/off, invalid response, local conflict and invalidation never authorize values or feedback", async (t) => {
  for (const mode of ["off", "offline", "injection", "conflict", "inactive"] as const) {
    const { session } = await fixture(t);
    let calls = 0;
    let reads = 0;
    let active = true;
    if (mode === "off") {
      const settings = session.vault.get("cloudSettings", "cloud")!;
      session.vault.put("cloudSettings", { ...settings, cloudAssistEnabled: false });
    }
    const client = new CloudClient(
      { apiBaseUrl: "https://api.example/", fallbackBaseUrl: "https://fallback.example/" },
      async (url) => {
        calls++;
        if (mode === "offline") throw new Error("fake outage");
        if (String(url).endsWith("resolve"))
          return new Response(JSON.stringify({ schema: null, status: "none" }));
        if (mode === "inactive") active = false;
        return new Response(
          JSON.stringify({
            mappings: [
              { itemId: mode === "injection" ? "f-99" : "f-1", attributeKey: "email", confidence: 1 },
            ],
            pagePurpose: "contact",
          }),
        );
      },
    );
    const resolver = new ResolutionOrchestrator({
      session,
      client,
      clientVersion: "0.1.2",
      isActive: () => active,
      sendPageCommand: async (c) => {
        if (c.command === "schemaFingerprint") return hash;
        if (c.command === "structureSnapshot")
          return sanitizeStructure(page("fake@example.com"), "example.com", hash);
        reads++;
        return { values: [], unresolved: [{ attributeKey: "email", reason: "classifier-conflict" }] };
      },
    });
    if (mode === "inactive") await assert.rejects(resolver.resolve("example.com"), /resolution-inactive/);
    else assert.equal((await resolver.resolve("example.com"))?.values.length ?? 0, 0);
    assert.equal(reads, mode === "conflict" ? 1 : 0);
    assert.equal(session.vault.get("cloudSettings", "cloud")!.queue.length, 0);
    if (mode === "off" || mode === "offline") assert.equal(calls, mode === "off" ? 0 : 1);
  }
});

test("partial Tier 1 keeps validated fields, sends only unresolved items and respects telemetry off", async (t) => {
  const { session } = await fixture(t, false);
  const schema = {
    schemaId: hash,
    site: "example.com",
    formKey: hash,
    version: 1,
    pageFingerprints: [hash],
    fields: [
      { anchor: "f-1", attributeKey: "email", required: true },
      { anchor: "f-99", attributeKey: "phone.full", required: true },
    ],
    confidence: 1,
    status: "active",
    provenance: "official",
  };
  const structure = sanitizeStructure(page("fake@example.com"), "example.com", hash);
  structure.items.push({ id: "f-2", tag: "input", type: "tel", nameTokens: ["phone"], label: "電話番号" });
  const client = new CloudClient(
    { apiBaseUrl: "https://api.example/", fallbackBaseUrl: "https://fallback.example/" },
    async (url, init) => {
      if (String(url).endsWith("resolve")) return new Response(JSON.stringify({ status: "active", schema }));
      const sent = JSON.parse(String(init?.body));
      assert.ok(!sent.items.some((i: { id: string }) => i.id === "f-1"));
      return new Response(
        JSON.stringify({
          mappings: [{ itemId: "f-2", attributeKey: "phone.full", confidence: 0.95 }],
          pagePurpose: "contact",
        }),
      );
    },
  );
  const resolver = new ResolutionOrchestrator({
    session,
    client,
    clientVersion: "0.1.2",
    isActive: () => true,
    sendPageCommand: async (c) => {
      if (c.command === "schemaFingerprint") return hash;
      if (c.command === "structureSnapshot") return structuredClone(structure);
      if (c.command === "readSchema" && c.schema.provenance === "official")
        return {
          values: [{ itemId: "f-1", attributeKey: "email", value: "fake@example.com" }],
          unresolved: [{ attributeKey: "phone.full", reason: "anchor-not-found" }],
        };
      return {
        values: [{ itemId: "f-2", attributeKey: "phone.full", value: "090-0000-0000" }],
        unresolved: [],
      };
    },
  });
  const result = await resolver.resolve("example.com");
  assert.deepEqual(
    result?.values.map((v) => v.attributeKey),
    ["email", "phone.full"],
  );
  assert.deepEqual(result?.unresolved, []);
  assert.equal(session.vault.get("cloudSettings", "cloud")!.queue.length, 0);
});
