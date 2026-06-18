import assert from "node:assert/strict";
import { test } from "node:test";
import { AiMapper, candidateFromAiMapping } from "../../src/agent/ai/ai-mapper.js";
import {
  AiProviderError,
  AnthropicProvider,
  type AiProvider,
  type CompleteJsonOptions,
} from "../../src/agent/ai/provider.js";
import { HIGH_RISK_FLAGS, TRANSFORMS, type FormField, type LocalCandidateDefinition, type PageSnapshot } from "../../src/types.js";

class StubProvider implements AiProvider {
  readonly id = "stub";
  calls: CompleteJsonOptions[] = [];

  constructor(private readonly responses: unknown[]) {}

  completeJson(options: CompleteJsonOptions): Promise<unknown> {
    this.calls.push(options);
    const next = this.responses.shift();
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  }
}

class StubCandidateSink {
  candidates: LocalCandidateDefinition[] = [];
  saveCalls = 0;

  upsertLocalCandidate(candidate: LocalCandidateDefinition): void {
    this.candidates.push(candidate);
  }

  async save(): Promise<void> {
    this.saveCalls += 1;
  }
}

class ThrowingCandidateSink {
  upsertCalls = 0;
  saveCalls = 0;

  upsertLocalCandidate(): void {
    this.upsertCalls += 1;
    throw new Error("store rejected candidate");
  }

  async save(): Promise<void> {
    this.saveCalls += 1;
  }
}

interface MutableAnthropicProvider {
  client: { messages: { create: () => Promise<unknown> } };
}

function anthropicProviderWith(response: unknown): AnthropicProvider {
  const provider = new AnthropicProvider({ apiKey: "test-key", model: "test-model" });
  (provider as unknown as MutableAnthropicProvider).client = {
    messages: { create: () => Promise.resolve(response) },
  };
  return provider;
}

