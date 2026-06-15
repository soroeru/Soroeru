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
  /** Stable identifier for tests / audit; surfaced as `rule:<id>` in evidence. */
  id: string;
  key: ProfileKey;
  transform?: Transform;
  /** Matches against label-ish text (labels + placeholder + nearbyText). */
  label?: RegExp;
  /** Matches against name/id attribute text. */
  attr?: RegExp;
}

export type ClassificationSource =
  | "autocomplete"
  | "input-type"
  | "rule"
  | "custom"
  | "checkbox"
  | "unmapped-required";

/**
 * Per-field provenance for the deterministic classifier. This is intentionally
 * NOT part of the shared `MappingPlan` contract (the AI variant has no concept
 * of a rule id); it is a deterministic-only diagnostic so accuracy regressions
 * and mis-mappings can be pinned in tests. Boundary with the shared type
 * contract work (#37) is: `MappingPlan` stays variant-agnostic; evidence lives
 * here.
 */
export interface FieldClassificationEvidence {
  fieldId: string;
  source: ClassificationSource;
  /** e.g. "ac:postal-code", "rule:card-holder", "type:password", "checkbox:attestation". */
  ruleId: string;
  profileKey?: ProfileKey;
  transform?: Transform;
  role?: CheckboxClassification["role"];
  /** The text fragment that triggered the match, for inspection. */
  matchedText: string;
}

export interface DeterministicClassification {
  plan: MappingPlan;
  evidence: FieldClassificationEvidence[];
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
  { id: "card-number", key: "card.number", label: /カード番号/, attr: /card_?num|cc_?num/i },
  { id: "card-exp-month", key: "card.exp.month", label: /有効期限.*月/, attr: /exp_?month/i },
  { id: "card-exp-year", key: "card.exp.year", label: /有効期限.*年/, attr: /exp_?year/i },
  { id: "card-cvv", key: "card.cvv", label: /セキュリティコード|CVV|CVC/i, attr: /cvv|cvc|csc|security_?code/i },
  { id: "card-holder", key: "card.holder", label: /カード名義|名義/, attr: /card_?name|holder/i },
  // --- postal (split before full) ---
  { id: "postal-3", key: "postal.full", transform: "postal3", label: /郵便番号.*(上?3桁)/ , attr: /zip_?1$|postal_?1$/i },
  { id: "postal-4", key: "postal.full", transform: "postal4", label: /郵便番号.*(下?4桁)/ , attr: /zip_?2$|postal_?2$/i },
  { id: "postal-full", key: "postal.full", label: /郵便番号|〒/, attr: /zip|postal|yubin/i },
  // --- address (specific before generic) ---
  { id: "address-after-pref", key: "address.full", transform: "addressAfterPref", label: /都道府県以降|それ以降の住所/ },
  { id: "address-full-with-pref", key: "address.full", label: /住所（都道府県|住所.*都道府県(から|を含む)/ },
  { id: "address-pref", key: "address.pref", label: /都道府県/, attr: /pref|todofuken/i },
  { id: "address-city", key: "address.city", label: /市区町村/, attr: /city|shikuchoson/i },
  { id: "address-street", key: "address.street", label: /番地|丁目/, attr: /street|banchi|addr(ess)?_?1$/i },
  { id: "address-building", key: "address.building", label: /建物|マンション|部屋番号/, attr: /building|bldg|addr(ess)?_?2$/i },
  { id: "address-full", key: "address.full", label: /住所/, attr: /address|jusho/i },
  // --- kana (split before full; before 姓/名) ---
  { id: "kana-sei", key: "name.kana.sei", label: /^セイ|姓.*(カナ|かな)/, attr: /(last|family)_?name_?kana|sei_?kana/i },
  { id: "kana-mei", key: "name.kana.mei", label: /^メイ|名.*(カナ|かな)/, attr: /first_?name_?kana|mei_?kana/i },
  { id: "kana-full", key: "name.kana.full", label: /フリガナ|ふりがな|カナ/, attr: /kana|furigana/i },
  // --- name ---
  { id: "name-sei", key: "name.sei", label: /^姓|お名前（姓）/, attr: /last_?name$|family_?name$|^sei$/i },
  { id: "name-mei", key: "name.mei", label: /^名(?!前|義)/, attr: /first_?name$|^mei$/i },
  { id: "name-full", key: "name.full", label: /氏名|名前|フルネーム/, attr: /full_?name|^name$|shimei/i },
  // --- phone (split before full) ---
  { id: "phone-1", key: "phone.full", transform: "phone1", label: /市外局番/, attr: /tel_?1$|phone_?1$/i },
  { id: "phone-2", key: "phone.full", transform: "phone2", label: /市内局番/, attr: /tel_?2$|phone_?2$/i },
  { id: "phone-3", key: "phone.full", transform: "phone3", label: /加入者番号/, attr: /tel_?3$|phone_?3$/i },
  { id: "phone-full", key: "phone.full", label: /電話/, attr: /tel|phone/i },
  // --- email ---
  { id: "email", key: "email", label: /メールアドレス|メール|E-?mail/i, attr: /mail/i },
  // --- company ---
  { id: "company-name", key: "company.name", label: /会社名|貴社名|社名|法人名|企業名/, attr: /company|corp|kaisha/i },
  { id: "company-department", key: "company.department", label: /部署|部門|所属/, attr: /department|dept|busho/i },
  // --- birth / gender ---
  { id: "birth-year", key: "birth.year", label: /生まれた年|生年/, attr: /birth_?year/i },
  { id: "birth-month", key: "birth.month", label: /^月$/, attr: /birth_?month/i },
  { id: "birth-day", key: "birth.day", label: /^日$/, attr: /birth_?day/i },
  { id: "gender", key: "gender", label: /性別/, attr: /gender|^sex$/i },
  // --- account ---
  { id: "account-id", key: "account.id", label: /ログインID|ユーザーID|会員ID/i, attr: /login_?id|user_?id/i },
  { id: "account-password", key: "account.password", label: /パスワード/, attr: /^pass(word)?$|^pw$/i },
];

