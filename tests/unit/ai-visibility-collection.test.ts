import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectAiVisibility, type AiCollectionOptions, type CollectionBatch } from "../../src/automation/ai-visibility-collector.js";
import { collectionEnvelope, collectionInput, parseCollectionProposal, corroborateProposal, MASKED_VALUE } from "../../src/automation/ai-visibility-contract.js";
import { collectionNavigation, collectionUrlAllowed } from "../../src/automation/visibility-navigation-policy.js";
import type { CollectionObservation } from "../../src/automation/collection-observation.js";
import type { PageDriver } from "../../src/automation/page-driver.js";
import type { FormField } from "../../src/types.js";
import type { AiProvider } from "../../src/agent/ai/provider.js";
import { FileVaultPersistence } from "../../src/store/file-vault-persistence.js";
import { VaultV2 } from "../../src/store/vault-v2.js";
import { DomainService } from "../../src/domain/domain-service.js";
import { VisibilityRunner } from "../../src/automation/visibility-runner.js";

const siteUrl = "https://example.test/";
function observation(path = "/profile", value = "fake@example.test", field: Partial<FormField> = {}): CollectionObservation {
  return { token: { observationId: path, documentId: "doc", revision: 0, bindingEpoch: 1 },
    snapshot: { url: new URL(path, siteUrl).href, title: "Account", fields: [], links: [], buttons: [], visibleText: "", iframeSrcs: [], wallMarkers: [] },
    items: [{ id: "f-1", value, field: { fieldId: "f-1", tag: "input", type: "email", name: "email", id: "email", labels: ["メールアドレス"], autocomplete: "email", placeholder: "", nearbyText: "", required: false, ...field } }], targets: [] };
}
function item(id: string, value: string, field: Partial<FormField>): CollectionObservation["items"][number] {
  return { id, value, field: { fieldId: id, tag: "input", type: "text", name: "", id: "", labels: [], autocomplete: "", placeholder: "", nearbyText: "", required: false, ...field } };
}
// Fake secrets only (Issue #572): each must stay out of every provider request.
const SECRETS = { password: "Fake-Pass-4821", cvv: "7319", otp: "602418", answer: "fake-secret-answer" };
function secretObservation(): CollectionObservation {
  const o = observation();
  o.items.push(
    item("f-2", SECRETS.password, { type: "password", name: "login_pw", labels: ["ログインパスワード"] }),
    item("f-3", SECRETS.cvv, { name: "cc_code", autocomplete: "cc-csc", labels: ["セキュリティコード"] }),
    item("f-4", SECRETS.otp, { name: "code", autocomplete: "one-time-code", labels: ["確認番号"] }),
    item("f-5", SECRETS.answer, { name: "q1", labels: ["秘密の質問の答え"] }),
    // A display row whose nearby text echoes the preceding row's secret value.
    item("d-1", "fake-holder", { labels: ["名義"], nearbyText: `${SECRETS.cvv} 名義` }),
  );
  o.targets = [{ id: "n-0", href: `${siteUrl}help?code=${SECRETS.otp}`, text: "ヘルプ", passive: true }];
  return o;
}
function proposal(o: CollectionObservation, overrides: Record<string, unknown> = {}) {
  return { observationId: o.token.observationId, pagePurpose: "profile", values: [{ itemId: "f-1", attributeKey: "email", value: o.items[0]!.value, confidence: 1 }], nextTargetIds: [], done: true, ...overrides };
}
function fixture(provider?: AiProvider) {
  let current = observation(), fresh = true, canceled = false, allowed = true;
  const batches: CollectionBatch[] = [], navigations: string[] = [];
  const page: PageDriver = {
    goto: async () => {}, currentUrl: () => current.snapshot.url, snapshot: async () => current.snapshot,
    readValues: async () => ({}), fillField: async () => {}, click: async () => {}, waitForReady: async () => {},
    captureCollectionObservation: async () => current, checkCollectionObservation: async () => fresh,
    gotoCollection: async url => { navigations.push(url); current = observation(new URL(url).pathname, "second@example.test"); },
  };
  const options: AiCollectionOptions = { page, siteUrl, provider: provider ?? { id: "fake", completeJson: async () => proposal(current) },
    authorized: () => allowed, isCanceled: () => canceled,
    commit: async batch => { batches.push(batch); return { disclosures: batch.candidates.length, relationships: 0 }; },
    unknown: () => {}, wall: async () => false, tos: async () => "pending" };
  return { options, batches, navigations, current: () => current, set: (v: CollectionObservation) => { current = v; },
    stale: () => { fresh = false; }, cancel: () => { canceled = true; }, revoke: () => { allowed = false; } };
}

