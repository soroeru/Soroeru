// Phase 5 integration (docs/design/visibility-exploration.md §4, Issue #248):
// the existing collectDisclosures logic runs against every page the Phase 4
// PageExplorer visits, via collectDuringExploration. No new FieldCollector —
// classification, card sanitization, and dynamic-attribute candidates are the
// same code paths already covered by soroeru-disclosure-collector.test.ts;
// these tests verify the wiring across a multi-page exploration.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DecisionEngine } from "../../src/automation/decision-engine.js";
import { collectDuringExploration } from "../../src/automation/disclosure-collector.js";
import type { PageDriver } from "../../src/automation/page-driver.js";
import { PageExplorer } from "../../src/automation/page-explorer.js";
import { RuleEngine } from "../../src/automation/rule-engine.js";
import { WallDetectionService } from "../../src/automation/wall-detection.js";
import { DomainService } from "../../src/domain/domain-service.js";
import { VaultV2 } from "../../src/store/vault-v2.js";
import type { FormField, PageLink, PageSnapshot } from "../../src/types.js";

const PASSPHRASE = "exploration-collection-test-passphrase";

function snapshot(url: string, partial: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    url,
    title: "",
    fields: [],
    buttons: [],
    links: [],
    visibleText: "",
    iframeSrcs: [],
    wallMarkers: [],
    ...partial,
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

function links(...items: Array<[string, string]>): PageLink[] {
  return items.map(([text, href]) => ({ text, href }));
}

/** Scripted fake: serves per-URL snapshots and per-URL locally-read values. */
class FakeExplorationDriver implements PageDriver {
  private url = "";

  constructor(
    private readonly pages: Map<string, PageSnapshot>,
    private readonly valuesByUrl: Map<string, Record<string, string>> = new Map(),
    private readonly displayValuesByUrl: Map<string, Record<string, string>> = new Map(),
  ) {}

  async goto(url: string): Promise<void> {
    this.url = url;
  }
  currentUrl(): string {
    return this.url;
  }
  async snapshot(): Promise<PageSnapshot> {
    return this.pages.get(this.url) ?? snapshot(this.url);
  }
  async readValues(): Promise<Record<string, string>> {
    return this.valuesByUrl.get(this.url) ?? {};
  }
  async readDisplayValues(): Promise<Record<string, string>> {
    return this.displayValuesByUrl.get(this.url) ?? {};
  }
  async fillField(): Promise<void> {}
  async click(): Promise<void> {}
  async waitForReady(): Promise<void> {}
}

function makeExplorer(): PageExplorer {
  return new PageExplorer(new DecisionEngine(new RuleEngine()), new WallDetectionService());
}

async function withDomain(run: (domain: DomainService) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "soroeru-exploration-"));
  try {
    const vault = await VaultV2.open(join(dir, "vault.json"), PASSPHRASE);
    await run(new DomainService(vault));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("collects disclosures from every explored page, including read-only display values", async () => {
  await withDomain(async (domain) => {
    const site = domain.upsertSiteAccount({
      domain: "shop.example.test",
      url: "https://shop.example.test/mypage",
      displayName: "Shop",
    });

    const pages = new Map([
      [
        "https://shop.example.test/mypage",
        snapshot("https://shop.example.test/mypage", {
          links: links(["会員情報", "/profile"], ["お届け先住所", "/address"]),
        }),
      ],
      [
        "https://shop.example.test/profile",
        snapshot("https://shop.example.test/profile", {
          fields: [field("email", { autocomplete: "email", labels: ["メールアドレス"] })],
        }),
      ],
      [
        "https://shop.example.test/address",
        snapshot("https://shop.example.test/address", {
          fields: [field("zip", { name: "address[zip]", labels: ["郵便番号"] })],
          displayValues: [{ valueId: "d-phone", labelText: "電話番号", nearbyText: "" }],
        }),
      ],
    ]);
    const driver = new FakeExplorationDriver(
      pages,
      new Map([
        ["https://shop.example.test/profile", { email: "member@example.test" }],
        ["https://shop.example.test/address", { zip: "100-0001" }],
      ]),
      new Map([["https://shop.example.test/address", { "d-phone": "03-1234-5678" }]]),
    );

    const result = await collectDuringExploration(
      makeExplorer().explore(driver, "https://shop.example.test/mypage", site),
      { domain, siteAccount: site, pageDriver: driver, now: () => 1_700_000_000_000 },
    );

    assert.equal(result.wall, undefined);
    assert.equal(result.pagesCollected, 3);
    assert.equal(result.disclosures, 3);
    const disclosures = domain.listDisclosuresForSite(site.id);
    assert.equal(disclosures.length, 3);
    // Each disclosure points back at the explored page it was collected on.
    assert.equal(
      disclosures.find((d) => d.attributeKey === "email")?.sourcePageUrl,
      "https://shop.example.test/profile",
    );
    assert.equal(
      disclosures.find((d) => d.attributeKey === "postal.full")?.sourcePageUrl,
      "https://shop.example.test/address",
    );
    assert.equal(disclosures.find((d) => d.attributeKey === "email")?.siteHeldValue, "member@example.test");
    assert.equal(disclosures.find((d) => d.attributeKey === "postal.full")?.siteHeldValue, "100-0001");
    // The read-only display value went through the same synthetic-field path.
    assert.equal(disclosures.find((d) => d.attributeKey === "phone.full")?.siteHeldValue, "03-1234-5678");
  });
});

test("card numbers reached via exploration keep last-4 only and CVV is never stored", async () => {
  await withDomain(async (domain) => {
    const site = domain.upsertSiteAccount({
      domain: "billing.example.test",
      url: "https://billing.example.test/mypage",
      displayName: "Billing",
    });

    const pages = new Map([
      [
        "https://billing.example.test/mypage",
        snapshot("https://billing.example.test/mypage", { links: links(["お支払い方法", "/payment"]) }),
      ],
      [
        "https://billing.example.test/payment",
        snapshot("https://billing.example.test/payment", {
          fields: [
            field("card", { autocomplete: "cc-number", labels: ["カード番号"] }),
            field("cvv", { autocomplete: "cc-csc", labels: ["セキュリティコード"] }),
          ],
        }),
      ],
    ]);
    const driver = new FakeExplorationDriver(
      pages,
      new Map([["https://billing.example.test/payment", { card: "4111 1111 1111 1234", cvv: "999" }]]),
    );

    const result = await collectDuringExploration(
      makeExplorer().explore(driver, "https://billing.example.test/mypage", site),
      { domain, siteAccount: site, pageDriver: driver, now: () => 1_700_000_000_000 },
    );

    assert.equal(result.disclosures, 1);
    const disclosures = domain.listDisclosuresForSite(site.id);
    assert.equal(disclosures.find((d) => d.attributeKey === "card.number")?.siteHeldValue, "1234");
    assert.equal(disclosures.some((d) => d.attributeKey === "card.cvv"), false);
    // Neither the full PAN nor the CVV appears anywhere in stored records.
    const stored = JSON.stringify([domain.listDisclosuresForSite(site.id), domain.listEvidence()]);
    assert.equal(stored.includes("4111"), false);
    assert.equal(stored.includes("999"), false);
  });
});

test("unclassifiable required fields on explored pages become dynamic-attribute candidates", async () => {
  await withDomain(async (domain) => {
    const site = domain.upsertSiteAccount({
      domain: "profile.example.test",
      url: "https://profile.example.test/mypage",
      displayName: "Profile",
    });

    const pages = new Map([
      [
        "https://profile.example.test/mypage",
        snapshot("https://profile.example.test/mypage", { links: links(["会員情報", "/profile"]) }),
      ],
      [
        "https://profile.example.test/profile",
        snapshot("https://profile.example.test/profile", {
          fields: [field("occupation", { required: true, labels: ["職業"] })],
        }),
      ],
    ]);
    const driver = new FakeExplorationDriver(
      pages,
      new Map([["https://profile.example.test/profile", { occupation: "会社員" }]]),
    );

    const result = await collectDuringExploration(
      makeExplorer().explore(driver, "https://profile.example.test/mypage", site),
      { domain, siteAccount: site, pageDriver: driver, now: () => 1_700_000_000_000 },
    );

    assert.equal(result.dynamicCandidates, 1);
    const candidate = domain.listDynamicAttributeCandidates()[0];
    assert.equal(candidate?.status, "candidate");
    assert.equal(candidate?.label, "職業");
    assert.equal(candidate?.sourcePageUrl, "https://profile.example.test/profile");
  });
});

test("pauses collection on a wall and continues on resume() in the same session", async () => {
  await withDomain(async (domain) => {
    const site = domain.upsertSiteAccount({
      domain: "shop.example.test",
      url: "https://shop.example.test/mypage",
      displayName: "Shop",
    });

    const pages = new Map([
      [
        "https://shop.example.test/mypage",
        snapshot("https://shop.example.test/mypage", {
          fields: [field("email", { autocomplete: "email", labels: ["メールアドレス"] })],
          links: links(["会員情報", "/profile"]),
        }),
      ],
      [
        "https://shop.example.test/profile",
        snapshot("https://shop.example.test/profile", { wallMarkers: ["g-recaptcha"] }),
      ],
    ]);
    const driver = new FakeExplorationDriver(
      pages,
      new Map([
        ["https://shop.example.test/mypage", { email: "member@example.test" }],
        ["https://shop.example.test/profile", { zip: "100-0001" }],
      ]),
    );
    const explorer = makeExplorer();

    const paused = await collectDuringExploration(
      explorer.explore(driver, "https://shop.example.test/mypage", site),
      { domain, siteAccount: site, pageDriver: driver, now: () => 1_700_000_000_000 },
    );

    // The page before the wall was collected; the walled page was not.
    assert.equal(paused.pagesCollected, 1);
    assert.equal(paused.disclosures, 1);
    assert.equal(paused.wall?.url, "https://shop.example.test/profile");
    assert.equal(paused.wall?.wall.kind, "captcha");
    assert.deepEqual(paused.wall?.handoff.resumable, true);
    assert.equal(domain.listDisclosuresForSite(site.id).length, 1);

    // The human cleared the wall in the same session; the page now renders
    // its form normally.
    pages.set(
      "https://shop.example.test/profile",
      snapshot("https://shop.example.test/profile", {
        fields: [field("zip", { name: "address[zip]", labels: ["郵便番号"] })],
      }),
    );

    const resumed = await collectDuringExploration(explorer.resume(), {
      domain,
      siteAccount: site,
      pageDriver: driver,
      now: () => 1_700_000_100_000,
    });

    assert.equal(resumed.wall, undefined);
    assert.equal(resumed.pagesCollected, 1);
    assert.equal(resumed.disclosures, 1);
    const disclosures = domain.listDisclosuresForSite(site.id);
    assert.equal(disclosures.length, 2);
    assert.equal(
      disclosures.find((d) => d.attributeKey === "postal.full")?.sourcePageUrl,
      "https://shop.example.test/profile",
    );
  });
});
