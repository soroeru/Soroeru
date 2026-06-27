import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainService } from "../../src/domain/domain-service.js";
import { computeLedgerInsights } from "../../src/domain/ledger-insights.js";
import { VaultV2 } from "../../src/store/vault-v2.js";
import type { LedgerFilterKey } from "../../src/domain/insights-types.js";

// Fake data only (docs/testing.md). Verifies issue #161's Account Relationship /
// stale / stalled filter derivation and the initial Reflection (RFC-002 §5.3 /
// §8.2): filters derive from the ledger, link to evidence, and the Reflection is
// a list of findings — never collapsed into a single bulk-approve.
const PASSPHRASE = "insights-test-passphrase";

async function openService(): Promise<{ dir: string; domain: DomainService }> {
  const dir = await mkdtemp(join(tmpdir(), "soroeru-insights-"));
  const vault = await VaultV2.open(join(dir, "vault.json"), PASSPHRASE);
  return { dir, domain: new DomainService(vault) };
}

function sitesIn(insights: ReturnType<typeof computeLedgerInsights>, key: LedgerFilterKey): string[] {
  return insights.filters.find((f) => f.key === key)?.sites.map((s) => s.siteAccountId) ?? [];
}

test("computeLedgerInsights derives the four filters from the ledger with evidence links", async () => {
  const { dir, domain } = await openService();
  try {
    // Canonical values so stale-state derives meaningfully.
    domain.setPersonalAttribute({ attributeKey: "phone.full", label: "電話", value: "09099998888", valueType: "phone" });

    // Site A: active newsletter + recurring billing.
    const a = domain.upsertSiteAccount({ domain: "a.test", displayName: "A" });
    const aEvidence = domain.addEvidence({ siteAccountId: a.id, pageUrl: "https://a.test/account", fieldLabel: "newsletter", maskedSnippet: "•" });
    domain.addAccountRelationship({ siteAccountId: a.id, kind: "newsletter", state: "active", evidenceIds: [aEvidence.id] });
    domain.addAccountRelationship({ siteAccountId: a.id, kind: "recurring-billing", state: "active" });

    // Site B: stale phone (site holds an old number vs the canonical one).
    const b = domain.upsertSiteAccount({ domain: "b.test", displayName: "B" });
    const bEvidence = domain.addEvidence({ siteAccountId: b.id, fieldLabel: "電話番号", maskedSnippet: "•••" });
    domain.addDisclosure({ siteAccountId: b.id, attributeKey: "phone.full", siteHeldValue: "09011112222", sourceKind: "form-field", evidenceIds: [bEvidence.id] });

    // Site C: collection stalled at a wall.
    const c = domain.upsertSiteAccount({ domain: "c.test", displayName: "C" });
    const cEvidence = domain.addEvidence({ siteAccountId: c.id, maskedSnippet: "captcha" });
    domain.addConstraint({ siteAccountId: c.id, kind: "wall", detail: "reCAPTCHA", evidenceIds: [cEvidence.id] });
    domain.saveCheckpoint({ workflow: "visibility", siteAccountId: c.id, step: "initial", status: "handoff" });

    const insights = computeLedgerInsights(domain);

    assert.deepEqual(sitesIn(insights, "newsletter"), [a.id]);
    assert.deepEqual(sitesIn(insights, "billing"), [a.id]);
    assert.deepEqual(sitesIn(insights, "stale-contact"), [b.id]);
    // C is stalled by the wall. A was imported but never collected, which is
    // different from a stalled collection run and must not be put in this bucket.
    assert.deepEqual(sitesIn(insights, "stalled"), [c.id]);

    const newsletterSite = insights.filters.find((f) => f.key === "newsletter")?.sites[0];
    assert.ok(newsletterSite);
    assert.equal(newsletterSite.evidence[0]?.fieldLabel, "newsletter");
    assert.ok(newsletterSite.nextAction.length > 0);

    const staleSite = insights.filters.find((f) => f.key === "stale-contact")?.sites[0];
    assert.equal(staleSite?.evidence[0]?.fieldLabel, "電話番号");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the initial Reflection is a list of findings, not a single bulk-approve", async () => {
  const { dir, domain } = await openService();
  try {
    domain.setPersonalAttribute({ attributeKey: "email", label: "メール", value: "new@x.test", valueType: "email" });
    const site = domain.upsertSiteAccount({ domain: "x.test", displayName: "X" });
    domain.addAccountRelationship({ siteAccountId: site.id, kind: "newsletter", state: "active" });
    domain.addDisclosure({ siteAccountId: site.id, attributeKey: "email", siteHeldValue: "old@x.test", sourceKind: "form-field" });

    const insights = computeLedgerInsights(domain);
    const kinds = insights.reflection.map((f) => f.kind);
    // Multiple distinct observations are surfaced (stale + newsletter at least),
    // each with its own count — the UI cannot reduce them to one approve.
    assert.ok(kinds.includes("stale"));
    assert.ok(kinds.includes("newsletter"));
    assert.ok(insights.reflection.length >= 2);
    assert.ok(insights.reflection.every((f) => f.count > 0 && f.summary.length > 0));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an over-disclosed site is reflected once it crosses the threshold", async () => {
  const { dir, domain } = await openService();
  try {
    const site = domain.upsertSiteAccount({ domain: "many.test", displayName: "Many" });
    for (const key of ["email", "phone.full", "address.full", "name.full", "postal.code"]) {
      domain.addDisclosure({ siteAccountId: site.id, attributeKey: key, siteHeldValue: "v", sourceKind: "form-field" });
    }
    const insights = computeLedgerInsights(domain);
    const overDisclosed = insights.reflection.find((f) => f.kind === "over-disclosed");
    assert.equal(overDisclosed?.count, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("re-collected duplicate disclosure rows do not inflate over-disclosure", async () => {
  const { dir, domain } = await openService();
  try {
    const site = domain.upsertSiteAccount({ domain: "repeat.test", displayName: "Repeat" });
    for (const key of ["email", "phone.full"]) {
      for (let i = 0; i < 3; i++) {
        domain.addDisclosure({ siteAccountId: site.id, attributeKey: key, siteHeldValue: "v", sourceKind: "form-field" });
      }
    }

    const insights = computeLedgerInsights(domain);

    assert.equal(insights.reflection.some((f) => f.kind === "over-disclosed"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
