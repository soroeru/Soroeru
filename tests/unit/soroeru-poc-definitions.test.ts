// Shared site/form/field/wall/withdrawal definition model (#80, RFC-001 v3
// §8, extension.md §3.2). Fake data only (docs/testing.md).

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyFieldRules,
  matchDefinition,
  matchDefinitions,
  resolveDefinitions,
  validateCandidateDefinition,
} from "../../src/agent/definitions.js";
import { OFFICIAL_DEFINITIONS } from "../../src/agent/official-definitions.js";
import type { FormField, LocalCandidateDefinition, PageSnapshot } from "../../src/types.js";

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

function snapshot(partial: Partial<PageSnapshot> & { url: string }): PageSnapshot {
  return {
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

const SITE_01_PAGE = snapshot({
  url: "http://127.0.0.1:4173/site/01-basic/register",
  visibleText: "ベーシック商店 新規会員登録",
  buttons: [{ selector: "#submit", text: "登録する" }],
  fields: [
    field({ fieldId: "f1", name: "fullname", id: "fullname", labels: ["氏名"] }),
    field({ fieldId: "f2", name: "login_id", id: "login_id", labels: ["ログインID"] }),
    field({ fieldId: "f3", name: "password", id: "password", type: "password", labels: ["パスワード"] }),
    field({ fieldId: "f4", name: "zip", id: "zip", autocomplete: "postal-code", labels: ["郵便番号"] }),
  ],
});

const SITE_08_PAGE = snapshot({
  url: "http://127.0.0.1:4173/site/08-terms/register",
  visibleText: "テスト商事 利用規約に同意して登録",
  buttons: [{ selector: "#submit", text: "同意して登録" }],
  fields: [
    field({ fieldId: "f1", name: "kana", id: "kana", labels: ["フリガナ"] }),
    field({ fieldId: "f2", name: "agree", id: "agree", type: "checkbox", labels: ["利用規約に同意する"] }),
    field({ fieldId: "f3", name: "adult", id: "adult", type: "checkbox", labels: ["18歳以上である"] }),
  ],
});

const UNRELATED_PAGE = snapshot({
  url: "http://127.0.0.1:4173/site/99-other/register",
  visibleText: "別のサイト",
  fields: [field({ fieldId: "f1", name: "email", autocomplete: "email" })],
});

test("matchDefinition returns undefined when neither domains nor urlPatterns match", () => {
  const [basic] = OFFICIAL_DEFINITIONS.filter((d) => d.id === "local-01-basic");
  assert.equal(matchDefinition(UNRELATED_PAGE, basic!), undefined);
});

test("matchDefinition scores higher with more matching signals (path, field tokens, heading, buttons)", () => {
  const [basic] = OFFICIAL_DEFINITIONS.filter((d) => d.id === "local-01-basic");
  const match = matchDefinition(SITE_01_PAGE, basic!);
  assert.ok(match);
  assert.ok(match!.score > 8, `expected a high score, got ${match!.score}`);
  assert.deepEqual(
    match!.reasons.sort(),
    ["buttons:1", "field-tokens:3", "heading", "path-pattern", "url-pattern"].sort(),
  );
});

test("matchDefinitions ranks the matching definition first and omits non-matches", () => {
  const matches = matchDefinitions(SITE_08_PAGE, OFFICIAL_DEFINITIONS);
  assert.equal(matches[0]!.definition.id, "local-08-terms");
  assert.ok(!matches.some((m) => m.definition.id === "local-01-basic"));
  assert.ok(!matches.some((m) => m.definition.id === "local-10-no-auto"));
});

test("resolveDefinitions merges official definitions with non-rejected local candidates", () => {
  const now = Date.now();
  const accepted: LocalCandidateDefinition = {
    id: "candidate-accepted",
    serviceName: "候補サイト",
    match: { urlPatterns: ["/site/01-basic/"] },
    source: "observation",
    status: "candidate",
    createdAt: now,
    updatedAt: now,
  };
  const rejected: LocalCandidateDefinition = {
    ...accepted,
    id: "candidate-rejected",
    status: "rejected",
  };

  const matches = resolveDefinitions(SITE_01_PAGE, OFFICIAL_DEFINITIONS, [accepted, rejected]);
  const ids = matches.map((m) => m.definition.id);
  assert.ok(ids.includes("local-01-basic"));
  assert.ok(ids.includes("candidate-accepted"));
  assert.ok(!ids.includes("candidate-rejected"));
});

test("applyFieldRules maps fields by label/attr pattern, first matching rule wins", () => {
  const [basic] = OFFICIAL_DEFINITIONS.filter((d) => d.id === "local-01-basic");
  const entries = applyFieldRules(SITE_01_PAGE.fields, basic!.fieldRules!);
  assert.deepEqual(
    entries.sort((a, b) => a.fieldId.localeCompare(b.fieldId)),
    [
      { fieldId: "f2", profileKey: "account.id" },
      { fieldId: "f3", profileKey: "account.password" },
    ],
  );
});

function baseCandidate(partial: Partial<LocalCandidateDefinition> = {}): LocalCandidateDefinition {
  const now = Date.now();
  return {
    id: "candidate-1",
    serviceName: "サンプルサイト",
    match: { urlPatterns: ["/site/example/"] },
    source: "observation",
    status: "candidate",
    createdAt: now,
    updatedAt: now,
    ...partial,
  };
}

test("validateCandidateDefinition accepts a well-formed candidate", () => {
  const candidate = baseCandidate({
    fieldRules: [{ id: "login-id", profileKey: "account.id", attrPattern: "login_?id" }],
  });
  assert.deepEqual(validateCandidateDefinition(candidate), { ok: true, errors: [] });
});

test("validateCandidateDefinition requires id, serviceName, and a site-identity rule", () => {
  const candidate = baseCandidate({ id: "", serviceName: "", match: {} });
  const result = validateCandidateDefinition(candidate);
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("id is required"));
  assert.ok(result.errors.includes("serviceName is required"));
  assert.ok(result.errors.includes("match.domains or match.urlPatterns is required"));
});

test("validateCandidateDefinition rejects invalid regular expressions", () => {
  const candidate = baseCandidate({
    registrationSignature: { headingPatterns: ["(unclosed"] },
  });
  const result = validateCandidateDefinition(candidate);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("invalid regular expression")));
});

