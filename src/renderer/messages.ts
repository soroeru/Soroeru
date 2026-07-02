// User-facing Japanese strings for the sanitized reason codes the trusted layer
// returns (RFC-002 §5.1). The renderer never sees raw values or vault internals,
// only these codes; this module maps them to safe, non-leaking messages. An
// unknown code falls back to a generic message rather than echoing the code.

const REASONS: Record<string, string> = {
  // Vault lifecycle
  "passphrase-too-short": "パスフレーズが短すぎます。",
  "vault-already-exists": "ボールトはすでに存在します。",
  "vault-not-found": "ボールトが見つかりません。",
  "unlock-failed": "解錠に失敗しました。パスフレーズまたはリカバリーキーをご確認ください。",
  "recovery-failed": "リカバリーキーを生成できませんでした。",
  locked: "ボールトが施錠されています。",
  busy: "別の収集処理が実行中です。完了してから再試行してください。",
  // CSV import
  "too-large": "ファイルが大きすぎます。",
  "too-many-rows": "CSV の行数が多すぎます。",
  empty: "CSV が空です。",
  "bad-header": "CSV のヘッダー形式が想定と異なります（name,url,username,password,note）。",
  "bad-file-type": "保存した HTML ファイル（.html / .htm）を選択してください。",
  "import-failed": "取り込みに失敗しました。",
  "open-failed": "既定ブラウザでサイトを開けませんでした。",
  "bad-url": "このサイトの URL は既定ブラウザで開けません。",
  "mark-failed": "手動確認の印を記録できませんでした。",
  // Reveal
  "not-found": "対象が見つかりません。",
  "reveal-not-permitted": "この値は表示できません（最も機微な項目）。",
  "reauth-failed": "パスフレーズが一致しません。",
  "no-raw-value": "表示できる生の値がありません（ハッシュのみ収集済み）。",
  // Dynamic attribute candidates
  "invalid-request": "入力内容をご確認ください。",
  "confirm-failed": "項目の確定に失敗しました。",
  "confirmation-required": "確認が必要です。",
  "delete-failed": "削除に失敗しました。",
};

const FALLBACK = "操作に失敗しました。時間をおいて再試行してください。";

export function reasonMessage(code: string | undefined): string {
  if (code === undefined) return FALLBACK;
  return REASONS[code] ?? FALLBACK;
}

/** Human label for an Account Relationship kind shown on ledger filters/rows. */
export function relationshipLabel(kind: string): string {
  switch (kind) {
    case "newsletter":
      return "ニュースレター";
    case "recurring-billing":
      return "継続課金";
    case "free-trial":
      return "無料トライアル";
    case "membership":
      return "会員";
    case "last-used":
      return "最終利用";
    default:
      return kind;
  }
}

/** Human label for the terminal status of a Visibility run. */
export function visibilityStatusLabel(status: string): string {
  switch (status) {
    case "collected":
      return "収集が完了しました。";
    case "handoff":
      return "ウォール（CAPTCHA / MFA / 検証）で収集が止まりました。同じブラウザで解決してから再実行してください。";
    case "failed":
      return "収集に失敗しました。";
    case "unreachable":
      return "サイトにアクセスできませんでした。アクセス不能一覧に記録しました。";
    case "skipped":
      return "Web サイトではない認証情報のため収集をスキップしました（例: アプリ）。";
    case "login-failed":
      return "ログインが完了しませんでした（パスワードの変更や追加手順の可能性）。要確認に記録しました。";
    case "no-data":
      return "ページには到達しましたが、収集できる情報が見つかりませんでした（手動確認を推奨）。";
    case "canceled":
      return "収集を中止しました。";
    case "locked":
      return "ボールトが施錠されています。";
    case "busy":
      return "別の収集が進行中です。";
    default:
      return "収集が終了しました。";
  }
}

/** Human label for a stale state shown as the ledger's freshness flag. */
export function staleLabel(state: "current" | "stale" | "unknown"): string {
  switch (state) {
    case "current":
      return "最新";
    case "stale":
      return "古い";
    case "unknown":
      return "不明";
  }
}
