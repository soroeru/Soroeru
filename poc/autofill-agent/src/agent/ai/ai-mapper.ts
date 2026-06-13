// AI variant of the mapper (RFC-001 v3 §8 version 2, §6).
// The model receives form structure (labels / names / types / options) and terms
// text, and returns a mapping PLAN. Actual values are resolved and filled locally
// by the Playwright layer; no profile value ever enters a prompt.

import {
  KNOWN_PROFILE_KEYS,
  HIGH_RISK_FLAG_DESCRIPTIONS,
  HIGH_RISK_FLAGS,
  TRANSFORM_DESCRIPTIONS,
  TRANSFORMS,
  type CheckboxClassification,
  type HighRiskFlag,
  type KnownProfileKey,
  type MappingEntry,
  type MappingPlan,
  type PageLink,
  type PageSnapshot,
  type PaymentClassification,
  type ProfileKey,
  type TermsAnalysis,
  type Transform,
} from "../../types.js";
import type { CustomFieldDef } from "../classifier.js";
import type { Mapper } from "../mapper.js";
import { normalizeMappingPlan, normalizeTermsAnalysis } from "../normalization.js";
import type { AiProvider } from "./provider.js";

const PROFILE_KEY_DESCRIPTIONS = {
  "name.full": "氏名（姓名つなげた表記）",
  "name.sei": "姓",
  "name.mei": "名",
  "name.kana.full": "フリガナ全体",
  "name.kana.sei": "セイ",
  "name.kana.mei": "メイ",
  email: "メールアドレス（確認用の再入力欄も email にマップする）",
  "phone.full": "電話番号全体",
  "postal.full": "郵便番号全体",
  "address.full": "住所全体",
  "address.pref": "都道府県",
  "address.city": "市区町村",
  "address.street": "番地",
  "address.building": "建物名",
  "company.name": "会社名",
  "company.department": "部署名",
  "birth.year": "生まれた年",
  "birth.month": "生まれた月",
  "birth.day": "生まれた日",
  gender: "性別",
  "card.number": "カード番号",
  "card.exp.month": "カード有効期限月",
  "card.exp.year": "カード有効期限年",
  "card.holder": "カード名義",
  "card.cvv": "カードセキュリティコード",
  "account.id": "ログインID",
  "account.password": "パスワード",
} satisfies Record<KnownProfileKey, string>;

const KEY_GUIDE = `
プロフィールキー一覧（値の意味）:
${KNOWN_PROFILE_KEYS.map((key) => `- ${key} ${PROFILE_KEY_DESCRIPTIONS[key]}`).join("\n")}

transform一覧:
${TRANSFORMS.map((transform) => `- ${transform}: ${TRANSFORM_DESCRIPTIONS[transform]}`).join("\n")}
`;

const HIGH_RISK_GUIDE = HIGH_RISK_FLAGS.map((flag) => `${flag}（${HIGH_RISK_FLAG_DESCRIPTIONS[flag]}）`).join(" / ");

function mapFieldsSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["entries", "checkboxes", "unmappedRequired"],
    properties: {
      entries: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["fieldId", "profileKey"],
          properties: {
            fieldId: { type: "string" },
            profileKey: { type: "string" },
            transform: { anyOf: [{ type: "string", enum: TRANSFORMS }, { type: "null" }] },
          },
        },
      },
      checkboxes: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["fieldId", "role", "label"],
          properties: {
            fieldId: { type: "string" },
            role: { type: "string", enum: ["terms-consent", "attestation", "optional-optin"] },
            label: { type: "string" },
          },
        },
      },
      unmappedRequired: { type: "array", items: { type: "string" } },
    },
  };
}

export class AiMapper implements Mapper {
  readonly name = "ai";
  constructor(private readonly provider: AiProvider) {}

