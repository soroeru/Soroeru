// Dummy master profile for the PoC. All values are fake (docs/testing.md: fake data only).

import type { KnownProfileKey, ProfileKey, Transform } from "./types.js";

export interface ProfileSeed {
  key: ProfileKey;
  label: string;
  value: string;
}

export const DUMMY_PROFILE_SEED: ProfileSeed[] = [
  { key: "name.full", label: "氏名", value: "山田 太郎" },
  { key: "name.sei", label: "姓", value: "山田" },
  { key: "name.mei", label: "名", value: "太郎" },
  { key: "name.kana.full", label: "フリガナ", value: "ヤマダ タロウ" },
  { key: "name.kana.sei", label: "セイ", value: "ヤマダ" },
  { key: "name.kana.mei", label: "メイ", value: "タロウ" },
  { key: "email", label: "メールアドレス", value: "taro.yamada@example.com" },
  { key: "phone.full", label: "電話番号", value: "03-1234-5678" },
  { key: "postal.full", label: "郵便番号", value: "100-0001" },
  { key: "address.full", label: "住所", value: "東京都千代田区千代田1-1 サンプルビル101" },
  { key: "address.pref", label: "都道府県", value: "東京都" },
  { key: "address.city", label: "市区町村", value: "千代田区" },
  { key: "address.street", label: "番地", value: "千代田1-1" },
  { key: "address.building", label: "建物名", value: "サンプルビル101" },
  { key: "company.name", label: "会社名", value: "株式会社サンプル" },
  { key: "company.department", label: "部署名", value: "開発部" },
  { key: "birth.year", label: "生年", value: "1990" },
  { key: "birth.month", label: "生月", value: "1" },
  { key: "birth.day", label: "生日", value: "23" },
  { key: "gender", label: "性別", value: "男性" },
  // Test card number (not a real account); CVV is stored by explicit user decision (RFC-001 v3 §9).
  { key: "card.number", label: "カード番号", value: "4111111111111111" },
  { key: "card.exp.month", label: "カード有効期限（月）", value: "12" },
  { key: "card.exp.year", label: "カード有効期限（年）", value: "2030" },
  { key: "card.holder", label: "カード名義", value: "TARO YAMADA" },
  { key: "card.cvv", label: "セキュリティコード", value: "123" },
  { key: "account.id", label: "ログインID", value: "taro_yamada" },
  { key: "account.password", label: "パスワード", value: "Dummy-Passw0rd!" },
  // NOTE: "occupation" (ご職業) is intentionally NOT seeded: site 05 uses it to
  // exercise the missing-data prompt -> dynamic custom-field path (RFC-001 v3 §4 step 3).
];

/** Master-value changes used by the bulk-update scenario (RFC-001 v3 §5). */
export const UPDATED_VALUES: Partial<Record<ProfileKey, string>> = {
  "phone.full": "06-9876-5432",
  "postal.full": "530-0001",
  "address.full": "大阪府大阪市北区梅田2-2 テストタワー202",
  "address.pref": "大阪府",
  "address.city": "大阪市北区",
  "address.street": "梅田2-2",
  "address.building": "テストタワー202",
};

/** Apply a local split/derivation transform to a master value. Runs only in the automation layer. */
export function applyTransform(value: string, transform: Transform | undefined, profile: ReadonlyMap<ProfileKey, string>): string {
  if (!transform) return value;
  switch (transform) {
    case "postal3":
      return value.replace(/\D/g, "").slice(0, 3);
    case "postal4":
      return value.replace(/\D/g, "").slice(3, 7);
    case "phone1":
    case "phone2":
    case "phone3": {
      const parts = splitPhone(value);
      return parts[Number(transform.slice(-1)) - 1] ?? "";
    }
    case "addressAfterPref": {
      const pref = profile.get("address.pref") ?? "";
      return pref && value.startsWith(pref) ? value.slice(pref.length) : value;
    }
  }
}

function splitPhone(value: string): [string, string, string] {
  const hyphenated = value.split("-");
  if (hyphenated.length === 3) return [hyphenated[0] ?? "", hyphenated[1] ?? "", hyphenated[2] ?? ""];
  const digits = value.replace(/\D/g, "");
  return [digits.slice(0, digits.length - 8), digits.slice(-8, -4), digits.slice(-4)];
}

/**
 * Per-field input hints for the local profile editor (Issue #78): short
 * Japanese format examples shown as placeholders, plus HTML5 `pattern` /
 * `inputmode` / `type` attributes for inline browser validation. Fields not
 * listed here have no special format and use plain text inputs.
 */
export interface ProfileFieldInput {
  type?: string;
  inputmode?: string;
  pattern?: string;
  hint?: string;
}

export const PROFILE_FIELD_INPUT: Partial<Record<KnownProfileKey, ProfileFieldInput>> = {
  email: { type: "email", hint: "例: taro.yamada@example.com" },
  "phone.full": { inputmode: "tel", pattern: "[0-9-]{8,15}", hint: "例: 03-1234-5678" },
  "postal.full": { inputmode: "numeric", pattern: "\\d{3}-?\\d{4}", hint: "例: 100-0001" },
  "card.number": { inputmode: "numeric", pattern: "\\d{12,19}", hint: "ハイフンなしの12〜19桁の数字" },
  "card.exp.month": { inputmode: "numeric", pattern: "0?[1-9]|1[0-2]", hint: "例: 12（1〜12）" },
  "card.exp.year": { inputmode: "numeric", pattern: "\\d{4}", hint: "例: 2030（4桁の西暦）" },
  "card.cvv": { inputmode: "numeric", pattern: "\\d{3,4}", hint: "3〜4桁の数字" },
};

const PROFILE_VALUE_VALIDATORS: Partial<Record<KnownProfileKey, { test: RegExp; message: string }>> = {
  email: { test: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, message: "メールアドレスの形式が正しくありません。" },
  "phone.full": { test: /^[0-9-]{8,15}$/, message: "電話番号は数字とハイフンで入力してください。" },
  "postal.full": { test: /^\d{3}-?\d{4}$/, message: "郵便番号は7桁の数字（ハイフンは任意）で入力してください。" },
  "card.number": { test: /^\d{12,19}$/, message: "カード番号は12〜19桁の数字で入力してください。" },
  "card.exp.month": { test: /^(0?[1-9]|1[0-2])$/, message: "カード有効期限（月）は1〜12で入力してください。" },
  "card.exp.year": { test: /^\d{4}$/, message: "カード有効期限（年）は4桁の西暦で入力してください。" },
  "card.cvv": { test: /^\d{3,4}$/, message: "セキュリティコードは3〜4桁の数字で入力してください。" },
};

/**
 * Validate a profile field's format before saving. Returns a Japanese error
 * message when `value` is non-empty but does not match the expected format,
 * or `undefined` when the value is valid (empty values are always valid;
 * presence is enforced separately).
 */
export function validateProfileValue(key: ProfileKey, value: string): string | undefined {
  if (!value) return undefined;
  const rule = PROFILE_VALUE_VALIDATORS[key as KnownProfileKey];
  return rule && !rule.test.test(value) ? rule.message : undefined;
}