const ATTESTATION_RE = /(18|１８)(歳|才)|成年|未成年|歳以上|に在住|に居住|権限を(有|持)|本人であること/;
const CONSENT_RE = /(規約|ポリシー|個人情報の取扱い).*同意|同意する/;

function labelText(field: FormField): string {
  return [...field.labels, field.placeholder, field.nearbyText].filter(Boolean).join(" ");
}

function attrText(field: FormField): string {
  return `${field.name} ${field.id}`;
}

interface ClassifyHit {
  key: ProfileKey;
  transform?: Transform;
  source: ClassificationSource;
  ruleId: string;
  matchedText: string;
}

function classifyOne(field: FormField, customs: CustomFieldDef[]): ClassifyHit | undefined {
  const ac = field.autocomplete.trim().toLowerCase();
  if (ac && AUTOCOMPLETE_MAP[ac]) {
    const m = AUTOCOMPLETE_MAP[ac]!;
    const hit: ClassifyHit = { key: m.key, source: "autocomplete", ruleId: `ac:${ac}`, matchedText: ac };
    if (m.transform) hit.transform = m.transform;
    return hit;
  }

  if (field.type === "password") {
    return { key: "account.password", source: "input-type", ruleId: "type:password", matchedText: "password" };
  }

  const label = labelText(field);
  const attr = attrText(field);
  for (const rule of RULES) {
    const labelMatch = rule.label?.exec(label);
    const attrMatch = labelMatch ? null : rule.attr?.exec(attr);
    if (labelMatch || attrMatch) {
      const hit: ClassifyHit = {
        key: rule.key,
        source: "rule",
        ruleId: `rule:${rule.id}`,
        matchedText: (labelMatch ?? attrMatch)?.[0] ?? "",
      };
      if (rule.transform) hit.transform = rule.transform;
      return hit;
    }
  }
  if (field.type === "email") return { key: "email", source: "input-type", ruleId: "type:email", matchedText: "email" };
  if (field.type === "tel") return { key: "phone.full", source: "input-type", ruleId: "type:tel", matchedText: "tel" };

  // User-added custom fields (dynamic schema): match by the stored terms.
  for (const custom of customs) {
    const term = custom.matchTerms.find((t) => t && (label.includes(t) || attr.includes(t)));
    if (term) {
      return { key: custom.key, source: "custom", ruleId: `custom:${custom.key}`, matchedText: term };
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

/**
 * Deterministic variant of the mapping step (compared against the AI variant,
 * Q8), with per-field provenance. The `plan` is the shared `MappingPlan`
 * contract; `evidence` is deterministic-only diagnostics.
 */
export function classifyFieldsWithEvidence(fields: FormField[], customs: CustomFieldDef[]): DeterministicClassification {
  const entries: MappingEntry[] = [];
  const checkboxes: CheckboxClassification[] = [];
  const unmappedRequired: string[] = [];
  const evidence: FieldClassificationEvidence[] = [];

  for (const field of fields) {
    if (field.type === "checkbox") {
      const box = classifyCheckbox(field);
      checkboxes.push(box);
      evidence.push({
        fieldId: field.fieldId,
        source: "checkbox",
        ruleId: `checkbox:${box.role}`,
        role: box.role,
        matchedText: box.label,
      });
      continue;
    }
    const hit = classifyOne(field, customs);
    if (hit) {
      const entry: MappingEntry = { fieldId: field.fieldId, profileKey: hit.key };
      if (hit.transform) entry.transform = hit.transform;
      entries.push(entry);
      const ev: FieldClassificationEvidence = {
        fieldId: field.fieldId,
        source: hit.source,
        ruleId: hit.ruleId,
        profileKey: hit.key,
        matchedText: hit.matchedText,
      };
      if (hit.transform) ev.transform = hit.transform;
      evidence.push(ev);
    } else if (field.required) {
      unmappedRequired.push(field.fieldId);
      evidence.push({
        fieldId: field.fieldId,
        source: "unmapped-required",
        ruleId: "unmapped-required",
        matchedText: "",
      });
    }
  }
  return { plan: { entries, checkboxes, unmappedRequired }, evidence };
}

/** Plan-only deterministic mapping (the `Mapper` seam contract). */
export function classifyFields(fields: FormField[], customs: CustomFieldDef[]): MappingPlan {
  return classifyFieldsWithEvidence(fields, customs).plan;
}
