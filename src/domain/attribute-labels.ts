const FIXED_ATTRIBUTE_LABEL_ENTRIES = [
  ["name.full", "氏名"],
  ["name.sei", "姓"],
  ["name.mei", "名"],
  ["name.kana.full", "フリガナ"],
  ["name.kana.sei", "セイ"],
  ["name.kana.mei", "メイ"],
  ["email", "メールアドレス"],
  ["phone.full", "電話番号"],
  ["postal.full", "郵便番号"],
  ["address.full", "住所"],
  ["address.pref", "都道府県"],
  ["address.city", "市区町村"],
  ["address.street", "番地"],
  ["address.building", "建物名"],
  ["company.name", "会社名"],
  ["company.department", "部署名"],
  ["birth.year", "生年"],
  ["birth.month", "生月"],
  ["birth.day", "生日"],
  ["gender", "性別"],
  ["card.number", "カード番号"],
  ["card.exp.month", "カード有効期限（月）"],
  ["card.exp.year", "カード有効期限（年）"],
  ["card.holder", "カード名義"],
  ["card.cvv", "セキュリティコード"],
  ["account.id", "ログインID"],
  ["account.password", "パスワード"],
] as const;

export const FIXED_ATTRIBUTE_LABELS: ReadonlyMap<string, string> = new Map(FIXED_ATTRIBUTE_LABEL_ENTRIES);

export function displayLabelWithAttributeKey(attributeKey: string, label: string | undefined): string {
  const trimmed = label?.trim();
  if (!trimmed || trimmed === attributeKey) return attributeKey;
  return `${trimmed}（${attributeKey}）`;
}
