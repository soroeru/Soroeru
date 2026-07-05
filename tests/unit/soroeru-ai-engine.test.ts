import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AiEngine,
  type AiConsultationLog,
  type RedactionValueSource,
} from "../../src/automation/ai-engine.js";
import { AiProviderError, type AiProvider, type CompleteJsonOptions } from "../../src/agent/ai/provider.js";
import { DecisionEngine } from "../../src/automation/decision-engine.js";
import type { DecisionContext, DecisionKind, DecisionRequest } from "../../src/automation/decision-engine.js";
import { RuleEngine } from "../../src/automation/rule-engine.js";
import type { FormField, PageSnapshot } from "../../src/types.js";

function snapshot(partial: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    url: "https://example.com/mypage",
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

function context(partial: Partial<DecisionContext> = {}): DecisionContext {
  return { siteAccount: { domain: "example.com", displayName: "Example" }, ...partial };
}

function field(partial: Partial<FormField> = {}): FormField {
  return {
    fieldId: "f-1",
    tag: "input",
    type: "text",
    name: "",
    id: "",
    autocomplete: "",
    required: false,
    placeholder: "",
    labels: [],
    nearbyText: "",
    ...partial,
  };
}

function req<K extends DecisionKind>(
  kind: K,
  snap: PageSnapshot,
  ctx: DecisionContext,
): DecisionRequest & { kind: K } {
  return { kind, snapshot: snap, context: ctx };
}

/** Records every prompt sent and replays queued responses/errors in order. */
class StubProvider implements AiProvider {
  readonly id = "stub:test-model";
  readonly calls: CompleteJsonOptions[] = [];
  constructor(private readonly responses: (unknown | Error)[]) {}

  completeJson(options: CompleteJsonOptions): Promise<unknown> {
    this.calls.push(options);
    const next = this.responses.shift();
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  }
}

/** A provider whose call never settles, for exercising the abandon-on-timeout path. */
class HangingProvider implements AiProvider {
  readonly id = "stub:hanging";
  calls = 0;
  completeJson(): Promise<unknown> {
    this.calls++;
    return new Promise(() => {
      // never resolves within the test
    });
  }
}

function redactionSource(...values: string[]): RedactionValueSource {
  return { currentValues: () => values };
}

function collectLogs(): { logs: AiConsultationLog[]; onLog: (entry: AiConsultationLog) => void } {
  const logs: AiConsultationLog[] = [];
  return { logs, onLog: (entry) => logs.push(entry) };
}

// --- 1. rule confident:false -> consult is called -> AI answer is adopted --------------

test("through DecisionEngine: an unconfident rule falls back to AiEngine and the AI answer is used", async () => {
  const provider = new StubProvider([{ success: true, reason: "ai-detected-logout-link", confidence: 0.8 }]);
  const aiEngine = new AiEngine(provider, redactionSource());
  const engine = new DecisionEngine({ evaluate: () => ({ confident: false }) }, aiEngine);

  const decision = await engine.decide(req("judge-login-result", snapshot(), context()));

  assert.deepEqual(decision, {
    source: "ai",
    confidence: 0.8,
    result: { success: true, reason: "ai-detected-logout-link" },
  });
  assert.equal(provider.calls.length, 1);
});

// --- 2. AiProviderError variants / timeout -> null -> safe default ----------------------

test("each AiProviderError code resolves to null and is logged as provider-error", async () => {
  for (const code of ["request-failed", "refusal", "empty-response", "invalid-json"] as const) {
    const provider = new StubProvider([new AiProviderError(`boom: ${code}`, code)]);
    const { logs, onLog } = collectLogs();
    const aiEngine = new AiEngine(provider, redactionSource(), {}, onLog);

    const result = await aiEngine.consult(req("judge-login-result", snapshot(), context()));

    assert.equal(result, null, code);
    assert.equal(logs.length, 1, code);
    assert.equal(logs[0]?.outcome, "provider-error", code);
  }
});

test("a call that exceeds timeoutMs is abandoned: null now, late resolution discarded without a second log", async () => {
  const provider = new HangingProvider();
  const { logs, onLog } = collectLogs();
  const aiEngine = new AiEngine(provider, redactionSource(), { timeoutMs: 10 }, onLog);

  const result = await aiEngine.consult(req("judge-login-result", snapshot(), context()));
  assert.equal(result, null);
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.outcome, "timeout");

  // The hanging provider call never actually resolves, so give any pending
  // microtasks a chance to run and confirm nothing double-logs.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(logs.length, 1);
});

