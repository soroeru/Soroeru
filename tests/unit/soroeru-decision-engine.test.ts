import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AiEngine,
  DecisionKind,
  DecisionRequest,
  DecisionResult,
  DecisionResultMap,
  RuleEvaluator,
  RuleResult,
} from "../../src/automation/decision-engine.js";
import { DecisionEngine } from "../../src/automation/decision-engine.js";
import { RuleEngine } from "../../src/automation/rule-engine.js";
import type { PageSnapshot } from "../../src/types.js";

function snapshot(partial: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    url: "https://example.com/",
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

function request<K extends DecisionKind>(kind: K): DecisionRequest & { kind: K } {
  return { kind, snapshot: snapshot(), context: { siteAccount: { domain: "example.com", displayName: "Example" } } };
}

/** A rule evaluator scripted to return one fixed result for every kind. */
function scriptedRules(result: RuleResult): RuleEvaluator {
  return { evaluate: <K extends DecisionKind>() => result as RuleResult<K> };
}

function scriptedAi(response: DecisionResult | null, calls: DecisionKind[] = []): AiEngine {
  return {
    consult: <K extends DecisionKind>(req: DecisionRequest & { kind: K }) => {
      calls.push(req.kind);
      return Promise.resolve(response as DecisionResult<K> | null);
    },
  };
}

test("a confident rule result is used directly and the AI is not consulted", async () => {
  const aiCalls: DecisionKind[] = [];
  const engine = new DecisionEngine(
    scriptedRules({ confident: true, result: { continue: false } }),
    scriptedAi({ source: "ai", confidence: 0.9, result: { continue: true } }, aiCalls),
  );

  const decision = await engine.decide(request("should-continue"));

  assert.deepEqual(decision, { source: "rule", confidence: 1.0, result: { continue: false } });
  assert.deepEqual(aiCalls, []);
});

test("an unconfident rule falls back to the AI when configured", async () => {
  const aiCalls: DecisionKind[] = [];
  const engine = new DecisionEngine(
    scriptedRules({ confident: false }),
    scriptedAi({ source: "ai", confidence: 0.8, result: { success: true, reason: "logout-link" } }, aiCalls),
  );

  const decision = await engine.decide(request("judge-login-result"));

  assert.deepEqual(decision, { source: "ai", confidence: 0.8, result: { success: true, reason: "logout-link" } });
  assert.deepEqual(aiCalls, ["judge-login-result"]);
});

test("an AI that cannot decide (null) falls through to the safe default", async () => {
  const engine = new DecisionEngine(scriptedRules({ confident: false }), scriptedAi(null));

  const decision = await engine.decide(request("judge-login-result"));

  assert.deepEqual(decision, { source: "rule", confidence: 0.3, result: { success: false, reason: "no-decision" } });
});

test("without AI, an unconfident partial rule result is used as-is", async () => {
  const partialLinks = { links: [{ href: "https://example.com/maybe", text: "maybe" }] };
  const engine = new DecisionEngine(scriptedRules({ confident: false, result: partialLinks }));

  const decision = await engine.decide(request("find-profile-links"));

  assert.equal(decision.source, "rule");
  assert.equal(decision.confidence, 0.3);
  assert.deepEqual(decision.result, partialLinks);
});

test("without AI and without any rule result, every kind gets its safe default", async () => {
  const engine = new DecisionEngine(scriptedRules({ confident: false }));
  const expected: { [K in DecisionKind]: DecisionResultMap[K] } = {
    "find-login-page": { links: [] },
    "find-profile-links": { links: [] },
    "detect-login-form": { form: null },
    "judge-login-result": { success: false, reason: "no-decision" },
    "classify-field": { classification: null },
    "should-continue": { continue: false },
    "name-new-attribute": { attributeKey: "unknown", label: "Unknown" },
  };

  for (const kind of Object.keys(expected) as DecisionKind[]) {
    const decision = await engine.decide(request(kind));
    assert.deepEqual(decision.result, expected[kind], kind);
    assert.equal(decision.confidence, 0.3, kind);
  }
});

test("end to end with the real RuleEngine: ambiguous login judgement defaults to failure", async () => {
  // The RuleEngine never asserts a login result (Phase 3 decides the adapter),
  // so without AI the engine must land on the failed-login safe default —
  // never on "success" from an unauthenticated session.
  const engine = new DecisionEngine(new RuleEngine());

  const decision = await engine.decide(request("judge-login-result"));

  assert.deepEqual(decision.result, { success: false, reason: "no-decision" });
});
