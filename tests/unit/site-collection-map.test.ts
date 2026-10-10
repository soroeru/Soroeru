import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SiteCollectionMap } from "../../src/domain/entities.js";
import { isSiteCollectionMap, SITE_COLLECTION_MAP_LIMITS } from "../../src/domain/site-collection-map.js";
import { FileVaultPersistence } from "../../src/store/file-vault-persistence.js";
import { VaultV2 } from "../../src/store/vault-v2.js";
import { DomainService } from "../../src/domain/domain-service.js";

function fixture(): SiteCollectionMap {
  return {
    id: "map-1",
    schemaVersion: 1,
    siteAccountId: "site-1",
    revision: 1,
    generationStatus: "ready",
    provenance: { kind: "ai-driven", observedAt: 1 },
    pages: [
      {
        url: "https://example.test/profile",
        purpose: "profile",
        fingerprint: "a".repeat(64),
        items: [
          {
            attributeKey: "email",
            locator: { kind: "css", selector: ":root > *:nth-child(2) > *:nth-child(1)" },
            fingerprint: "b".repeat(64),
          },
          {
            attributeKey: "phone.full",
            locator: { kind: "field-id", fieldId: "f-2" },
            fingerprint: "c".repeat(64),
          },
        ],
      },
    ],
  };
}

test("map validator rejects malformed versions, coordinates and body fields", () => {
  assert.equal(isSiteCollectionMap(fixture()), true);
  for (const patch of [
    { schemaVersion: 2 },
    { revision: 0 },
    { revision: 1.5 },
    { generationStatus: "invented" },
    { provenance: { kind: "ai-driven", observedAt: NaN } },
    { pages: null },
    { responseBody: "fake" },
  ]) {
    assert.equal(isSiteCollectionMap({ ...fixture(), ...patch }), false);
  }
  for (const url of [
    "http://example.test/",
    "https://user:secret@example.test/",
    "https://example.test/?token=fake",
    "https://example.test/#fake",
  ]) {
    const map = fixture();
    map.pages[0]!.url = url;
    assert.equal(isSiteCollectionMap(map), false);
  }
  const map = fixture();
  const item = map.pages[0]!.items[0]!;
  assert.equal(
    isSiteCollectionMap({
      ...map,
      pages: [{ ...map.pages[0], items: [{ ...item, locator: { kind: "xpath", selector: "//input" } }] }],
    }),
    false,
  );
  assert.equal(
    isSiteCollectionMap({
      ...map,
      pages: [{ ...map.pages[0], items: [{ ...item, value: "fake-personal-value" }] }],
    }),
    false,
  );
});