  async discoverRegistrationLink(links: PageLink[]): Promise<PageLink | undefined> {
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["href"],
      properties: { href: { anyOf: [{ type: "string" }, { type: "null" }] } },
    };
    const result = (await this.provider.completeJson({
      system:
        "あなたはWebサイト内から新規ユーザー登録（アカウント作成）ページへのリンクを特定するアシスタントです。リンク一覧から新規登録ページに最も該当するリンクのhrefを1つ返してください。ログイン・登録情報の変更・問い合わせは対象外です。該当がなければnull。",
      user: JSON.stringify(links),
      schema,
    })) as { href: string | null };
    if (!result.href) return undefined;
    return links.find((l) => l.href === result.href);
  }

  async mapFields(snapshot: PageSnapshot, customs: CustomFieldDef[]): Promise<MappingPlan> {
    const structure = snapshot.fields.map((f) => ({
      fieldId: f.fieldId,
      tag: f.tag,
      type: f.type,
      name: f.name,
      id: f.id,
      autocomplete: f.autocomplete,
      required: f.required,
      placeholder: f.placeholder,
      labels: f.labels,
      nearbyText: f.nearbyText,
      options: f.options?.map((o) => ({ value: o.value, label: o.label })),
    }));
    const customGuide =
      customs.length > 0
        ? `\nユーザー定義のカスタムキー（該当する欄はこのキーにマップする）:\n${customs
            .map((c) => `- ${c.key}（語: ${c.matchTerms.join(", ")}）`)
            .join("\n")}`
        : "";
    const result = (await this.provider.completeJson({
      system: `あなたは日本語の登録フォームの各欄を、ユーザープロフィールのキーにマッピングするアシスタントです。
${KEY_GUIDE}${customGuide}
ルール:
- 値そのものは渡されません。構造（ラベル・name・type・選択肢）だけで判断します。
- checkbox はマッピングせず、役割を分類します: terms-consent（規約への同意）/ attestation（年齢・居住・資格など本人性の表明）/ optional-optin（メルマガ等の任意オプトイン）。
- どのキーにも該当しない required な欄は unmappedRequired に fieldId を入れます。勝手に近いキーへ割り当ててはいけません。
- transform は分割値の場合のみ指定します。`,
      user: JSON.stringify(structure),
      schema: mapFieldsSchema(),
    })) as {
      entries: { fieldId: string; profileKey: string; transform?: Transform | null }[];
      checkboxes: CheckboxClassification[];
      unmappedRequired: string[];
    };

    const entries: MappingEntry[] = [];
    for (const e of result.entries) {
      const entry: MappingEntry = { fieldId: e.fieldId, profileKey: e.profileKey as ProfileKey };
      if (e.transform) entry.transform = e.transform;
      entries.push(entry);
    }
    return normalizeMappingPlan({ entries, checkboxes: result.checkboxes, unmappedRequired: result.unmappedRequired }, snapshot.fields, customs);
  }

  async analyzeTerms(termsText: string, pageText: string, hasCardFields: boolean): Promise<TermsAnalysis> {
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["highRisk", "payment", "prohibitsAutoCreation"],
      properties: {
        highRisk: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["flag", "quote"],
            properties: {
              flag: { type: "string", enum: HIGH_RISK_FLAGS },
              quote: { type: "string" },
            },
          },
        },
        payment: {
          type: "string",
          enum: ["trial-subscription", "immediate-payment", "unknown", "none"],
        },
        prohibitsAutoCreation: { type: "boolean" },
      },
    };
    const result = (await this.provider.completeJson({
      system: `あなたは利用規約とページ文言を分析するアシスタントです。
1. 高リスク条項を検出して該当箇所を引用します: ${HIGH_RISK_GUIDE}。
2. payment: カード入力欄が${hasCardFields ? "あります" : "ありません"}。「無料トライアル後に課金が始まる」型は trial-subscription、「その場で即時決済」型は immediate-payment、カード欄があるのに判別できなければ unknown（安全側）、カード欄がなければ none。
3. prohibitsAutoCreation: 規約が自動アカウント作成を禁止しているか。`,
      user: JSON.stringify({ terms: termsText.slice(0, 12000), page: pageText.slice(0, 6000) }),
      schema,
    })) as {
      highRisk: { flag: HighRiskFlag; quote: string }[];
      payment: PaymentClassification | "none";
      prohibitsAutoCreation: boolean;
    };

    const evidence: Partial<Record<HighRiskFlag, string>> = {};
    const flags: HighRiskFlag[] = [];
    for (const item of result.highRisk) {
      if (!flags.includes(item.flag)) {
        flags.push(item.flag);
        evidence[item.flag] = item.quote;
      }
    }
    const analysis: TermsAnalysis = {
      highRiskFlags: flags,
      evidence,
      prohibitsAutoCreation: result.prohibitsAutoCreation,
    };
    if (hasCardFields) {
      analysis.payment = result.payment === "none" ? "unknown" : result.payment;
      if (analysis.payment === "trial-subscription" && !flags.includes("trial-subscription")) {
        analysis.highRiskFlags = [...flags, "trial-subscription"];
      }
    }
    return normalizeTermsAnalysis(analysis);
  }
}
