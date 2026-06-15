// Deterministic registration-page discovery: score visible links by wording
// (RFC-001 v3 §4 step 1). The AI variant does the same with the model.

import type { PageLink } from "../types.js";

const POSITIVE: { re: RegExp; score: number }[] = [
  { re: /新規(会員)?登録|会員登録|新規お?申し?込み/, score: 5 },
  { re: /アカウント(作成|登録)/, score: 5 },
  { re: /サインアップ|sign\s?up|register/i, score: 4 },
  { re: /無料(会員)?登録|無料トライアル|無料で(始める|試す)/, score: 4 },
  { re: /入会|登録(（無料）)?はこちら|登録（無料）/, score: 3 },
  { re: /トライアルを?始める/, score: 4 },
  { re: /登録/, score: 1 },
];

const NEGATIVE = /ログイン|サインイン|解約|退会|登録情報の変更|変更|お問い合わせ/;

export function scoreRegistrationLink(text: string): number {
  if (NEGATIVE.test(text)) return -1;
  let score = 0;
  for (const { re, score: s } of POSITIVE) {
    if (re.test(text)) score += s;
  }
  return score;
}

export function findRegistrationLink(links: PageLink[]): PageLink | undefined {
  let best: PageLink | undefined;
  let bestScore = 0;
  for (const link of links) {
    const score = scoreRegistrationLink(link.text);
    if (score > bestScore) {
      best = link;
      bestScore = score;
    }
  }
  return best;
}

const EDIT_LINK_RE = /登録情報|会員情報|アカウント(設定|情報)|お客様情報|(情報|内容)の(変更|編集|確認)/;

export function findEditLink(links: PageLink[]): PageLink | undefined {
  return links.find((l) => EDIT_LINK_RE.test(l.text));
}
