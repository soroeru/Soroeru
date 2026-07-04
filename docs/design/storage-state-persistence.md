# 暗号化 storageState 永続化の設計

Issue: #294（#293 のフォローアップ）

## 決定事項（Product Owner確認済み）

- **既定の有効期限**: サイトのリスク階層に関わらず固定 **30日**。自動化セッションで
  実際に使用され再エクスポートされるたびに更新（スライディング）。期限切れの
  レコードは次回参照時に静かに破棄する。
- **許可モデル**: #291 のパーミッションモデルには依存しない、Site Account 単位の
  単純なブール値トグル（`persistSessionEnabled`）。トグルを無効化すると、保存済み
  `storageState` は即座に削除する（Delegation Boundary の縮小と同じ「無条件・即時」
  原則を、セッション信頼にも適用）。

## この増分の範囲

- Vault v2 に新しいエンティティ種別 `sessionState`（1 Site Account につき 1 レコード、
  `id = siteAccountId`）を追加し、他のレコードと同じ AES-256-GCM / Argon2id 導出鍵で
  暗号化する。
- `SiteAccount` に `persistSessionEnabled?: boolean` を追加（既定 false）。
- `DomainService`: 保存 / 取得（期限切れなら破棄）/ 明示クリア / トグルのメソッド。
- `BrowserEngine.openSession` が `storageState` 文字列を受け取れるようにし、
  `SiteSession` に任意メソッド `exportStorageState()` を追加（実装は
  `PlaywrightSiteSession` のみ；スクリプト化フェイクは実装不要）。
- `SoroeruSession.defaultOpenSession`: サイトが有効化されていれば保存済み
  `storageState` を読み込んでセッションを開き、閉じる直前にエクスポートして保存する
  ラッパーで `close()` を包む。ベストエフォート（失敗してもセッション終了は妨げない）。
- IPC: `sessionPersistenceSet`（有効/無効切り替え、無効化時は即時クリア）、
  `sessionPersistenceClear`（有効なまま今すぐクリア）。取得は既存の
  `ledgerSite` 詳細合成に `sessionPersistence` フィールドとして folding。
- レンダラー: `SiteDetail`（`LedgerPanel.tsx`、`SiteManagementPanel.tsx` 双方から
  使われる共有コンポーネント）にトグル + 状態表示 + 「今すぐクリア」ボタンを追加。

## 非範囲

- #291 のパーミッションモデルとの統合（今回は依存しない単純トグル）。
- サイトリスク別の可変期限（今回は固定 30 日）。
- 実サイトでの効果測定（#293 の設計ドキュメント同様、手動ベータ検証に委ねる）。

## セキュリティ

- `storageState` の JSON 文字列は他の vault レコードと同じ暗号化エンベロープに
  収まるため、平文でディスクに触れることはない。
- ログには一切出力しない（エクスポート/保存パス、エラーパスとも生値を含めない）。
- 期限切れレコードは読み取り時に破棄するのみで、明示的な「今すぐクリア」操作とは
  独立して自然に失効する。