test("without AI configured, DecisionEngine still falls through to the safe default when rules cannot decide", async () => {
  const engine = new DecisionEngine({ evaluate: () => ({ confident: false }) });
  const decision = await engine.decide(req("judge-login-result", snapshot(), context()));
  assert.deepEqual(decision, {
    source: "rule",
    confidence: 0.3,
    result: { success: false, reason: "no-decision" },
  });
});

// --- 3. maxCallsPerSite / maxConsecutiveFailures breaker --------------------------------

test("maxCallsPerSite is scoped per domain: a second domain still gets calls after the first is exhausted", async () => {
  const provider = new StubProvider([
    { success: true, reason: "a1", confidence: 0.9 },
    { success: true, reason: "b1", confidence: 0.9 },
  ]);
  const { logs, onLog } = collectLogs();
  const aiEngine = new AiEngine(provider, redactionSource(), { maxCallsPerSite: 1 }, onLog);

  const a1 = await aiEngine.consult(
    req(
      "judge-login-result",
      snapshot(),
      context({ siteAccount: { domain: "a.example", displayName: "A" } }),
    ),
  );
  const a2 = await aiEngine.consult(
    req(
      "judge-login-result",
      snapshot(),
      context({ siteAccount: { domain: "a.example", displayName: "A" } }),
    ),
  );
  const b1 = await aiEngine.consult(
    req(
      "judge-login-result",
      snapshot(),
      context({ siteAccount: { domain: "b.example", displayName: "B" } }),
    ),
  );

  assert.deepEqual(a1?.result, { success: true, reason: "a1" });
  assert.equal(a2, null);
  assert.deepEqual(b1?.result, { success: true, reason: "b1" });
  assert.equal(provider.calls.length, 2);
  assert.deepEqual(
    logs.map((l) => l.outcome),
    ["used", "budget-exceeded", "used"],
  );
});

test("budget-exceeded events do not count toward maxConsecutiveFailures", async () => {
  // maxCallsPerSite: 1 and maxConsecutiveFailures: 1 on one shared instance:
  // if budget-exceeded were miscounted as a failure, the second and third
  // (budget-exceeded) calls on domain a would trip the run-wide breaker and
  // domain b's call would also be rejected.
  const provider = new StubProvider([
    { success: true, reason: "a1", confidence: 1 },
    { success: true, reason: "b1", confidence: 1 },
  ]);
  const aiEngine = new AiEngine(provider, redactionSource(), {
    maxCallsPerSite: 1,
    maxConsecutiveFailures: 1,
  });
  const domainA = context({ siteAccount: { domain: "a.example", displayName: "A" } });
  const domainB = context({ siteAccount: { domain: "b.example", displayName: "B" } });

  await aiEngine.consult(req("judge-login-result", snapshot(), domainA));
  await aiEngine.consult(req("judge-login-result", snapshot(), domainA));
  await aiEngine.consult(req("judge-login-result", snapshot(), domainA));
  const onDomainB = await aiEngine.consult(req("judge-login-result", snapshot(), domainB));

  assert.deepEqual(
    onDomainB?.result,
    { success: true, reason: "b1" },
    "budget-exceeded on domain a must not disable AI for domain b",
  );
});