test("AI observes raw fake values with no tools, and commits before moving to the next page", async () => {
  const f = fixture();
  f.current().targets = [{ id: "n-0", href: siteUrl + "contact", text: "連絡先", passive: true }];
  f.options.provider = { id: "fake", completeJson: async request => {
    assert.equal(request.maxRetries, 0); assert.equal(request.maxTokens, 2048);
    assert.ok(request.signal); assert.equal("tools" in request, false);
    assert.match(request.user, /fake@example.test|second@example.test/);
    if (f.navigations.length) assert.equal(f.batches.length, 1);
    return proposal(f.current(), f.navigations.length ? {} : { nextTargetIds: ["n-0"], done: false });
  }};
  const r = await collectAiVisibility(f.options);
  assert.equal(r.reason, "complete"); assert.equal(r.disclosures, 2); assert.equal(r.calls, 2);
  assert.equal(f.batches[0]?.tier, "ai-driven");
  assert.doesNotMatch(JSON.stringify(r), /fake@example|second@example/);
});

test("provider requests never carry password, CVV, OTP or secret-like values; other raw values still go", async () => {
  const f = fixture(); f.set(secretObservation());
  const requests: { system: string; user: string }[] = [];
  f.options.provider = { id: "fake", completeJson: async request => { requests.push({ system: request.system, user: request.user }); return proposal(f.current()); } };
  const r = await collectAiVisibility(f.options);
  assert.equal(r.reason, "complete"); assert.equal(requests.length, 1);
  const raw = JSON.stringify(requests);
  for (const secret of Object.values(SECRETS)) assert.equal(raw.includes(secret), false, "a secret reached the provider");
  assert.match(requests[0]!.user, /fake@example\.test/);
  const sent = JSON.parse(requests[0]!.user) as ReturnType<typeof collectionEnvelope>;
  assert.equal(sent.items.find(i => i.id === "d-1")?.field.nearbyText, `${MASKED_VALUE} 名義`);
  assert.deepEqual(sent.items.filter(i => i.masked).map(i => [i.id, i.value, i.field.nearbyText]),
    ["f-2", "f-3", "f-4", "f-5"].map(id => [id, MASKED_VALUE, ""]));
  assert.deepEqual(sent.items.find(i => i.id === "f-3")?.field.labels, ["セキュリティコード"]);
});

test("a masked item is stored from the locally read value only when local classification agrees with the model", () => {
  const o = secretObservation(), input = collectionInput(o);
  const parsed = parseCollectionProposal(proposal(o, { values: [
    { itemId: "f-3", attributeKey: "card.cvv", value: MASKED_VALUE, confidence: 0.9 },
    { itemId: "f-2", attributeKey: "account.password", value: "model-invented", confidence: 0.9 },
    { itemId: "f-4", attributeKey: "phone.full", value: MASKED_VALUE, confidence: 0.9 },
    { itemId: "f-5", attributeKey: "name.full", value: MASKED_VALUE, confidence: 0.9 },
  ] }), input)!;
  const { candidates, facts } = corroborateProposal(parsed, input);
  assert.deepEqual(candidates.map(c => [c.attributeKey, c.item.value]), [["card.cvv", SECRETS.cvv], ["account.password", SECRETS.password]]);
  assert.deepEqual(facts.filter(x => !x.corroborated).map(x => x.itemId), ["f-4", "f-5"]);
});

test("echoes of unadmitted secrets are scrubbed too: a PIN row and an over-budget password", () => {
  const o = observation();
  o.items.push(
    item("f-6", "4821", { labels: ["暗証番号"] }),
    item("f-7", SECRETS.password, { type: "password", labels: ["x".repeat(17_000)] }),
    item("d-2", "fake-note", { labels: ["備考"], nearbyText: `4821 ${SECRETS.password} 備考` }),
  );
  const input = collectionInput(o), sent = JSON.stringify(collectionEnvelope(input));
  assert.deepEqual(input.items.map(i => i.id), ["f-1", "d-2"]);
  assert.equal(sent.includes("4821"), false); assert.equal(sent.includes(SECRETS.password), false);
  assert.equal(sent.includes('"secrets"'), false);
});

