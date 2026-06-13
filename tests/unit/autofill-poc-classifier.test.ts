import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyCheckbox, classifyFields } from "../../poc/autofill-agent/src/agent/classifier.js";
import type { FormField } from "../../poc/autofill-agent/src/types.js";

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