test("maxConsecutiveFailures disables the AI for the rest of the run after real failures", async () => {
  const provider = new StubProvider([
    new AiProviderError("fail 1", "request-failed"),
    new AiProviderError("fail 2", "request-failed"),
    { success: true, reason: "should-not-be-reached", confidence: 1 },
  ]);
  const { logs, onLog } = collectLogs();
  const aiEngine = new AiEngine(provider, redactionSource(), { maxConsecutiveFailures: 2 }, onLog);

  const r1 = await aiEngine.consult(req("judge-login-result", snapshot(), context()));
  const r2 = await aiEngine.consult(req("judge-login-result", snapshot(), context()));
  const r3 = await aiEngine.consult(
    req(
      "judge-login-result",
      snapshot(),
      context({ siteAccount: { domain: "other.example", displayName: "Other" } }),
    ),
  );

  assert.equal(r1, null);
  assert.equal(r2, null);
  assert.equal(r3, null, "breaker is run-wide, not per-domain");
  assert.equal(provider.calls.length, 2, "the third consult must not reach the provider");
  assert.deepEqual(
    logs.map((l) => l.outcome),
    ["provider-error", "provider-error", "budget-exceeded"],
  );
});

test("a successful consult resets the consecutive-failure counter", async () => {
  const provider = new StubProvider([
    new AiProviderError("fail 1", "request-failed"),
    { success: true, reason: "recovered", confidence: 1 },
    new AiProviderError("fail 2", "request-failed"),
  ]);
  const aiEngine = new AiEngine(provider, redactionSource(), { maxConsecutiveFailures: 2 });

  const r1 = await aiEngine.consult(req("judge-login-result", snapshot(), context()));
  const r2 = await aiEngine.consult(req("judge-login-result", snapshot(), context()));
  const r3 = await aiEngine.consult(req("judge-login-result", snapshot(), context()));

  assert.equal(r1, null);
  assert.deepEqual(r2?.result, { success: true, reason: "recovered" });
  // The failure after the reset is only 1 consecutive failure (< 2), so the
  // engine must still have been willing to call the provider a third time.
  assert.equal(r3, null);
  assert.equal(provider.calls.length, 3);
});

// --- 4. sanitization sentinels -----------------------------------------------------------

const SENTINEL_NAME = "山田太郎";
const SENTINEL_QUERY_TOKEN = "sessiontoken-should-never-leak";

test("visibleText never appears in any prompt, even when it carries personal data", async () => {
  const dirtySnapshot = snapshot({
    visibleText: `ようこそ ${SENTINEL_NAME} 様。現在のご住所は東京都渋谷区です。`,
    links: [{ href: "/logout", text: "ログアウト" }],
  });
  for (const kind of ["find-login-page", "find-profile-links", "judge-login-result"] as const) {
    const provider = new StubProvider([
      { links: [], confidence: 0.5, success: false, reason: "x", continue: false },
    ]);
    const aiEngine = new AiEngine(provider, redactionSource());
    await aiEngine.consult(req(kind, dirtySnapshot, context()));
    const [call] = provider.calls;
    assert.ok(call, kind);
    assert.doesNotMatch(call.system + call.user, /渋谷区|様。現在/, kind);
    assert.doesNotMatch(JSON.stringify(call), /visibleText/, kind);
  }
});

test("URLs sent to the AI are stripped to origin+path (no query string, no fragment)", async () => {
  const dirtySnapshot = snapshot({
    url: `https://example.com/mypage?token=${SENTINEL_QUERY_TOKEN}&mail=foo@example.com#section`,
    links: [{ href: `/settings?user=${SENTINEL_QUERY_TOKEN}`, text: "settings" }],
  });
  const provider = new StubProvider([{ links: [], confidence: 0.5 }]);
  const aiEngine = new AiEngine(provider, redactionSource());
  await aiEngine.consult(req("find-profile-links", dirtySnapshot, context()));

  const [call] = provider.calls;
  assert.ok(call);
  assert.doesNotMatch(call.user, new RegExp(SENTINEL_QUERY_TOKEN));
  assert.match(call.user, /https:\/\/example\.com\/mypage/);
  const payload = JSON.parse(call.user) as { url: string; links: { href: string }[] };
  assert.equal(payload.url, "https://example.com/mypage");
  assert.equal(payload.links[0]?.href, "https://example.com/settings");
});

