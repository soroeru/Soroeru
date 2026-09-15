import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SiteCollectionMap } from "../../src/domain/entities.js";
import { isSiteCollectionMap } from "../../src/domain/site-collection-map.js";
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
        fingerprint: "fake-page-hash",
        items: [
          {
            attributeKey: "email",
            locator: { kind: "css", selector: ":root > *:nth-child(2) > *:nth-child(1)" },
            fingerprint: "fake-field-hash",
          },
          {
            attributeKey: "phone.full",
            locator: { kind: "field-id", fieldId: "f-2" },
            fingerprint: "fake-phone-hash",
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
    const vault = await VaultV2.open(path, "fake-passphrase");
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
    assert.equal((await readFile(path, "utf8")).includes("fake-page-hash"), false);
    const reopened = await VaultV2.open(path, "fake-passphrase");
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
    const vault = await VaultV2.open(join(dir, "vault.json"), "fake-passphrase");
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
