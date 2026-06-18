import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyCheckbox,
  classifyFields,
  classifyFieldsWithEvidence,
} from "../../src/agent/classifier.js";
import { DeterministicMapper } from "../../src/agent/mapper.js";
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

function keyOf(fields: FormField[], fieldId: string): string | undefined {
  const plan = classifyFields(fields, []);
  return plan.entries.find((e) => e.fieldId === fieldId)?.profileKey;
}

test("autocomplete attributes take priority", () => {
  const f = field({ fieldId: "a", autocomplete: "postal-code", labels: ["なにか別の表記"] });
  assert.equal(keyOf([f], "a"), "postal.full");
});

test("japanese labels map without name/id hints (table layout)", () => {
  const fields = [
    field({ fieldId: "f1", name: "f01", nearbyText: "お名前（必須）" }),
    field({ fieldId: "f2", name: "f02", nearbyText: "ふりがな" }),
    field({ fieldId: "f3", name: "f05", nearbyText: "〒（郵便番号）" }),
    field({ fieldId: "f4", name: "f07", nearbyText: "貴社名" }),
  ];
  assert.equal(keyOf(fields, "f1"), "name.full");
  assert.equal(keyOf(fields, "f2"), "name.kana.full");
  assert.equal(keyOf(fields, "f3"), "postal.full");
  assert.equal(keyOf(fields, "f4"), "company.name");
});

test("specific rules win over generic ones", () => {
  // 「住所（都道府県から）」 must NOT map to address.pref
  const addr = field({ fieldId: "a", placeholder: "住所（都道府県から）" });
  assert.equal(keyOf([addr], "a"), "address.full");
  // 「都道府県以降の住所」 maps to address.full with the local split transform
  const after = field({ fieldId: "b", labels: ["都道府県以降の住所"] });
  const plan = classifyFields([after], []);
  assert.deepEqual(plan.entries[0], { fieldId: "b", profileKey: "address.full", transform: "addressAfterPref" });
  // 「カード名義」 must not hit name rules
  const holder = field({ fieldId: "c", labels: ["カード名義（ローマ字）"] });
  assert.equal(keyOf([holder], "c"), "card.holder");
});

test("split fields get transforms", () => {
  const zip1 = field({ fieldId: "z1", labels: ["郵便番号（上3桁）"] });
  const tel2 = field({ fieldId: "t2", labels: ["電話番号（市内局番）"], type: "tel" });
  const plan = classifyFields([zip1, tel2], []);
  assert.deepEqual(plan.entries, [
    { fieldId: "z1", profileKey: "postal.full", transform: "postal3" },
    { fieldId: "t2", profileKey: "phone.full", transform: "phone2" },
  ]);
});

test("kana split fields precede full kana and 姓/名", () => {
  const fields = [
    field({ fieldId: "s", labels: ["セイ（全角カナ）"] }),
    field({ fieldId: "m", labels: ["メイ（全角カナ）"] }),
    field({ fieldId: "sei", labels: ["姓（必須）"] }),
    field({ fieldId: "mei", labels: ["名（必須）"] }),
  ];
  assert.equal(keyOf(fields, "s"), "name.kana.sei");
  assert.equal(keyOf(fields, "m"), "name.kana.mei");
  assert.equal(keyOf(fields, "sei"), "name.sei");
  assert.equal(keyOf(fields, "mei"), "name.mei");
});

test("unmapped required fields are reported, not guessed", () => {
  const job = field({ fieldId: "j", tag: "select", type: "select", labels: ["ご職業（必須）"], required: true });
  const plan = classifyFields([job], []);
  assert.equal(plan.entries.length, 0);
  assert.deepEqual(plan.unmappedRequired, ["j"]);
});

test("custom fields match after the user adds them", () => {
  const job = field({ fieldId: "j", tag: "select", type: "select", labels: ["ご職業（必須）"], required: true });
  const plan = classifyFields([job], [{ key: "custom.ご職業", matchTerms: ["ご職業"] }]);
  assert.equal(plan.entries[0]?.profileKey, "custom.ご職業");
});

test("checkbox roles: consent vs attestation vs opt-in", () => {
  assert.equal(classifyCheckbox(field({ fieldId: "a", labels: ["利用規約に同意する"] })).role, "terms-consent");
  assert.equal(classifyCheckbox(field({ fieldId: "b", labels: ["私は18歳以上です"] })).role, "attestation");
  assert.equal(classifyCheckbox(field({ fieldId: "c", labels: ["東京都に在住しています"] })).role, "attestation");
  assert.equal(classifyCheckbox(field({ fieldId: "d", labels: ["メールマガジンを受け取る（任意）"] })).role, "optional-optin");
});

test("password type always maps to account.password", () => {
  const pw = field({ fieldId: "p", type: "password", placeholder: "パスワード（8文字以上）" });
  assert.equal(keyOf([pw], "p"), "account.password");
});

function evidenceOf(fields: FormField[], fieldId: string, customs: Parameters<typeof classifyFieldsWithEvidence>[1] = []) {
  return classifyFieldsWithEvidence(fields, customs).evidence.find((e) => e.fieldId === fieldId);
}

