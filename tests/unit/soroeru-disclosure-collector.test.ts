import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectDisclosures } from "../../src/automation/disclosure-collector.js";
import { DomainService } from "../../src/domain/domain-service.js";
import { VaultV2 } from "../../src/store/vault-v2.js";
import type { FormField, PageSnapshot } from "../../src/types.js";

const PASSPHRASE = "collector-test-passphrase";

test("disclosure collector records manual-import disclosures and skips empty template fields", async () => {
  const dir = await mkdtemp(join(tmpdir(), "soroeru-collector-"));
  try {
    const vault = await VaultV2.open(join(dir, "vault.json"), PASSPHRASE);
    const domain = new DomainService(vault);
    const site = domain.upsertSiteAccount({
      domain: "shop.example.test",
      url: "https://shop.example.test/account",
      displayName: "Shop",
    });

    const fields = [
      field("zip", { name: "address[zip]" }),
      field("city", { name: "address[city]" }),
      field("empty", { name: "address-[zip]" }),
    ];
    const result = collectDisclosures({
      domain,
      siteAccount: site,
      snapshot: snapshot(fields),
      fields,
      values: {
        zip: "100-0001",
        city: "千代田区",
        empty: "",
      },
      sourceKind: "manual-import",
      now: () => 1_700_000_000_000,
    });

    assert.equal(result.disclosures, 2);
    const disclosures = domain.listDisclosuresForSite(site.id);
    assert.equal(disclosures.length, 2);
    assert.ok(disclosures.every((disclosure) => disclosure.sourceKind === "manual-import"));
    assert.ok(disclosures.every((disclosure) => disclosure.siteHeldValue === undefined));
    assert.equal(disclosures.find((disclosure) => disclosure.attributeKey === "postal.full")?.sourcePageUrl, "https://shop.example.test/account");

    const serialized = JSON.stringify({ disclosures, evidence: domain.listEvidence() });
    assert.equal(serialized.includes("100-0001"), false);
    assert.equal(serialized.includes("千代田区"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function snapshot(fields: FormField[]): PageSnapshot {
  return {
    url: "https://shop.example.test/account",
    title: "Account",
    fields,
    buttons: [],
    links: [],
    visibleText: "",
    iframeSrcs: [],
    wallMarkers: [],
  };
}

function field(fieldId: string, overrides: Partial<FormField>): FormField {
  return {
    fieldId,
    tag: "input",
    type: "text",
    name: "",
    id: fieldId,
    autocomplete: "",
    required: false,
    placeholder: "",
    labels: [],
    nearbyText: "",
    ...overrides,
  };
}
