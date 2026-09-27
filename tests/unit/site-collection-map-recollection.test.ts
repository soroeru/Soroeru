import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";
import { PlaywrightPageDriver } from "../../src/automation/browser-engine.js";
import { collectAiVisibility } from "../../src/automation/ai-visibility-collector.js";
import { buildMapPage, mapPageUrl, matchMapPage, mergeMapPages } from "../../src/automation/collection-map.js";
import {
  isCollectionFingerprints,
  structuralFingerprintInPage,
  type CollectionObservation,
  type FingerprintElement,
} from "../../src/automation/collection-observation.js";
import type { PageDriver } from "../../src/automation/page-driver.js";
import { VisibilityRunner } from "../../src/automation/visibility-runner.js";
import type { AiProvider } from "../../src/agent/ai/provider.js";
import { DomainService } from "../../src/domain/domain-service.js";
import { isSiteCollectionMap } from "../../src/domain/site-collection-map.js";
import { VaultV2 } from "../../src/store/vault-v2.js";
import type { FormField } from "../../src/types.js";

const siteUrl = "https://example.test/";
const XHTML = "http://www.w3.org/1999/xhtml";
const hex = (c: string): string => c.repeat(64);

function el(localName: string, children: FingerprintElement[] = [], type?: string, ns: string | null = XHTML): FingerprintElement {
  return { localName, namespaceURI: ns, children, ...(type !== undefined ? { type } : {}) };
}
const sha = (tuples: unknown): string => createHash("sha256").update(JSON.stringify(tuples), "utf8").digest("hex");

test("structural fingerprint follows the architecture tuple contract and matches SHA-256", () => {
  const root = el("body", [
    el("div", [el("input", [], "email"), el("script"), el("my-widget")]),
    el("style"),
    el("svg", [], undefined, "http://www.w3.org/2000/svg"),
    el("SPAN"),
  ]);
  assert.equal(structuralFingerprintInPage(root), sha([
    [[], "body", ""], [[1], "div", ""], [[1, 1], "input", "email"], [[1, 2], "other", ""],
    [[2], "other", ""], [[3], "span", ""],
  ]));
  // Every padding boundary around one and two SHA-256 blocks.
  for (let n = 0; n < 40; n++) {
    const tree = el("p", Array.from({ length: n }, () => el("b")));
    const tuples = [[[], "p", ""], ...Array.from({ length: n }, (_, i) => [[i + 1], "b", ""])];
    assert.equal(structuralFingerprintInPage(tree), sha(tuples));
  }
  assert.equal(structuralFingerprintInPage(el("div", Array.from({ length: 20_001 }, () => el("i")))), "");
});

test("fingerprint envelope validation rejects non-scanner IDs and non-hex hashes", () => {
  assert.equal(isCollectionFingerprints({ page: hex("a"), items: { "f-1": hex("b"), "d-2": hex("c") } }), true);
  for (const bad of [{ page: "x", items: {} }, { page: hex("a"), items: { "#email": hex("b") } }, { page: hex("a"), items: { "f-1": "B".repeat(64) } },
    { page: hex("a"), items: {}, extra: 1 }, { page: hex("a"), items: [] }]) {
    assert.equal(isCollectionFingerprints(bad), false);
  }
});

const emailField: FormField = { fieldId: "f-1", tag: "input", type: "email", name: "email", id: "email", labels: ["メールアドレス"], autocomplete: "email", placeholder: "", nearbyText: "", required: false };
const phoneField: FormField = { fieldId: "f-2", tag: "input", type: "tel", name: "tel", id: "tel", labels: ["電話番号"], autocomplete: "tel", placeholder: "", nearbyText: "", required: false };

function observation(path: string, overrides: { page?: string; items?: Record<string, string>; values?: [string, string] } = {}): CollectionObservation {
  const [email, phone] = overrides.values ?? ["fake@example.test", "090-0000-0000"];
  return {
    token: { observationId: `${path}-${Math.random()}`, documentId: "doc", revision: 0, bindingEpoch: 1 },
    snapshot: { url: new URL(path, siteUrl).href, title: "Account", fields: [emailField, phoneField], links: [], buttons: [], visibleText: "", iframeSrcs: [], wallMarkers: [] },
    items: [{ id: "f-1", value: email, field: emailField }, { id: "f-2", value: phone, field: phoneField }],
    targets: [],
    fingerprints: { page: overrides.page ?? hex("a"), items: overrides.items ?? { "f-1": hex("1"), "f-2": hex("2") } },
  };
}