function field(partial: Partial<FormField> & { fieldId: string }): FormField {
  return {
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

function snapshot(fields: FormField[]): PageSnapshot {
  return {
    url: "http://127.0.0.1/site/test/register",
    title: "テスト登録",
    fields,
    buttons: [],
    links: [],
    visibleText: "",
    iframeSrcs: [],
    wallMarkers: [],
  };
}

function transformEnumFrom(schema: Record<string, unknown>): unknown {
  const properties = schema["properties"] as Record<string, unknown>;
  const entries = properties["entries"] as Record<string, unknown>;
  const items = entries["items"] as Record<string, unknown>;
  const entryProps = items["properties"] as Record<string, unknown>;
  const transform = entryProps["transform"] as Record<string, unknown>;
  const anyOf = transform["anyOf"] as Record<string, unknown>[];
  return anyOf[0]?.["enum"];
}

function highRiskEnumFrom(schema: Record<string, unknown>): unknown {
  const properties = schema["properties"] as Record<string, unknown>;
  const highRisk = properties["highRisk"] as Record<string, unknown>;
  const items = highRisk["items"] as Record<string, unknown>;
  const itemProps = items["properties"] as Record<string, unknown>;
  const flag = itemProps["flag"] as Record<string, unknown>;
  return flag["enum"];
}

test("AI mapper field schema uses transform enum from the shared type contract", async () => {
  const provider = new StubProvider([{ entries: [], checkboxes: [], unmappedRequired: [] }]);
  const mapper = new AiMapper(provider);
  await mapper.mapFields(snapshot([field({ fieldId: "email", labels: ["メール"] })]), []);

  assert.deepEqual(transformEnumFrom(provider.calls[0]!.schema), [...TRANSFORMS]);
});

test("AI mapper drops invented keys, invalid transforms, and non-existent field ids", async () => {
  const provider = new StubProvider([
    {
      entries: [
        { fieldId: "email", profileKey: "email" },
        { fieldId: "ghost", profileKey: "email" },
        { fieldId: "name", profileKey: "invented.key" },
        { fieldId: "zip", profileKey: "postal.full", transform: "postal3" },
        { fieldId: "bad-transform", profileKey: "phone.full", transform: "phone9" },
      ],
      checkboxes: [
        { fieldId: "agree", role: "terms-consent", label: "利用規約に同意する" },
        { fieldId: "agree", role: "optional-optin", label: "duplicate valid role" },
        { fieldId: "agree", role: "consent-ish", label: "invalid" },
      ],
      unmappedRequired: ["missing", "not-on-page"],
    },
  ]);
  const mapper = new AiMapper(provider);
  const plan = await mapper.mapFields(
    snapshot([
      field({ fieldId: "email", labels: ["メール"] }),
      field({ fieldId: "name", labels: ["名前"] }),
      field({ fieldId: "zip", labels: ["郵便番号"] }),
      field({ fieldId: "bad-transform", labels: ["電話"] }),
      field({ fieldId: "agree", type: "checkbox", labels: ["利用規約に同意する"] }),
      field({ fieldId: "missing", required: true, labels: ["未保存"] }),
    ]),
    [],
  );

  assert.deepEqual(plan.entries, [
    { fieldId: "email", profileKey: "email" },
    { fieldId: "zip", profileKey: "postal.full", transform: "postal3" },
  ]);
  assert.deepEqual(plan.checkboxes, [{ fieldId: "agree", role: "terms-consent", label: "利用規約に同意する" }]);
  assert.deepEqual(plan.unmappedRequired, ["missing"]);
});

test("AI terms schema uses high-risk flags from the shared type contract", async () => {
  const provider = new StubProvider([{ highRisk: [], payment: "none", prohibitsAutoCreation: false }]);
  const mapper = new AiMapper(provider);
  await mapper.analyzeTerms("", "", false);

  assert.deepEqual(highRiskEnumFrom(provider.calls[0]!.schema), [...HIGH_RISK_FLAGS]);
});

test("AI terms analysis normalizes trial payment into a high-risk flag", async () => {
  const provider = new StubProvider([
    {
      highRisk: [{ flag: "auto-renewal", quote: "自動的に更新されます" }],
      payment: "trial-subscription",
      prohibitsAutoCreation: false,
    },
  ]);
  const mapper = new AiMapper(provider);
  const analysis = await mapper.analyzeTerms("無料トライアル終了後に課金", "", true);

  assert.equal(analysis.payment, "trial-subscription");
  assert.deepEqual(analysis.highRiskFlags, ["auto-renewal", "trial-subscription"]);
});

test("AI mapper keeps provider failures explicit instead of silently falling back", async () => {
  const provider = new StubProvider([new Error("network down")]);
  const mapper = new AiMapper(provider);

  await assert.rejects(() => mapper.mapFields(snapshot([field({ fieldId: "email", labels: ["メール"] })]), []), /network down/);
});

test("AI mapper skips provider calls for definition-covered fields", async () => {
  const now = Date.now();
  const candidate: LocalCandidateDefinition = {
    id: "candidate-custom",
    serviceName: "候補サイト",
    match: { urlPatterns: ["/site/test/"] },
    fieldRules: [{ id: "member-id", profileKey: "account.id", labelPattern: "会員番号" }],
    source: "observation",
    status: "candidate",
    createdAt: now,
    updatedAt: now,
  };
  const provider = new StubProvider([{ entries: [{ fieldId: "email", profileKey: "email" }], checkboxes: [], unmappedRequired: [] }]);
  const mapper = new AiMapper(provider);
  const plan = await mapper.mapFields(
    snapshot([
      field({ fieldId: "member", labels: ["会員番号"] }),
      field({ fieldId: "email", autocomplete: "email", labels: ["メール"] }),
    ]),
    [],
    { localCandidates: [candidate] },
  );

  assert.deepEqual(plan.entries, [
    { fieldId: "member", profileKey: "account.id" },
    { fieldId: "email", profileKey: "email" },
  ]);
  const payload = JSON.parse(provider.calls[0]!.user) as { fieldId: string }[];
  assert.deepEqual(payload.map((item) => item.fieldId), ["email"]);
});

test("AI mapper does not call the provider when definition rules cover every field", async () => {
  const now = Date.now();
  const candidate: LocalCandidateDefinition = {
    id: "candidate-custom",
    serviceName: "候補サイト",
    match: { urlPatterns: ["/site/test/"] },
    fieldRules: [
      { id: "member-id", profileKey: "account.id", labelPattern: "会員番号" },
      { id: "email", profileKey: "email", labelPattern: "メール" },
    ],
    source: "observation",
    status: "candidate",
    createdAt: now,
    updatedAt: now,
  };
  const provider = new StubProvider([new Error("provider should not be called")]);
  const mapper = new AiMapper(provider);
  const plan = await mapper.mapFields(
    snapshot([
      field({ fieldId: "member", labels: ["会員番号"] }),
      field({ fieldId: "email", labels: ["メール"] }),
    ]),
    [],
    { localCandidates: [candidate] },
  );

  assert.deepEqual(plan.entries, [
    { fieldId: "member", profileKey: "account.id" },
    { fieldId: "email", profileKey: "email" },
  ]);
  assert.equal(provider.calls.length, 0);
});

test("AI mapping can become a sanitized local candidate definition", () => {
  const snap = snapshot([
    field({ fieldId: "email", name: "mail", labels: ["メールアドレス"] }),
    field({ fieldId: "name", name: "full_name", labels: ["氏名"] }),
  ]);
  const candidate = candidateFromAiMapping(
    snap,
    {
      entries: [
        { fieldId: "email", profileKey: "email" },
        { fieldId: "name", profileKey: "name.full" },
      ],
      checkboxes: [],
      unmappedRequired: [],
    },
    { now: 1 },
  );

  assert.equal(candidate.source, "ai");
  assert.equal(candidate.status, "candidate");
  assert.deepEqual(candidate.match.domains, ["127.0.0.1"]);
  assert.equal(candidate.fieldRules?.length, 2);
  assert.ok(!JSON.stringify(candidate).includes("dummy@example.com"));
});

test("AI candidate ids distinguish different forms on the same host", () => {
  const plan = {
    entries: [{ fieldId: "email", profileKey: "email" as const }],
    checkboxes: [],
    unmappedRequired: [],
  };
  const registration = candidateFromAiMapping(
    { ...snapshot([field({ fieldId: "email", name: "mail", labels: ["メールアドレス"] })]), url: "http://127.0.0.1/site/test/register" },
    plan,
    { now: 1 },
  );
  const update = candidateFromAiMapping(
    { ...snapshot([field({ fieldId: "email", name: "mail", labels: ["メールアドレス"] })]), url: "http://127.0.0.1/site/test/profile/edit" },
    plan,
    { now: 1 },
  );

  assert.notEqual(registration.id, update.id);
  assert.match(registration.id, /^ai-127-0-0-1-site-test-register-[a-f0-9]{12}$/);
  assert.match(update.id, /^ai-127-0-0-1-site-test-profile-edit-[a-f0-9]{12}$/);
});

test("AI mapper persists a sanitized local candidate after provider mapping succeeds", async () => {
  const provider = new StubProvider([
    {
      entries: [
        { fieldId: "email", profileKey: "email" },
        { fieldId: "name", profileKey: "name.full" },
      ],
      checkboxes: [],
      unmappedRequired: [],
    },
  ]);
  const sink = new StubCandidateSink();
  const mapper = new AiMapper(provider, sink);
  await mapper.mapFields(
    snapshot([
      field({ fieldId: "email", name: "mail", labels: ["メールアドレス"] }),
      field({ fieldId: "name", name: "full_name", labels: ["氏名"] }),
    ]),
    [],
  );

  assert.equal(sink.candidates.length, 1);
  assert.equal(sink.candidates[0]!.source, "ai");
  assert.equal(sink.candidates[0]!.status, "candidate");
  assert.equal(sink.candidates[0]!.fieldRules?.length, 2);
  assert.equal(sink.saveCalls, 1);
});

test("AI mapper ignores candidate persistence failures without failing the mapping", async () => {
  const provider = new StubProvider([
    {
      entries: [{ fieldId: "email", profileKey: "email" }],
      checkboxes: [],
      unmappedRequired: [],
    },
  ]);
  const sink = new ThrowingCandidateSink();
  const mapper = new AiMapper(provider, sink);
  const plan = await mapper.mapFields(snapshot([field({ fieldId: "email", labels: ["メールアドレス"] })]), []);

  assert.deepEqual(plan.entries, [{ fieldId: "email", profileKey: "email" }]);
  assert.equal(sink.upsertCalls, 1);
  assert.equal(sink.saveCalls, 0);
});

test("AI mapper reuses a stored local candidate on the next run and skips the provider", async () => {
  const provider = new StubProvider([
    {
      entries: [{ fieldId: "email", profileKey: "email" }],
      checkboxes: [],
      unmappedRequired: [],
    },
    new Error("provider should not be called after candidate reuse"),
  ]);
  const sink = new StubCandidateSink();
  const mapper = new AiMapper(provider, sink);
  const snap = snapshot([field({ fieldId: "email", name: "mail", labels: ["メールアドレス"] })]);

  const first = await mapper.mapFields(snap, []);
  const second = await mapper.mapFields(snap, [], { localCandidates: sink.candidates });

  assert.deepEqual(first.entries, [{ fieldId: "email", profileKey: "email" }]);
  assert.deepEqual(second.entries, [{ fieldId: "email", profileKey: "email" }]);
  assert.equal(provider.calls.length, 1);
});

test("Anthropic provider maps refusal and invalid JSON to explicit provider errors", async () => {
  await assert.rejects(
    () =>
      anthropicProviderWith({
        stop_reason: "refusal",
        content: [{ type: "text", text: "{}" }],
      }).completeJson({ system: "", user: "", schema: {} }),
    (err: unknown) => err instanceof AiProviderError && err.code === "refusal",
  );

  await assert.rejects(
    () =>
      anthropicProviderWith({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "not json" }],
      }).completeJson({ system: "", user: "", schema: {} }),
    (err: unknown) => err instanceof AiProviderError && err.code === "invalid-json",
  );
});
