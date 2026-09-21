import type { CollectionTarget } from "./collection-observation.js";

const ACTION = /logout|log.?off|sign.?out|delete|remove|withdraw|cancel|unsubscribe|confirm|submit|purchase|checkout|pay(?:ment)?(?:now|execute)|save|update|change|mutat|opt.?out|設定変更|変更|削除|退会|解除|解約|購入|注文|確定|送信|登録する|ログアウト/i;
const INFORMATION = /profile|account|address|contact|billing|security|personal|mypage|会員情報|登録情報|プロフィール|住所|連絡先|請求|支払情報|セキュリティ/i;
/** Exact authenticated host is a conservative subset of registrable-site scope. */
export function collectionUrlAllowed(url: string, siteUrl: string): boolean {
  try {
    const u = new URL(url), site = new URL(siteUrl);
    if (u.protocol !== "https:" || site.protocol !== "https:" || u.origin !== site.origin || u.username || u.password) return false;
    let text = `${u.pathname}${u.search}${u.hash}`;
    for (let i = 0; i < 4; i++) {
      if (ACTION.test(text)) return false;
      const decoded = decodeURIComponent(text);
      if (decoded === text) return true;
      text = decoded;
    }
    return false;
  } catch { return false; }
}
export function collectionNavigation(target: CollectionTarget, siteUrl: string): "allow" | "confirm" | "deny" {
  if (!target.passive || !collectionUrlAllowed(target.href, siteUrl) || ACTION.test(target.text)) return "deny";
  return INFORMATION.test(target.text) && INFORMATION.test(new URL(target.href).pathname) ? "allow" : "confirm";
}