test("map pages keep only corroborated, fingerprinted items at query-free same-site URLs", () => {
  const o = observation("/profile");
  const facts = [
    { observationId: o.token.observationId, itemId: "f-1", attributeKey: "email" as const, corroborated: true },
    { observationId: o.token.observationId, itemId: "f-2", attributeKey: "phone.full" as const, corroborated: false },
  ];
  const page = buildMapPage(o, "contact", facts, siteUrl)!;
  assert.deepEqual(page, { url: siteUrl + "profile", purpose: "profile", fingerprint: hex("a"),
    items: [{ attributeKey: "email", locator: { kind: "field-id", fieldId: "f-1" }, fingerprint: hex("1") }] });
  assert.doesNotMatch(JSON.stringify(page), /fake@example|090/);
  assert.equal(buildMapPage({ ...o, snapshot: { ...o.snapshot, url: siteUrl + "profile?tab=1" } }, "profile", facts, siteUrl), undefined);
  const { fingerprints: _omit, ...unprinted } = o;
  assert.equal(buildMapPage(unprinted, "profile", facts, siteUrl), undefined);
  assert.equal(mapPageUrl(siteUrl + "profile#x", siteUrl), siteUrl + "profile");
  assert.equal(mapPageUrl("https://evil.test/profile", siteUrl), undefined);
  assert.deepEqual(mergeMapPages([page, { ...page, purpose: "other" }]).map(p => p.purpose), ["other"]);
});

test("map matching isolates each mismatched entry and never reads another element", () => {
  const o = observation("/profile");
  const page = { url: siteUrl + "profile", purpose: "profile" as const, fingerprint: hex("a"), items: [
    { attributeKey: "email", locator: { kind: "field-id" as const, fieldId: "f-1" }, fingerprint: hex("1") },
    { attributeKey: "phone.full", locator: { kind: "field-id" as const, fieldId: "f-2" }, fingerprint: hex("9") },
    { attributeKey: "name.full", locator: { kind: "field-id" as const, fieldId: "f-7" }, fingerprint: hex("7") },
    { attributeKey: "name.full", locator: { kind: "field-id" as const, fieldId: "f-1" }, fingerprint: hex("1") },
  ] };
  const match = matchMapPage(page, o, siteUrl);
  assert.deepEqual(match.matched.map(m => [m.item.id, m.attributeKey]), [["f-1", "email"]]);
  assert.deepEqual(match.mismatched.map(m => m.reason), ["item-changed", "selector-miss", "classification"]);
  assert.deepEqual(new Set(matchMapPage(page, observation("/profile", { page: hex("b") }), siteUrl).mismatched.map(m => m.reason)), new Set(["page-changed"]));
  assert.deepEqual(new Set(matchMapPage(page, observation("/elsewhere"), siteUrl).mismatched.map(m => m.reason)), new Set(["page-gone"]));
});

interface Harness {
  page: PageDriver;
  pages: Map<string, CollectionObservation>;
  navigations: string[];
  current: () => CollectionObservation;
}
function harness(): Harness {
  const pages = new Map<string, CollectionObservation>([[siteUrl + "profile", observation("/profile")]]);
  let current = pages.get(siteUrl + "profile")!;
  const navigations: string[] = [];
  const at = (url: string): CollectionObservation => {
    const found = pages.get(url);
    if (!found) throw new Error("navigation refused");
    return { ...found, token: { ...found.token, observationId: `${url}-${Math.random()}` } };
  };
  const page: PageDriver = {
    goto: async url => { current = at(url === siteUrl ? siteUrl + "profile" : url); },
    currentUrl: () => current.snapshot.url,
    snapshot: async () => current.snapshot,
    readValues: async () => Object.fromEntries(current.items.map(i => [i.id, i.value])),
    fillField: async () => {}, click: async () => {}, waitForReady: async () => {},
    captureCollectionObservation: async () => current,
    checkCollectionObservation: async () => true,
    gotoCollection: async url => { navigations.push(url); current = at(url); },
  };
  return { page, pages, navigations, current: () => current };
}

async function setup(h: Harness) {
  const dir = await mkdtemp(join(tmpdir(), "collection-518-"));
  const path = join(dir, "vault.json");
  const vault = await VaultV2.open(path, "fake-passphrase");
  const domain = new DomainService(vault);
  const site = domain.upsertSiteAccount({ domain: "example.test", url: siteUrl, displayName: "Fake" });
  let calls = 0;
  const provider: AiProvider = { id: "fake", completeJson: async request => {
    calls++;
    const input = JSON.parse(request.user) as { observationId: string };
    const o = h.current();
    return { observationId: input.observationId, pagePurpose: "contact", done: true, nextTargetIds: [], values: [
      { itemId: "f-1", attributeKey: "email", value: o.items[0]!.value, confidence: 1 },
      { itemId: "f-2", attributeKey: "phone.full", value: o.items[1]!.value, confidence: 1 },
    ] };
  } };
  const grant = (context: { siteAccountId: string; runId: string; epoch: number }) => {
    vault.put("mandate", { id: "m", siteAccountId: site.id, operation: "ai-assisted-discovery", authorizedAt: 2, scope: context.runId });
    vault.put("capability", { id: "c", operationType: "ai-assisted-discovery", level: "L0", updatedAt: 1 });
    return { ...context, mandateId: "m", capabilityId: "c", capabilityUpdatedAt: 1 };
  };
  const runner = (withGrant = true) => new VisibilityRunner({ domain, openSession: async () => ({ page: h.page, close: async () => {} }),
    collectionProvider: provider, ...(withGrant ? { collectionGrant: grant } : {}) });
  return { dir, path, vault, domain, site, runner, calls: () => calls };
}

