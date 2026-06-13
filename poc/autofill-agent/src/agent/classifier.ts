// Deterministic, inspectable field classifier (Issue #10's rule-based approach,
// extended for the agent PoC). Japanese-only vocabulary (Q7).
// Input is the structure-only FormField list; no values are involved.

import type {
  CheckboxClassification,
  FormField,
  MappingEntry,
  MappingPlan,
  ProfileKey,
  Transform,
} from "../types.js";

export interface CustomFieldDef {
  key: ProfileKey;
  matchTerms: string[];
}

interface Rule {
  key: ProfileKey;
  transform?: Transform;
  /** Matches against label-ish text (labels + placeholder + nearbyText). */
  label?: RegExp;
  /** Matches against name/id attribute text. */
  attr?: RegExp;
}

const AUTOCOMPLETE_MAP: Record<string, { key: ProfileKey; transform?: Transform }> = {
  name: { key: "name.full" },
  "family-name": { key: "name.sei" },
  "given-name": { key: "name.mei" },
  email: { key: "email" },
  tel: { key: "phone.full" },
  "postal-code": { key: "postal.full" },
  "street-address": { key: "address.full" },
  "address-level1": { key: "address.pref" },
  "address-level2": { key: "address.city" },
  organization: { key: "company.name" },
  "cc-number": { key: "card.number" },
  "cc-name": { key: "card.holder" },
  "cc-csc": { key: "card.cvv" },
  "cc-exp-month": { key: "card.exp.month" },
  "cc-exp-year": { key: "card.exp.year" },
  "new-password": { key: "account.password" },
  "current-password": { key: "account.password" },
  username: { key: "account.id" },
};

// Ordered: first match wins, so specific rules must precede generic ones
// (e.g. 「都道府県以降の住所」 before 「都道府県」 before 「住所」).
const RULES: Rule[] = [
  // --- card (before name rules: 「カード名義」 must not hit 名前) ---
  { key: "card.number", label: /カード番号/, attr: /card_?num|cc_?num/i },
  { key: "card.exp.month", label: /有効期限.*月/, attr: /exp_?month/i },
  { key: "card.exp.year", label: /有効期限.*年/, attr: /exp_?year/i },
  { key: "card.cvv", label: /セキュリティコード|CVV|CVC/i, attr: /cvv|cvc|csc|security_?code/i },
  { key: "card.holder", label: /カード名義|名義/, attr: /card_?name|holder/i },
  // --- postal (split before full) ---
  { key: "postal.full", transform: "postal3", label: /郵便番号.*(上?3桁)/ , attr: /zip_?1$|postal_?1$/i },
  { key: "postal.full", transform: "postal4", label: /郵便番号.*(下?4桁)/ , attr: /zip_?2$|postal_?2$/i },
  { key: "postal.full", label: /郵便番号|〒/, attr: /zip|postal|yubin/i },
  // --- address (specific before generic) ---
  { key: "address.full", transform: "addressAfterPref", label: /都道府県以降|それ以降の住所/ },
  { key: "address.full", label: /住所（都道府県|住所.*都道府県(から|を含む)/ },
  { key: "address.pref", label: /都道府県/, attr: /pref|todofuken/i },
  { key: "address.city", label: /市区町村/, attr: /city|shikuchoson/i },
  { key: "address.street", label: /番地|丁目/, attr: /street|banchi|addr(ess)?_?1$/i },
  { key: "address.building", label: /建物|マンション|部屋番号/, attr: /building|bldg|addr(ess)?_?2$/i },
  { key: "address.full", label: /住所/, attr: /address|jusho/i },
  // --- kana (split before full; before 姓/名) ---
  { key: "name.kana.sei", label: /^セイ|姓.*(カナ|かな)/, attr: /(last|family)_?name_?kana|sei_?kana/i },
  { key: "name.kana.mei", label: /^メイ|名.*(カナ|かな)/, attr: /first_?name_?kana|mei_?kana/i },
  { key: "name.kana.full", label: /フリガナ|ふりがな|カナ/, attr: /kana|furigana/i },
  // --- name ---
  { key: "name.sei", label: /^姓|お名前（姓）/, attr: /last_?name$|family_?name$|^sei$/i },
  { key: "name.mei", label: /^名(?!前|義)/, attr: /first_?name$|^mei$/i },
  { key: "name.full", label: /氏名|名前|フルネーム/, attr: /full_?name|^name$|shimei/i },
  // --- phone (split before full) ---
  { key: "phone.full", transform: "phone1", label: /市外局番/, attr: /tel_?1$|phone_?1$/i },
  { key: "phone.full", transform: "phone2", label: /市内局番/, attr: /tel_?2$|phone_?2$/i },
  { key: "phone.full", transform: "phone3", label: /加入者番号/, attr: /tel_?3$|phone_?3$/i },
  { key: "phone.full", label: /電話/, attr: /tel|phone/i },
  // --- email ---
  { key: "email", label: /メールアドレス|メール|E-?mail/i, attr: /mail/i },
  // --- company ---
  { key: "company.name", label: /会社名|貴社名|社名|法人名|企業名/, attr: /company|corp|kaisha/i },
  { key: "company.department", label: /部署|部門|所属/, attr: /department|dept|busho/i },
  // --- birth / gender ---
  { key: "birth.year", label: /生まれた年|生年/, attr: /birth_?year/i },
  { key: "birth.month", label: /^月$/, attr: /birth_?month/i },
  { key: "birth.day", label: /^日$/, attr: /birth_?day/i },
  { key: "gender", label: /性別/, attr: /gender|^sex$/i },
  // --- account ---
  { key: "account.id", label: /ログインID|ユーザーID|会員ID/i, attr: /login_?id|user_?id/i },
  { key: "account.password", label: /パスワード/, attr: /^pass(word)?$|^pw$/i },
];