test("link and button text embedding a collected/canonical value is redacted before being sent", async () => {
  const dirtySnapshot = snapshot({
    links: [{ href: "/mypage", text: `ようこそ ${SENTINEL_NAME} 様` }],
    buttons: [{ selector: "#logout", text: `${SENTINEL_NAME} としてログアウト` }],
    title: `${SENTINEL_NAME} 様のマイページ`,
  });
  const provider = new StubProvider([{ form: null, confidence: 0.5 }]);
  const aiEngine = new AiEngine(provider, redactionSource(SENTINEL_NAME));
  await aiEngine.consult(req("detect-login-form", dirtySnapshot, context()));

  const [call] = provider.calls;
  assert.ok(call);
  assert.doesNotMatch(call.user, new RegExp(SENTINEL_NAME));
  assert.match(call.user, /\[REDACTED\]/);
});

test("name-new-attribute (display-value path) sends only labelText, never nearbyText", async () => {
  const provider = new StubProvider([
    { attributeKey: "rakuten.point_number", label: "楽天ポイント番号", confidence: 0.7 },
  ]);
  const aiEngine = new AiEngine(provider, redactionSource());
  const ctx = context({ displayValue: { labelText: "楽天ポイント番号" } });

  await aiEngine.consult(req("name-new-attribute", snapshot(), ctx));

  const [call] = provider.calls;
  assert.ok(call);
  const payload = JSON.parse(call.user) as Record<string, unknown>;
  assert.deepEqual(payload, { source: "display-value", labelText: "楽天ポイント番号" });
  assert.doesNotMatch(call.user, /nearbyText/);
});

test("name-new-attribute (form-field path) may send labels/placeholder/nearbyText", async () => {
  const provider = new StubProvider([
    { attributeKey: "rakuten.point_number", label: "楽天ポイント番号", confidence: 0.7 },
  ]);
  const aiEngine = new AiEngine(provider, redactionSource());
  const ctx = context({ field: field({ labels: ["ポイント番号"], nearbyText: "会員情報" }) });

  const result = await aiEngine.consult(req("name-new-attribute", snapshot(), ctx));

  const [call] = provider.calls;
  assert.ok(call);
  const payload = JSON.parse(call.user) as Record<string, unknown>;
  assert.deepEqual(payload, {
    source: "form-field",
    labels: ["ポイント番号"],
    placeholder: "",
    nearbyText: "会員情報",
  });
  assert.deepEqual(result?.result, {
    attributeKey: "custom.rakuten.point_number",
    label: "楽天ポイント番号",
  });
});

// --- should-continue: pendingSameSiteLinkCount / visitedCount / collectedAttributes -----

test("should-continue counts unvisited same-site links and excludes visited/cross-site ones", async () => {
  const snap = snapshot({
    url: "https://example.com/mypage",
    links: [
      { href: "/settings", text: "settings" }, // same-site, unvisited
      { href: "/mypage", text: "mypage" }, // same-site, but already visited
      { href: "https://other.example/page", text: "other" }, // cross-site
    ],
  });
  const ctx = context({
    visitedUrls: ["https://example.com/mypage"],
    collectedAttributes: ["email", "phone.full"],
  });
  const provider = new StubProvider([{ continue: true, confidence: 0.4 }]);
  const aiEngine = new AiEngine(provider, redactionSource());

  const result = await aiEngine.consult(req("should-continue", snap, ctx));

  const [call] = provider.calls;
  assert.ok(call);
  const payload = JSON.parse(call.user) as {
    visitedCount: number;
    pendingSameSiteLinkCount: number;
    collectedAttributes: string[];
  };
  assert.equal(payload.visitedCount, 1);
  assert.equal(payload.pendingSameSiteLinkCount, 1);
  assert.deepEqual(payload.collectedAttributes, ["email", "phone.full"]);
  assert.deepEqual(result?.result, { continue: true });
});