test("an AI-driven run saves a valid, value-free SiteCollectionMap", async () => {
  const h = harness(), s = await setup(h);
  try {
    const r = await s.runner().runSite(s.site.id);
    assert.equal(r.status, "collected"); assert.equal(s.calls(), 1);
    const map = s.domain.getSiteCollectionMap(s.site.id)!;
    assert.equal(isSiteCollectionMap(map), true);
    assert.equal(map.revision, 1); assert.equal(map.generationStatus, "ready"); assert.equal(map.provenance.kind, "ai-driven");
    assert.deepEqual(map.pages.map(p => [p.url, p.purpose, p.items.map(i => i.attributeKey)]), [[siteUrl + "profile", "profile", ["email", "phone.full"]]]);
    assert.doesNotMatch(JSON.stringify(map), /fake@example|090-0000/);
    await s.vault.save();
    assert.doesNotMatch(await readFile(s.path, "utf8"), /example\.test\/profile|f-1/);
    const reopened = new DomainService(await VaultV2.open(s.path, "fake-passphrase"));
    assert.deepEqual(reopened.getSiteCollectionMap(s.site.id), map);
  } finally { await rm(s.dir, { recursive: true, force: true }); }
});

test("recollection of a known site runs from the map locally with no provider call", async () => {
  const h = harness(), s = await setup(h);
  try {
    await s.runner().runSite(s.site.id);
    h.pages.set(siteUrl + "profile", observation("/profile", { values: ["new@example.test", "080-1111-2222"] }));
    await h.page.goto(siteUrl + "profile");
    const r = await s.runner().runSite(s.site.id);
    assert.equal(s.calls(), 1, "no provider call during map-based recollection");
    assert.equal(r.status, "collected"); assert.equal(r.disclosures, 2);
    const fresh = s.domain.listDisclosures().filter(d => d.siteHeldValue === "new@example.test" || d.siteHeldValue === "08011112222" || d.siteHeldValue === "080-1111-2222");
    assert.equal(fresh.length, 2);
    assert.ok(fresh.every(d => d.collectionTier === "ai-driven"));
    assert.equal(s.domain.getSiteCollectionMap(s.site.id)!.revision, 1);
  } finally { await rm(s.dir, { recursive: true, force: true }); }
});

test("a mismatched entry is isolated, falls back to the deterministic tier, and never regenerates the map", async () => {
  const h = harness(), s = await setup(h);
  try {
    await s.runner().runSite(s.site.id);
    const before = s.domain.getSiteCollectionMap(s.site.id)!;
    h.pages.set(siteUrl + "profile", observation("/profile", { items: { "f-1": hex("1"), "f-2": hex("f") }, values: ["new@example.test", "080-1111-2222"] }));
    await h.page.goto(siteUrl + "profile");
    const r = await s.runner().runSite(s.site.id);
    assert.equal(s.calls(), 1, "mismatch never triggers an automatic AI pass");
    assert.equal(r.status, "collected");
    const email = s.domain.listDisclosures().find(d => d.siteHeldValue === "new@example.test")!;
    assert.equal(email.collectionTier, "ai-driven");
    const phone = s.domain.listDisclosures().find(d => d.attributeKey === "phone.full" && d.collectionTier === "deterministic");
    assert.ok(phone, "the mismatched entry is still collected by the deterministic tier");
    assert.ok(s.domain.listConstraints().some(c => c.kind === "unknown-state" && /map mismatch \(1 entries\)/.test(c.detail)));
    assert.deepEqual(s.domain.getSiteCollectionMap(s.site.id), before);
  } finally { await rm(s.dir, { recursive: true, force: true }); }
});