const ATTESTATION_RE = /(18|１８)(歳|才)|成年|未成年|歳以上|に在住|に居住|権限を(有|持)|本人であること/;
const CONSENT_RE = /(規約|ポリシー|個人情報の取扱い).*同意|同意する/;

function labelText(field: FormField): string {
  return [...field.labels, field.placeholder, field.nearbyText].filter(Boolean).join(" ");
}

function attrText(field: FormField): string {
  return `${field.name} ${field.id}`;
}

function classifyOne(field: FormField, customs: CustomFieldDef[]): { key: ProfileKey; transform?: Transform } | undefined {
  const ac = field.autocomplete.trim().toLowerCase();
  if (ac && AUTOCOMPLETE_MAP[ac]) return AUTOCOMPLETE_MAP[ac];

  if (field.type === "password") return { key: "account.password" };

  const label = labelText(field);
  const attr = attrText(field);
  for (const rule of RULES) {
    if ((rule.label && rule.label.test(label)) || (rule.attr && rule.attr.test(attr))) {
      return rule.transform ? { key: rule.key, transform: rule.transform } : { key: rule.key };
    }
  }
  if (field.type === "email") return { key: "email" };
  if (field.type === "tel") return { key: "phone.full" };

  // User-added custom fields (dynamic schema): match by the stored terms.
  for (const custom of customs) {
    if (custom.matchTerms.some((t) => t && (label.includes(t) || attr.includes(t)))) {
      return { key: custom.key };
    }
  }
  return undefined;
}

export function classifyCheckbox(field: FormField): CheckboxClassification {
  const label = labelText(field);
  let role: CheckboxClassification["role"] = "optional-optin";
  if (ATTESTATION_RE.test(label)) role = "attestation";
  else if (CONSENT_RE.test(label)) role = "terms-consent";
  return { fieldId: field.fieldId, role, label: label.trim() };
}

/** Deterministic variant of the mapping step (compared against the AI variant, Q8). */
export function classifyFields(fields: FormField[], customs: CustomFieldDef[]): MappingPlan {
  const entries: MappingEntry[] = [];
  const checkboxes: CheckboxClassification[] = [];
  const unmappedRequired: string[] = [];

  for (const field of fields) {
    if (field.type === "checkbox") {
      checkboxes.push(classifyCheckbox(field));
      continue;
    }
    const hit = classifyOne(field, customs);
    if (hit) {
      const entry: MappingEntry = { fieldId: field.fieldId, profileKey: hit.key };
      if (hit.transform) entry.transform = hit.transform;
      entries.push(entry);
    } else if (field.required) {
      unmappedRequired.push(field.fieldId);
    }
  }
  return { entries, checkboxes, unmappedRequired };
}