// --- caller-contract guard: missing required context never reaches the provider --------

test("classify-field without context.field is rejected before spending budget or a failure count", async () => {
  const provider = new StubProvider([{ classification: null, confidence: 0.5 }]);
  const { logs, onLog } = collectLogs();
  const aiEngine = new AiEngine(provider, redactionSource(), {}, onLog);

  const result = await aiEngine.consult(req("classify-field", snapshot(), context()));

  assert.equal(result, null);
  assert.equal(provider.calls.length, 0, "the provider must never be called");
  assert.equal(logs.length, 0, "a caller-contract violation is not an AI consultation event");
});

test("name-new-attribute without field or displayValue is rejected before spending budget or a failure count", async () => {
  const provider = new StubProvider([{ attributeKey: "x", label: "x", confidence: 0.5 }]);
  const aiEngine = new AiEngine(provider, redactionSource());

  const result = await aiEngine.consult(req("name-new-attribute", snapshot(), context()));

  assert.equal(result, null);
  assert.equal(provider.calls.length, 0);
});

// --- 5. existence validation (fabricated href / fieldId) --------------------------------

test("find-login-page rejects a fabricated href not present in the snapshot", async () => {
  const snap = snapshot({ links: [{ href: "/login", text: "ログイン" }] });
  const provider = new StubProvider([
    { links: [{ href: "https://evil.example/phish", text: "ログイン" }], confidence: 0.9 },
  ]);
  const { logs, onLog } = collectLogs();
  const aiEngine = new AiEngine(provider, redactionSource(), {}, onLog);

  const result = await aiEngine.consult(req("find-login-page", snap, context()));

  assert.equal(result, null);
  assert.equal(logs[0]?.outcome, "invalid-response");
});

test("find-login-page accepts a real href and returns the original (with query string restored)", async () => {
  const snap = snapshot({ links: [{ href: "/login?next=/mypage", text: "ログイン" }] });
  const provider = new StubProvider([
    { links: [{ href: "https://example.com/login", text: "ログイン" }], confidence: 0.9 },
  ]);
  const aiEngine = new AiEngine(provider, redactionSource());

  const result = await aiEngine.consult(req("find-login-page", snap, context()));

  assert.deepEqual(result?.result, {
    links: [{ href: "https://example.com/login?next=/mypage", text: "ログイン" }],
  });
});

test("detect-login-form rejects a fabricated fieldId", async () => {
  const snap = snapshot({
    fields: [field({ fieldId: "f-real-user" }), field({ fieldId: "f-real-pass", type: "password" })],
  });
  const provider = new StubProvider([
    { form: { usernameFieldId: "f-fake", passwordFieldId: "f-real-pass" }, confidence: 0.9 },
  ]);
  const { logs, onLog } = collectLogs();
  const aiEngine = new AiEngine(provider, redactionSource(), {}, onLog);

  const result = await aiEngine.consult(req("detect-login-form", snap, context()));

  assert.equal(result, null);
  assert.equal(logs[0]?.outcome, "invalid-response");
});

test("detect-login-form rejects a fabricated submitSelector but accepts a real fieldId pair", async () => {
  const snap = snapshot({
    fields: [field({ fieldId: "f-user" }), field({ fieldId: "f-pass", type: "password" })],
    buttons: [{ selector: "#real-submit", text: "ログイン" }],
  });
  const provider = new StubProvider([
    {
      form: { usernameFieldId: "f-user", passwordFieldId: "f-pass", submitSelector: "#fake-submit" },
      confidence: 0.9,
    },
  ]);
  const aiEngine = new AiEngine(provider, redactionSource());

  const result = await aiEngine.consult(req("detect-login-form", snap, context()));
  assert.equal(result, null);

  const provider2 = new StubProvider([
    {
      form: { usernameFieldId: "f-user", passwordFieldId: "f-pass", submitSelector: "#real-submit" },
      confidence: 0.9,
    },
  ]);
  const aiEngine2 = new AiEngine(provider2, redactionSource());
  const result2 = await aiEngine2.consult(req("detect-login-form", snap, context()));
  assert.deepEqual(result2?.result, {
    form: { usernameFieldId: "f-user", passwordFieldId: "f-pass", submitSelector: "#real-submit" },
  });
});