test("maps and distinct AI authorization records roundtrip encrypted and maps follow account deletion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "soroeru-map-"));
  try {
    const path = join(dir, "vault.json");
    const vault = await VaultV2.open(new FileVaultPersistence(path), "fake-passphrase");
    const service = new DomainService(vault);
    service.upsertSiteAccount({ id: "site-1", domain: "example.test", displayName: "Fake" });
    assert.throws(
      () => vault.put("siteCollectionMap", { ...fixture(), revision: 0 }),
      /invalid site collection map/,
    );
    vault.put("siteCollectionMap", fixture());
    vault.put("mandate", { id: "ai-mandate", operation: "ai-assisted-discovery", authorizedAt: 1 });
    vault.put("capability", {
      id: "ai-capability",
      operationType: "ai-assisted-discovery",
      level: "L0",
      updatedAt: 1,
    });
    vault.put("capability", { id: "collection", operationType: "collection", level: "L1", updatedAt: 1 });
    await vault.save();
    vault.lock();
    assert.equal((await readFile(path, "utf8")).includes("a".repeat(64)), false);
    const reopened = await VaultV2.open(new FileVaultPersistence(path), "fake-passphrase");
    assert.deepEqual(reopened.get("siteCollectionMap", "map-1"), fixture());
    assert.equal(reopened.get("mandate", "ai-mandate")?.operation, "ai-assisted-discovery");
    assert.equal(reopened.get("capability", "ai-capability")?.level, "L0");
    assert.equal(reopened.get("capability", "collection")?.level, "L1");
    new DomainService(reopened).deleteSiteAccount("site-1");
    assert.deepEqual(reopened.list("siteCollectionMap"), []);
    reopened.lock();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("map locators reject value-bearing selectors and page-provided IDs at the vault boundary", async () => {
  const dir = await mkdtemp(join(tmpdir(), "soroeru-map-locator-"));
  try {
    const vault = await VaultV2.open(new FileVaultPersistence(join(dir, "vault.json")), "fake-passphrase");
    const selectors = [
      '[value="4111111111111234"]',
      "#user-example-test",
      ".person-name",
      ':root > [data-value="123"]',
      ":root > *:nth-child(4111111111111234)",
      ':root > *:nth-child(1), [value="123"]',
      ":root > *:nth-child(0)",
    ];
    const fieldIds = [
      "user@example.test",
      "4111111111111234",
      "f-4111111111111234",
      "f-user-example-test",
      'f-1[value="123"]',
      "f-0",
    ];
    for (const locator of [
      ...selectors.map((selector) => ({ kind: "css" as const, selector })),
      ...fieldIds.map((fieldId) => ({ kind: "field-id" as const, fieldId })),
    ]) {
      const map = fixture();
      map.pages[0]!.items[0]!.locator = locator;
      assert.equal(isSiteCollectionMap(map), false);
      assert.throws(() => vault.put("siteCollectionMap", map), /invalid site collection map/);
    }
    const map = fixture();
    map.pages[0]!.items[0]!.locator = { kind: "field-id", fieldId: "d-12" };
    assert.equal(isSiteCollectionMap(map), true);
    vault.lock();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("map bounds accept the ceiling and reject larger arrays and strings", () => {
  const limits = SITE_COLLECTION_MAP_LIMITS;
  const map = fixture();
  map.id = "a".repeat(limits.identifierLength);
  map.siteAccountId = "b".repeat(limits.identifierLength);
  const page = map.pages[0]!;
  const base = "https://example.test/";
  page.url = base + "a".repeat(limits.urlLength - base.length);
  const item = page.items[0]!;
  item.attributeKey = "c".repeat(limits.identifierLength);
  item.locator = { kind: "css", selector: ":root" + " > *:nth-child(999999)".repeat(64) };
  page.items = Array.from({ length: limits.itemsPerPage }, () => item);
  map.pages = Array.from({ length: limits.pages }, () => page);
  assert.equal(isSiteCollectionMap(map), true);
  assert.equal(isSiteCollectionMap({ ...map, id: map.id + "x" }), false);
  assert.equal(isSiteCollectionMap({ ...map, siteAccountId: map.siteAccountId + "x" }), false);
  assert.equal(isSiteCollectionMap({ ...map, pages: [...map.pages, page] }), false);
  for (const patch of [
    { url: page.url + "x" },
    { items: [...page.items, item] },
    { items: [{ ...item, attributeKey: item.attributeKey + "x" }] },
    { items: [{ ...item, locator: { kind: "css", selector: ":root" + " > *:nth-child(1)".repeat(65) } }] },
    { items: [{ ...item, locator: { kind: "field-id", fieldId: "f-1000000" } }] },
  ]) {
    assert.equal(isSiteCollectionMap({ ...map, pages: [{ ...page, ...patch }] }), false);
  }
});

test("map fingerprints require fixed-length lowercase SHA-256 encoding", () => {
  for (const fingerprint of [
    "4111111111111234",
    "user@example.test",
    "<body>fake</body>",
    "a".repeat(63),
    "a".repeat(65),
    "A".repeat(64),
    "g".repeat(64),
    "a".repeat(10000),
  ]) {
    const map = fixture();
    map.pages[0]!.fingerprint = fingerprint;
    assert.equal(isSiteCollectionMap(map), false);
    const itemMap = fixture();
    itemMap.pages[0]!.items[0]!.fingerprint = fingerprint;
    assert.equal(isSiteCollectionMap(itemMap), false);
  }
});

test("save and export reject map mutations through put/get/list and preserve the last valid file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "soroeru-map-mutation-"));
  try {
    const path = join(dir, "vault.json");
    const vault = await VaultV2.open(new FileVaultPersistence(path), "fake-passphrase");
    vault.put("siteCollectionMap", fixture());
    await vault.save();
    const original = await readFile(path, "utf8");
    for (const access of [
      () => vault.put("siteCollectionMap", fixture()),
      () => vault.get("siteCollectionMap", "map-1")!,
      () => vault.list("siteCollectionMap")[0]!,
    ]) {
      vault.put("siteCollectionMap", fixture());
      access().pages[0]!.items[0]!.locator = { kind: "css", selector: '[value="4111111111111234"]' };
      await assert.rejects(() => vault.save(), /invalid site collection map/);
      await assert.rejects(() => vault.exportEncrypted(), /invalid site collection map/);
      assert.equal(await readFile(path, "utf8"), original);
    }
    vault.put("siteCollectionMap", fixture()).id = "changed-id";
    await assert.rejects(() => vault.save(), /invalid site collection map/);
    vault.lock();
    const reopened = await VaultV2.open(new FileVaultPersistence(path), "fake-passphrase");
    assert.deepEqual(reopened.get("siteCollectionMap", "map-1"), fixture());
    reopened.lock();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
