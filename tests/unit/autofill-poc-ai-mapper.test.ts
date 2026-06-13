import assert from "node:assert/strict";
import { test } from "node:test";
import { AiMapper } from "../../poc/autofill-agent/src/agent/ai/ai-mapper.js";
import type { AiProvider, CompleteJsonOptions } from "../../poc/autofill-agent/src/agent/ai/provider.js";
import { HIGH_RISK_FLAGS, TRANSFORMS, type FormField, type PageSnapshot } from "../../poc/autofill-agent/src/types.js";

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
  await mapper.mapFields(snapshot([]), []);

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

  await assert.rejects(() => mapper.mapFields(snapshot([]), []), /network down/);
});