// --- attribute-key normalization / card-prefix guard ------------------------------------

test("classify-field accepts a known key and normalizes a dynamic custom key", async () => {
  const providerKnown = new StubProvider([{ classification: { attributeKey: "email" }, confidence: 0.9 }]);
  const aiKnown = new AiEngine(providerKnown, redactionSource());
  const knownResult = await aiKnown.consult(req("classify-field", snapshot(), context({ field: field() })));
  assert.deepEqual(knownResult?.result, {
    classification: { attributeKey: "email", source: "ai", confidence: 0.9 },
  });

  const providerDynamic = new StubProvider([
    { classification: { attributeKey: " Custom.Rakuten.Point_Number " }, confidence: 0.6 },
  ]);
  const aiDynamic = new AiEngine(providerDynamic, redactionSource());
  const dynamicResult = await aiDynamic.consult(
    req("classify-field", snapshot(), context({ field: field() })),
  );
  assert.deepEqual(dynamicResult?.result, {
    classification: { attributeKey: "custom.rakuten.point_number", source: "ai", confidence: 0.6 },
  });
});

test("classify-field rejects a fabricated card.* key that is not a real known key", async () => {
  const provider = new StubProvider([{ classification: { attributeKey: "card.newfield" }, confidence: 0.9 }]);
  const { logs, onLog } = collectLogs();
  const aiEngine = new AiEngine(provider, redactionSource(), {}, onLog);

  const result = await aiEngine.consult(req("classify-field", snapshot(), context({ field: field() })));

  assert.equal(result, null);
  assert.equal(logs[0]?.outcome, "invalid-response");
});

test("name-new-attribute rejects a proposal that resolves to an already-known key", async () => {
  const provider = new StubProvider([{ attributeKey: "email", label: "メール", confidence: 0.9 }]);
  const aiEngine = new AiEngine(provider, redactionSource());

  const result = await aiEngine.consult(req("name-new-attribute", snapshot(), context({ field: field() })));

  assert.equal(result, null);
});

test("name-new-attribute rejects a key with characters outside [a-z0-9._-]", async () => {
  const provider = new StubProvider([
    { attributeKey: "Rakuten Point!!", label: "楽天ポイント", confidence: 0.9 },
  ]);
  const aiEngine = new AiEngine(provider, redactionSource());

  const result = await aiEngine.consult(req("name-new-attribute", snapshot(), context({ field: field() })));

  assert.equal(result, null);
});

// --- end-to-end at the DecisionEngine level (Orchestrator/FieldCollector are separate Issues) --

test("end to end: real RuleEngine + real AiEngine (FakeAiProvider) fills in what rules cannot decide", async () => {
  const mysteryField = field({ fieldId: "f-mystery", labels: ["ポイント番号"] });
  const snap = snapshot({
    fields: [mysteryField],
    links: [{ href: "/mypage", text: "マイページ" }],
  });
  const provider = new StubProvider([
    { classification: { attributeKey: "custom.mystery_id" }, confidence: 0.5 },
  ]);
  const aiEngine = new AiEngine(provider, redactionSource());
  const engine = new DecisionEngine(new RuleEngine(), aiEngine);

  const decision = await engine.decide(req("classify-field", snap, context({ field: mysteryField })));

  assert.deepEqual(decision, {
    source: "ai",
    confidence: 0.5,
    result: { classification: { attributeKey: "custom.mystery_id", source: "ai", confidence: 0.5 } },
  });
});