test("a CVV inside a longer number is not scrubbed; a delimited echo masks the item, which still corroborates locally", () => {
  const o = observation();
  o.items.push(
    item("f-3", SECRETS.cvv, { autocomplete: "cc-csc", labels: ["セキュリティコード"] }),
    item("f-8", `090${SECRETS.cvv}5555`, { type: "tel", labels: ["電話番号"] }),
    item("f-9", `03-${SECRETS.cvv}-5555`, { type: "tel", labels: ["自宅電話"] }),
  );
  const input = collectionInput(o), sent = collectionEnvelope(input);
  assert.equal(sent.items.find(i => i.id === "f-8")?.value, `090${SECRETS.cvv}5555`);
  assert.deepEqual(input.masked, ["f-3", "f-9"]);
  const values = [{ itemId: "f-8", attributeKey: "phone.full", value: `090${SECRETS.cvv}5555`, confidence: 1 },
    { itemId: "f-9", attributeKey: "email", value: MASKED_VALUE, confidence: 1 }];
  const { candidates } = corroborateProposal(parseCollectionProposal(proposal(o, { values }), input)!, input);
  assert.deepEqual(candidates.map(c => c.item.id), ["f-8"]);
  const phone = corroborateProposal(parseCollectionProposal(proposal(o, { values: [{ ...values[1]!, attributeKey: "phone.full" }] }), input)!, input);
  assert.equal(phone.candidates[0]?.item.value, `03-${SECRETS.cvv}-5555`);
});

test("a hint-masked masked PAN never corroborates as card.number; camelCase secret names are masked", () => {
  const o = observation();
  o.items.push(
    item("d-3", "**** **** **** 1234", { labels: ["カード番号（セキュリティコードは表示されません）"] }),
    item("f-10", SECRETS.answer, { name: "loginPw" }),
  );
  const input = collectionInput(o);
  assert.deepEqual(input.masked, ["d-3", "f-10"]);
  const parsed = parseCollectionProposal(proposal(o, { values: [{ itemId: "d-3", attributeKey: "card.number", value: MASKED_VALUE, confidence: 1 }] }), input)!;
  assert.deepEqual(corroborateProposal(parsed, input).candidates, []);
});

test("unsupported hallucination becomes a review fact, never a candidate", async () => {
  const f = fixture();
  f.options.provider = { id: "fake", completeJson: async () => proposal(f.current(), { values: [{ itemId: "f-1", attributeKey: "email", value: "invented@example.test", confidence: 1 }] }) };
  const r = await collectAiVisibility(f.options);
  assert.equal(r.disclosures, 0); assert.equal(r.facts[0]?.corroborated, false);
  assert.doesNotMatch(JSON.stringify(r), /invented/);
});

for (const mode of ["provider-error", "invalid-response", "ai-canceled", "budget"] as const) {
  test(`${mode} switches to rules-only on the same page without renewing the page budget`, async () => {
    const f = fixture();
    if (mode === "provider-error") f.options.provider = { id: "fake", completeJson: async () => { throw new Error("private provider body"); } };
    if (mode === "invalid-response") f.options.provider = { id: "fake", completeJson: async () => ({ tools: ["click"] }) };
    if (mode === "ai-canceled") f.options.aiSignal = AbortSignal.abort();
    if (mode === "budget") f.options.limits = { calls: 0 };
    const r = await collectAiVisibility(f.options);
    assert.equal(r.fallbackReason, mode); assert.equal(r.pages, 1);
    assert.equal(f.batches[0]?.tier, "deterministic"); assert.equal(f.navigations.length, 0);
    assert.doesNotMatch(JSON.stringify(r), /private provider/);
  });
}

test("a hung provider is bounded and a late reply cannot write", async () => {
  const f = fixture({ id: "fake", completeJson: () => new Promise(() => {}) });
  f.options.limits = { callMs: 5 };
  const r = await collectAiVisibility(f.options);
  assert.equal(r.fallbackReason, "provider-error"); assert.equal(f.batches[0]?.tier, "deterministic");
});

for (const change of ["stale", "cancel", "revoke"] as const) {
  test(`${change} during the model call discards values`, async () => {
    const f = fixture();
    f.options.provider = { id: "fake", completeJson: async () => { f[change](); return proposal(f.current()); } };
    const r = await collectAiVisibility(f.options);
    assert.notEqual(r.reason, "complete"); assert.equal(f.batches.length, 0); assert.equal(f.navigations.length, 0);
  });
}