test("evidence records the source, ruleId, and matched text for each decision", () => {
  // autocomplete source
  const ac = evidenceOf([field({ fieldId: "a", autocomplete: "postal-code" })], "a");
  assert.equal(ac?.source, "autocomplete");
  assert.equal(ac?.ruleId, "ac:postal-code");
  assert.equal(ac?.profileKey, "postal.full");

  // rule source with matched fragment
  const holder = evidenceOf([field({ fieldId: "c", labels: ["カード名義（ローマ字）"] })], "c");
  assert.equal(holder?.source, "rule");
  assert.equal(holder?.ruleId, "rule:card-holder");
  assert.equal(holder?.profileKey, "card.holder");
  assert.ok(holder?.matchedText.includes("名義"));

  // split transform carried into evidence
  const after = evidenceOf([field({ fieldId: "b", labels: ["都道府県以降の住所"] })], "b");
  assert.equal(after?.ruleId, "rule:address-after-pref");
  assert.equal(after?.transform, "addressAfterPref");

  // password input-type source
  const pw = evidenceOf([field({ fieldId: "p", type: "password" })], "p");
  assert.equal(pw?.source, "input-type");
  assert.equal(pw?.ruleId, "type:password");
});

test("mis-mapping regressions are pinned by ruleId, not just the final key", () => {
  // 姓/名 must use the name rules, not card-holder's 名義 rule
  const fields = [field({ fieldId: "sei", labels: ["姓"] }), field({ fieldId: "mei", labels: ["名"] })];
  assert.equal(evidenceOf(fields, "sei")?.ruleId, "rule:name-sei");
  assert.equal(evidenceOf(fields, "mei")?.ruleId, "rule:name-mei");
});

test("checkbox and unmapped-required decisions are recorded in evidence", () => {
  const fields = [
    field({ fieldId: "att", type: "checkbox", labels: ["私は18歳以上です"] }),
    field({ fieldId: "job", tag: "select", type: "select", labels: ["ご職業（必須）"], required: true }),
  ];
  const att = evidenceOf(fields, "att");
  assert.equal(att?.source, "checkbox");
  assert.equal(att?.role, "attestation");
  assert.equal(att?.ruleId, "checkbox:attestation");

  const job = evidenceOf(fields, "job");
  assert.equal(job?.source, "unmapped-required");
  assert.equal(job?.profileKey, undefined);
});

test("custom-field matches record the matched term in evidence", () => {
  const job = field({ fieldId: "j", tag: "select", type: "select", labels: ["ご職業（必須）"], required: true });
  const ev = evidenceOf([job], "j", [{ key: "custom.ご職業", matchTerms: ["ご職業"] }]);
  assert.equal(ev?.source, "custom");
  assert.equal(ev?.ruleId, "custom:custom.ご職業");
  assert.equal(ev?.matchedText, "ご職業");
});

function pageSnapshot(fields: FormField[]): PageSnapshot {
  return {
    url: "http://127.0.0.1/site/custom/register",
    title: "候補サイト",
    fields,
    buttons: [],
    links: [],
    visibleText: "候補サイト 新規登録",
    iframeSrcs: [],
    wallMarkers: [],
  };
}

test("deterministic mapper applies local candidate definition rules before classifier fallback", async () => {
  const now = Date.now();
  const candidate: LocalCandidateDefinition = {
    id: "candidate-custom",
    serviceName: "候補サイト",
    match: { urlPatterns: ["/site/custom/"] },
    fieldRules: [{ id: "member-id", profileKey: "account.id", labelPattern: "会員番号" }],
    source: "observation",
    status: "candidate",
    createdAt: now,
    updatedAt: now,
  };
  const mapper = new DeterministicMapper();
  const plan = await mapper.mapFields(
    pageSnapshot([
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
});

test("deterministic mapper layers multiple matching definition rule sets", async () => {
  const now = Date.now();
  const first: LocalCandidateDefinition = {
    id: "candidate-first",
    serviceName: "候補サイト",
    match: { urlPatterns: ["/site/custom/"] },
    fieldRules: [{ id: "member-id", profileKey: "account.id", labelPattern: "会員番号" }],
    source: "observation",
    status: "candidate",
    createdAt: now,
    updatedAt: now,
  };
  const second: LocalCandidateDefinition = {
    ...first,
    id: "candidate-second",
    fieldRules: [{ id: "customer-code", profileKey: "custom.顧客コード", labelPattern: "顧客コード" }],
  };
  const mapper = new DeterministicMapper();
  const plan = await mapper.mapFields(
    pageSnapshot([
      field({ fieldId: "member", labels: ["会員番号"] }),
      field({ fieldId: "code", labels: ["顧客コード"] }),
    ]),
    [],
    { officialDefinitions: [], localCandidates: [first, second] },
  );

  assert.deepEqual(plan.entries, [
    { fieldId: "member", profileKey: "account.id" },
    { fieldId: "code", profileKey: "custom.顧客コード" },
  ]);
});
