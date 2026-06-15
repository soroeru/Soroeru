// Checked-in "official" site definitions (#80, extension.md §3.2). These
// cover a few of the local Playwright test sites (`sites/defs.ts`) so the
// shared definition model has concrete, testable examples. Real-site
// definitions are added the same way once a site is supported; none of these
// definitions contain raw personal values.

import type { SiteDefinition } from "../types.js";

export const OFFICIAL_DEFINITIONS: SiteDefinition[] = [
  {
    id: "local-01-basic",
    serviceName: "ベーシック商店",
    match: { urlPatterns: ["/site/01-basic/"] },
    registrationSignature: {
      pathPatterns: ["/register$"],
      fieldTokens: ["fullname", "login_id", "zip"],
      headingPatterns: ["ベーシック商店"],
      buttonPatterns: ["登録する"],
    },
    fieldRules: [
      { id: "login-id", profileKey: "account.id", labelPattern: "ログインID", attrPattern: "login_?id" },
      { id: "password", profileKey: "account.password", labelPattern: "パスワード" },
    ],
  },
  {
    id: "local-08-terms",
    serviceName: "テスト商事",
    match: { urlPatterns: ["/site/08-terms/"] },
    registrationSignature: {
      pathPatterns: ["/register$"],
      fieldTokens: ["kana", "agree", "adult"],
      headingPatterns: ["テスト商事"],
      buttonPatterns: ["同意して登録"],
    },
    fieldRules: [{ id: "kana-full", profileKey: "name.kana.full", labelPattern: "フリガナ" }],
    notes: "利用規約に自動更新（第4条）と第三者提供（第6条）の条項があり、ゲートで高リスクとして提示される。",
    withdrawalSteps: [{ description: "アカウント設定から退会手続きページへ移動する。" }],
  },
  {
    id: "local-10-no-auto",
    serviceName: "テストポータル",
    match: { urlPatterns: ["/site/10-no-auto/"] },
    registrationSignature: {
      pathPatterns: ["/register$"],
      fieldTokens: ["kana", "agree"],
      headingPatterns: ["テストポータル"],
      buttonPatterns: ["登録する"],
    },
    notes: "規約第2条が自動化されたアカウント作成を禁止しているため、入力のみ行い最終送信はユーザーに委ねる（assistedFill）。",
  },
];