test("wall handoff continues deterministically from the human's current page, never re-goto", async () => {
  const f = fixture(); f.current().snapshot.wallMarkers = ["captcha"];
  f.current().snapshot.visibleText = "私はロボットではありません";
  let reads = 0; f.options.page.captureCollectionObservation = async () => { reads++; return f.current(); };
  f.options.wall = async () => { assert.equal(reads, 0); f.set(observation("/contact")); return true; };
  const r = await collectAiVisibility(f.options);
  assert.equal(r.fallbackReason, "wall"); assert.equal(f.batches[0]?.tier, "deterministic"); assert.equal(f.navigations.length, 0);
});

for (const decision of ["pending", "stop", "proceed"] as const) {
  test(`ToS decision ${decision} gates raw requests and both tiers`, async () => {
    const f = fixture(); f.current().snapshot.visibleText = "スクレイピングを禁止";
    let calls = 0; f.options.provider = { id: "fake", completeJson: async () => { calls++; return proposal(f.current()); } };
    f.options.tos = async () => decision;
    const r = await collectAiVisibility(f.options);
    assert.equal(calls, decision === "proceed" ? 1 : 0);
    assert.equal(r.reason, decision === "proceed" ? "complete" : decision === "pending" ? "tos-pending" : "tos-stopped");
  });
}

test("unknown destination is pending without confirmation, and no deterministic detour occurs", async () => {
  const f = fixture(); f.current().targets = [{ id: "n-0", href: siteUrl + "misc", text: "その他", passive: true }];
  f.options.provider = { id: "fake", completeJson: async () => proposal(f.current(), { done: false, nextTargetIds: ["n-0"] }) };
  const r = await collectAiVisibility(f.options);
  assert.equal(r.reason, "unknown-destination"); assert.equal(f.navigations.length, 0);
});

for (const limits of [{ pages: 0 }, { tokens: 0 }, { depth: 0 }, { timeMs: 0 }]) {
  test(`local budget boundary ${JSON.stringify(limits)}`, async () => {
    const f = fixture(); f.options.limits = limits;
    f.current().targets = [{ id: "n-0", href: siteUrl + "contact", text: "連絡先", passive: true }];
    f.options.provider = { id: "fake", completeJson: async () => proposal(f.current(), { nextTargetIds: ["n-0"], done: false }) };
    const r = await collectAiVisibility(f.options);
    assert.ok(r.reason === "budget" || r.fallbackReason === "budget"); assert.equal(f.navigations.length, 0);
  });
}

test("strict output rejects extra keys, invented IDs, duplicate mappings, bad enums and non-finite confidence", () => {
  const o = observation(), input = collectionInput(o), good = proposal(o);
  for (const bad of [ { ...good, tools: [] }, { ...good, pagePurpose: "purchase" }, { ...good, nextTargetIds: ["missing"] },
    { ...good, values: [good.values[0], good.values[0]] }, { ...good, values: [{ ...good.values[0], selector: "*" }] },
    { ...good, values: [{ ...good.values[0], itemId: "missing" }] }, { ...good, values: [{ ...good.values[0], confidence: NaN }] },
    { ...good, values: [{ ...good.values[0], attributeKey: "custom.pin" }] }, { ...good, observationId: "old" } ]) {
    assert.equal(parseCollectionProposal(bad, input), undefined);
  }
});

test("corroboration is item-bound and conservative; PIN/My Number never enter the envelope", () => {
  const o = observation(); const input = collectionInput(o);
  const mismatch = parseCollectionProposal(proposal(o, { values: [{ itemId: "f-1", attributeKey: "name.full", value: o.items[0]!.value, confidence: 1 }] }), input)!;
  assert.equal(corroborateProposal(mismatch, input).candidates.length, 0);
  for (const secret of [observation("/profile", "1234", { labels: ["暗証番号"] }), observation("/profile", "123456789012")]) {
    assert.equal(collectionInput(secret).items.length, 0);
  }
});

