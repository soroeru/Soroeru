// MAINT-001 (#25): lock the shared contracts and the testable layer seams.
//
// These tests pin three things that must stay true as the deterministic and AI
// variants evolve:
//   1. the `Mapper` seam: both variants expose the same interface, and
//   2. the normalization seam: both variants' outputs are cleaned by the same
//      shared path, and
//   3. the cross-layer invariant that the agent layer never receives raw
//      personal values — only `PageSnapshot` structure.

import assert from "node:assert/strict";
import { test } from "node:test";
import { DeterministicMapper, type Mapper } from "../../src/agent/mapper.js";
import { AiMapper } from "../../src/agent/ai/ai-mapper.js";
import type { AiProvider, CompleteJsonOptions } from "../../src/agent/ai/provider.js";
import {
  normalizeMappingPlan,
  normalizeTermsAnalysis,
} from "../../src/agent/normalization.js";
import type { FormField, MappingPlan, PageSnapshot } from "../../src/types.js";

class CapturingProvider implements AiProvider {
  readonly id = "capture";
  calls: CompleteJsonOptions[] = [];
  constructor(private readonly responses: unknown[]) {}
  completeJson(options: CompleteJsonOptions): Promise<unknown> {
    this.calls.push(options);
    return Promise.resolve(this.responses.shift());
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

// The only field-shaped data the agent layer is allowed to receive: structure,
// never values. Keep this list in sync with AiMapper.mapFields.
const ALLOWED_STRUCTURE_KEYS = new Set([
  "fieldId",
  "tag",
  "type",
  "name",
  "id",
  "autocomplete",
  "required",
  "placeholder",
  "labels",
  "nearbyText",
  "options",
]);

test("both mapper variants implement the same Mapper seam", () => {
  const deterministic: Mapper = new DeterministicMapper();
  const ai: Mapper = new AiMapper(new CapturingProvider([]));
  for (const method of ["discoverRegistrationLink", "mapFields", "analyzeTerms"] as const) {
    assert.equal(typeof deterministic[method], "function", `deterministic.${method}`);
    assert.equal(typeof ai[method], "function", `ai.${method}`);
  }
  assert.equal(deterministic.name, "deterministic");
  assert.equal(ai.name, "ai");
});

test("agent layer receives form structure only — no raw values reach the AI provider", async () => {
  const provider = new CapturingProvider([{ entries: [], checkboxes: [], unmappedRequired: [] }]);
  const mapper = new AiMapper(provider);
  await mapper.mapFields(
    snapshot([
      field({ fieldId: "email", autocomplete: "email", labels: ["メールアドレス"] }),
      field({ fieldId: "card", autocomplete: "cc-number", labels: ["カード番号"] }),
    ]),
    [],
  );

  const payload = JSON.parse(provider.calls[0]!.user) as Record<string, unknown>[];
  assert.ok(Array.isArray(payload));
  for (const item of payload) {
    for (const key of Object.keys(item)) {
      assert.ok(ALLOWED_STRUCTURE_KEYS.has(key), `unexpected key in agent payload: ${key}`);
    }
  }
});

test("normalization seam drops out-of-contract mapper output identically for any variant", () => {
  const fields = [
    field({ fieldId: "email" }),
    field({ fieldId: "agree", type: "checkbox" }),
    field({ fieldId: "missing", required: true }),
  ];
  const dirty: MappingPlan = {
    entries: [
      { fieldId: "email", profileKey: "email" },
      { fieldId: "ghost", profileKey: "email" }, // field not on page
      { fieldId: "email", profileKey: "invented.key" as never }, // invalid key
    ],
    checkboxes: [
      { fieldId: "agree", role: "terms-consent", label: "同意" },
      { fieldId: "agree", role: "optional-optin", label: "dup" }, // duplicate field id
      { fieldId: "off-page", role: "terms-consent", label: "x" },
    ],
    unmappedRequired: ["missing", "not-on-page"],
  };

  const normalized = normalizeMappingPlan(dirty, fields, []);
  assert.deepEqual(normalized.entries, [{ fieldId: "email", profileKey: "email" }]);
  assert.deepEqual(normalized.checkboxes, [{ fieldId: "agree", role: "terms-consent", label: "同意" }]);
  assert.deepEqual(normalized.unmappedRequired, ["missing"]);
});

test("normalization seam folds auto-creation ban and trial payment into shared stop conditions", () => {
  const normalized = normalizeTermsAnalysis({
    highRiskFlags: [],
    evidence: {},
    payment: "trial-subscription",
    prohibitsAutoCreation: true,
  });
  assert.ok(normalized.highRiskFlags.includes("no-auto-creation"));
  assert.ok(normalized.highRiskFlags.includes("trial-subscription"));
  assert.equal(normalized.payment, "trial-subscription");
});