test("when no mapped page can be reached, the run falls back to deterministic exploration without AI", async () => {
  const h = harness(), s = await setup(h);
  try {
    h.pages.set(siteUrl + "account", observation("/account"));
    await h.page.goto(siteUrl + "account");
    s.domain.saveSiteCollectionMap({ siteAccountId: s.site.id, generationStatus: "ready", observedAt: 1, pages: [
      { url: siteUrl + "gone", purpose: "profile", fingerprint: hex("a"), items: [{ attributeKey: "email", locator: { kind: "field-id", fieldId: "f-1" }, fingerprint: hex("1") }] },
    ] });
    const r = await s.runner().runSite(s.site.id);
    assert.equal(s.calls(), 0);
    assert.deepEqual(h.navigations, [siteUrl + "gone"]);
    assert.equal(r.status, "collected");
    assert.ok(s.domain.listDisclosures().every(d => d.collectionTier === "deterministic"));
    assert.ok(s.domain.listConstraints().some(c => /pages were not found; regenerate/.test(c.detail)));
    assert.equal(s.domain.getSiteCollectionMap(s.site.id)!.revision, 1);
  } finally { await rm(s.dir, { recursive: true, force: true }); }
});

test("only an explicit user regeneration request runs AI again and replaces the map", async () => {
  const h = harness(), s = await setup(h);
  try {
    await s.runner().runSite(s.site.id);
    await s.runner().runSite(s.site.id);
    assert.equal(s.calls(), 1);
    const r = await s.runner().runSite(s.site.id, { regenerateCollectionMap: true });
    assert.equal(r.status, "collected"); assert.equal(s.calls(), 2);
    assert.equal(s.domain.getSiteCollectionMap(s.site.id)!.revision, 2);
    assert.equal(s.vault.list("siteCollectionMap").length, 1);
  } finally { await rm(s.dir, { recursive: true, force: true }); }
});

test("without a live collection grant the stored map is not used", async () => {
  const h = harness(), s = await setup(h);
  try {
    await s.runner().runSite(s.site.id);
    const r = await s.runner(false).runSite(s.site.id);
    assert.equal(s.calls(), 1); assert.equal(r.status, "collected");
    assert.equal(h.navigations.length, 0);
    assert.ok(!s.domain.listConstraints().some(c => /map/.test(c.detail)));
  } finally { await rm(s.dir, { recursive: true, force: true }); }
});

test("the collector emits map pages only for committed AI-driven batches", async () => {
  const h = harness();
  const base = { page: h.page, siteUrl, authorized: () => true, isCanceled: () => false, unknown: () => {}, wall: async () => false,
    tos: async () => "pending" as const, commit: async () => ({ disclosures: 1, relationships: 0 }) };
  const aiProvider: AiProvider = { id: "fake", completeJson: async request => {
    const input = JSON.parse(request.user) as { observationId: string };
    return { observationId: input.observationId, pagePurpose: "profile", done: true, nextTargetIds: [], values: [{ itemId: "f-1", attributeKey: "email", value: "fake@example.test", confidence: 1 }] };
  } };
  const ai = await collectAiVisibility({ ...base, provider: aiProvider });
  assert.equal(ai.mapPages.length, 1);
  const rules = await collectAiVisibility({ ...base, provider: { id: "fake", completeJson: async () => { throw new Error("down"); } } });
  assert.equal(rules.fallbackReason, "provider-error"); assert.equal(rules.mapPages.length, 0);
  const discarded = await collectAiVisibility({ ...base, provider: aiProvider, commit: async () => undefined });
  assert.equal(discarded.mapPages.length, 0);
});

test("real in-page capture yields stable value-free fingerprints that change with structure only", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const html = (email: string, extra = "") => `<!doctype html><html><body><form><label for="e">メールアドレス</label>
      <input id="e" type="email" autocomplete="email" value="${email}"></form>${extra}<script>void 0</script></body></html>`;
    let body = "";
    // A secure https origin (crypto.randomUUID), served locally with no network.
    await page.route(siteUrl + "**", route => route.fulfill({ contentType: "text/html", body }));
    const capture = async (content: string) => {
      body = content;
      await page.goto(siteUrl + "profile");
      return new PlaywrightPageDriver(page).captureCollectionObservation(new AbortController().signal);
    };
    const first = await capture(html("fake@example.test"));
    const valueChanged = await capture(html("other@example.test"));
    const structureChanged = await capture(html("fake@example.test", "<section><p></p></section>"));
    assert.ok(isCollectionFingerprints(first.fingerprints));
    const id = first.items[0]!.id;
    assert.deepEqual(valueChanged.fingerprints, first.fingerprints, "values and text never affect fingerprints");
    assert.notEqual(structureChanged.fingerprints!.page, first.fingerprints!.page);
    assert.equal(structureChanged.fingerprints!.items[id], first.fingerprints!.items[id]);
    assert.equal(first.fingerprints!.items[id], sha([[[], "input", "email"]]));
  } finally { await browser.close(); }
});
