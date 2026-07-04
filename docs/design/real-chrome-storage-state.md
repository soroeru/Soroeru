# 実Chrome起動オプション + 暗号化storageState永続化の設計判断

Issue: #293（関連: #291）

## 背景

一部サイトはPlaywrightの同梱Chromiumビルドを、実際のGoogle Chromeバイナリより
自動化寄りとみなしてbot検知を強める可能性がある。専用Chrome拡張+Native Messaging
ブリッジ（#291）は同じ課題への重量級の代替案だが、新しい拡張サーフェス・ネイティブ
ホスト・パッケージング変更を要する。本Issueは、既存の`BrowserEngine`抽象の上で
完結する最小の代替案（`channel: "chrome"`起動オプション）を先に評価する。

## この増分で実装したもの

- `BrowserEngineOptions.channel?: "chrome"`: Playwrightの`channel: "chrome"`
  （ユーザーの実Chrome）で起動するオプトインオプション。デフォルトは従来通り同梱
  Chromiumのまま変更なし。
- `chromium`エンジン以外（`firefox` / `webkit`）では`channel`は無視される
  （Playwright上、`channel`はChromium系のみのオプションのため）。
- 実Chrome未インストール時のフォールバック: `channel: "chrome"`での起動が失敗した
  場合、同梱Chromiumで再起動する（`channel`指定以外の起動失敗はそのまま伝播する）。
- `buildLaunchOptions`という純粋関数に起動オプション組み立てを切り出し、実ブラウザ
  起動なしに単体テスト可能にした。`BrowserEngineOptions.launch`というテスト専用の
  注入ポイントを追加し、フォールバック分岐を実ブラウザなしで検証できるようにした。
- テスト: `tests/unit/soroeru-browser-engine.test.ts`
  （オプション組み立て、chrome起動、フォールバック、無関係な起動失敗の非握りつぶし）。

## この増分で実装していないもの（フォローアップIssueへ）

- **暗号化`storageState`永続化**: Playwrightの`storageState`をエクスポートし、他の
  vaultレコードと同じ方式（AES-256-GCM、Argon2id鍵導出）で暗号化して保存/復元する
  vault新レコード種別。Site Account単位でスコープし、ユーザーが閲覧・失効できる
  UIを伴う。これは`domain-service.ts`・IPCコントラクト・レンダラーUIにまたがる、
  今回の変更より大きい機能追加であり、別Issueとして切り出す。
- **設定UIへの結線**: 現状`channel: "chrome"`はどの設定画面からも到達できない
  コンストラクタオプションのまま。ユーザー向けトグルを追加するかは、下記の比較
  データが集まってから判断する。
- **実サイトでのA/Bデータ収集**: 本Issueの計画では「同梱Chromium vs
  `channel: 'chrome'`のサイト単位pass/fail比較」を求めていたが、このセッションの
  環境では実サイトへのネットワークアクセスや実サイト向けテスト認証情報がなく、
  `docs/testing.md`もローカルフィクスチャ限定の自動テスト方針であるため収集して
  いない。手動ベータ検証時にこのオプションを使って比較することを想定する。

## 推奨

`docs/architecture.md` §2.1に記録した通り、(b)「`channel: "chrome"`をオプトイン
のフォールバックとして追加する」を採用した。実測データに基づく判断ではなく、
以下の理由による:

- 新しい拡張サーフェス・ネイティブホスト・パッケージング変更が不要（#291より
  低コスト）。
- デフォルト挙動・既存の`PageDriver`/壁検出契約を変えない（既存テスト425件が
  無変更で通過）。
- vault永続化を伴わないため、この増分単体でのセキュリティ影響は起動時の
  ブラウザバイナリ選択のみに限定される。

`storageState`永続化と設定UIへの結線は、実ベータでの効果が確認されてから
別Issueで進める。