test("validateCandidateDefinition rejects unknown profile keys in field rules", () => {
  const candidate = baseCandidate({
    fieldRules: [{ id: "r1", profileKey: "not.a.real.key" as never, attrPattern: "x" }],
  });
  const result = validateCandidateDefinition(candidate);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("unknown profile key")));
});

test("validateCandidateDefinition allows custom.* profile keys", () => {
  const candidate = baseCandidate({
    fieldRules: [{ id: "r1", profileKey: "custom.my-field", attrPattern: "x" }],
  });
  assert.equal(validateCandidateDefinition(candidate).ok, true);
});

test("validateCandidateDefinition flags embedded raw personal values (security.md §9)", () => {
  const withEmail = baseCandidate({ notes: "contact: someone@example.com" });
  assert.ok(validateCandidateDefinition(withEmail).errors.some((e) => e.includes("email address")));

  const withCard = baseCandidate({ notes: "card 4111 1111 1111 1111" });
  assert.ok(validateCandidateDefinition(withCard).errors.some((e) => e.includes("card-number-like")));

  const withPhone = baseCandidate({ notes: "call 03-1234-5678" });
  assert.ok(validateCandidateDefinition(withPhone).errors.some((e) => e.includes("phone-number-like")));
});

test("official definitions are all individually valid as candidates would be", () => {
  const now = Date.now();
  for (const def of OFFICIAL_DEFINITIONS) {
    const candidate: LocalCandidateDefinition = { ...def, source: "observation", status: "validated", createdAt: now, updatedAt: now };
    const result = validateCandidateDefinition(candidate);
    assert.deepEqual(result.errors, [], `${def.id} should be valid`);
  }
});