for (const href of ["http://example.test/profile", "https://evil.test/profile", "https://sub.example.test/profile", "https://user:pass@example.test/profile", siteUrl + "profile?do=delete", siteUrl + "%2564elete", siteUrl + "profile#submit", siteUrl + "profile?x=%", siteUrl + "profile?unsubscribe=1"]) {
  test(`reject navigation ${href}`, () => assert.equal(collectionUrlAllowed(href, siteUrl), false));
}
test("GET and familiar label cannot authorize mutation controls", () => {
  assert.equal(collectionNavigation({ id: "n-0", href: siteUrl + "profile", text: "プロフィール変更", passive: true }, siteUrl), "deny");
  assert.equal(collectionNavigation({ id: "n-0", href: siteUrl + "profile", text: "プロフィール", passive: false }, siteUrl), "deny");
});

test("runner stores a model-classified masked CVV from the local read as an encrypted ai-driven Disclosure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "collection-572-"));
  try {
    const path = join(dir, "vault.json"), vault = await VaultV2.open(new FileVaultPersistence(path), "fake-passphrase");
    const domain = new DomainService(vault), site = domain.upsertSiteAccount({ domain: "example.test", url: siteUrl, displayName: "Fake" });
    const f = fixture(); f.set(secretObservation());
    const users: string[] = [];
    f.options.provider = { id: "fake", completeJson: async request => { users.push(request.user);
      return proposal(f.current(), { values: [{ itemId: "f-3", attributeKey: "card.cvv", value: MASKED_VALUE, confidence: 0.9 }] }); } };
    const runner = new VisibilityRunner({ domain, openSession: async () => ({ page: f.options.page, close: async () => {} }),
      collectionProvider: f.options.provider,
      collectionGrant: context => {
        vault.put("mandate", { id: "m", siteAccountId: site.id, operation: "ai-assisted-discovery", authorizedAt: 2, scope: context.runId });
        vault.put("capability", { id: "c", operationType: "ai-assisted-discovery", level: "L0", updatedAt: 1 });
        return { ...context, mandateId: "m", capabilityId: "c", capabilityUpdatedAt: 1 };
      } });
    const r = await runner.runSite(site.id);
    assert.equal(r.status, "collected"); assert.equal(users.length, 1); assert.equal(users[0]!.includes(SECRETS.cvv), false);
    const cvv = domain.listDisclosures().find(d => d.attributeKey === "card.cvv");
    assert.equal(cvv?.siteHeldValue, SECRETS.cvv); assert.equal(cvv?.collectionTier, "ai-driven");
    await vault.save(); assert.doesNotMatch(await readFile(path, "utf8"), new RegExp(`"${SECRETS.cvv}"`));
    const reopened = new DomainService(await VaultV2.open(new FileVaultPersistence(path), "fake-passphrase"));
    assert.equal(reopened.listDisclosures().find(d => d.attributeKey === "card.cvv")?.siteHeldValue, SECRETS.cvv);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("runner uses real scoped authorization and typed encrypted persistence, hallucinations store no value", async () => {
  const dir = await mkdtemp(join(tmpdir(), "collection-517-"));
  try {
    const path = join(dir, "vault.json"), vault = await VaultV2.open(new FileVaultPersistence(path), "fake-passphrase");
    const domain = new DomainService(vault), site = domain.upsertSiteAccount({ domain: "example.test", url: siteUrl, displayName: "Fake" });
    const f = fixture();
    const runner = new VisibilityRunner({ domain, openSession: async () => ({ page: f.options.page, close: async () => {} }),
      collectionProvider: f.options.provider,
      collectionGrant: context => {
        vault.put("mandate", { id: "m", siteAccountId: site.id, operation: "ai-assisted-discovery", authorizedAt: 2, scope: context.runId });
        vault.put("capability", { id: "c", operationType: "ai-assisted-discovery", level: "L0", updatedAt: 1 });
        return { ...context, mandateId: "m", capabilityId: "c", capabilityUpdatedAt: 1 };
      } });
    const r = await runner.runSite(site.id);
    assert.equal(r.disclosures, 1); assert.equal(r.status, "collected");
    assert.equal(domain.listDisclosures()[0]?.collectionTier, "ai-driven");
    await vault.save(); assert.doesNotMatch(await readFile(path, "utf8"), /fake@example.test/);
    const reopened = new DomainService(await VaultV2.open(new FileVaultPersistence(path), "fake-passphrase"));
    assert.equal(reopened.listDisclosures()[0]?.siteHeldValue, "fake@example.test");
    assert.doesNotMatch(JSON.stringify(domain.listConstraints()), /fake@example.test/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
