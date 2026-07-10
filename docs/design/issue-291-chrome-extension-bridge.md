# Soroeru専用Chrome拡張 + Electronブリッジ 設計スパイク

Issue: #291（関連: #293 実Chrome起動オプション、#294 暗号化storageState永続化）

## 結論

- **位置づけ: post-MVPのアーキテクチャオプション + 開発者限定の実サイト実験ツール。**
  MVPスコープ変更ではない。`docs/architecture.md` §1の「browser-extension
  distributionはpost-MVP」の方針は維持する。
- **この増分は設計ドキュメントのみ**とし、実装Issueは再検討トリガーが成立するまで
  起票しない。同じ課題（Playwright同梱Chromiumが実サイトのbot/リスク判定を誘発する）
  への軽量な代替案 #293（`channel: "chrome"`）と #294（暗号化`storageState`永続化）が
  先に実装済みであり、まずそれらの手動ベータ比較データを集める。
- **再検討トリガー**: 手動ベータで、`channel: "chrome"` と永続化`storageState`を併用
  してもbot/リスク判定起因で収集に失敗するサイトが**2件以上**確認され、かつ失敗原因が
  セレクタ/フロー不一致ではなくブラウザサーフェス（プロファイル状態・実行環境）に
  帰着すると診断されたとき。成立したら本設計の「フォローアップ実装Issue分割」を起票する。
- Codex Chrome拡張・そのnative host・OpenAI/Codexの非公開プロトコルには一切依存しない。
  本設計はChrome拡張API（Manifest V3）とNative Messaging（いずれも公開API）のみを使う。
- 既存のPlaywright経路は置き換えず、`PageDriver`の第2実装として共存させる（§5）。

## 1. 背景・課題

Playwrightが起動する同梱Chromium（またはephemeral context）は、実サイトのbot/リスク
判定に「新規環境からの自動化」として扱われやすい。一方、ユーザーの通常のChrome
プロファイルには、そのサイトが期待するブラウザ状態（長期cookie、デバイス評価、
ログイン済みセッション）が既にある。Visibility収集・一括更新・登録のワークフローを
ユーザー自身のChromeの中で動かせれば、この差を正面から（偽装なしで）解消できる。

前提となる安全境界は変わらない: **これはbot検知の回避ではない**。ユーザー本人の
ブラウザ・本人のセッションで、本人が明示承認した操作を実行するだけであり、
fingerprint偽装・UA偽装・stealth・CAPTCHA/MFA/bot検知の解決や迂回は一切実装しない
（`docs/security.md` §7）。拡張はむしろ実行中であることをバッジとページ内バナーで
**可視化**する。

## 2. 選択肢比較

| 観点 | A: 現行Playwright（+#293/#294） | B: Soroeru専用拡張 + Native Messaging + Electronブリッジ | C: 拡張 + localhost WebSocketでElectron直結 |
| --- | --- | --- | --- |
| 実ブラウザ状態の忠実度 | 中（`channel:"chrome"`で実バイナリ、`storageState`でcookie再現。ただし別プロファイル） | 高（ユーザーの通常プロファイルそのもの） | 高（同左） |
| 相手方の認証 | 不要（自プロセス起動） | Chrome側: manifestの`allowed_origins`で拡張IDを固定。Soroeru側: hostバイナリはChromeのみが起動 | 弱い。localhostポートには任意のローカルプロセス・任意のWebページ（CSRF的に）が接続を試行でき、独自認証が必要 |
| 実装・パッケージングコスト | 済 | 高（拡張、host、ブリッジ、登録UX、テストが新規） | 中〜高（拡張とブリッジは同等、hostは不要だがポート管理と認証が増える） |
| `PageDriver`適合 | 済 | 可（§5。コマンドの非同期往復に収まる） | 可（同左） |
| ユーザー理解可能性 | 高（アプリ内で完結） | 中（拡張インストール+接続の追加ステップ。ただしChromeの権限UIに乗る） | 低（「アプリがポートを開いて待つ」は説明しにくく、事故の説明も難しい） |
| 誤動作の影響範囲 | 小（使い捨てcontext） | 大（実プロファイル。§7で緩和） | 大（同左 + 接続元のなりすましリスク） |

**採用（実装する場合）は B。** CはNative Messagingが無償で与える相互認証
（拡張ID allowlist / Chromeによるhost起動管理）を自前で再発明することになり、
常時listenするlocalhostポートという新しい攻撃面も増える。Aは引き続きデフォルト経路
であり、Bが入ってもCSV一括収集のような「ユーザーが見ていない間のバッチ」用途では
Aが適する（Bはユーザーの現用ブラウザを占有するため）。

## 3. アーキテクチャ（B案の詳細）

```text
Chrome（ユーザーの通常プロファイル）
├── Soroeru拡張（Manifest V3）
│   ├── service worker（background）
│   │   ├── Native Messaging接続の確立・再接続
│   │   ├── タブバインド管理（1ワークフロー実行 = 1タブ）
│   │   ├── per-siteホスト権限の実行時リクエスト
│   │   └── コマンド検証・ルーティング、バッジ表示
│   └── content script（バインドされたタブにのみ動的注入）
│       ├── PageSnapshot形状の構造抽出（値なし）
│       ├── 値のローカル読み取り（readValues / readDisplayValues）
│       ├── 承認済みコマンド実行（goto / fill / click / waitForReady）
│       └── 実行中バナーの表示（自動化の可視化）
│
│   chrome.runtime.connectNative()  …  stdio（4byte長プレフィックスJSON）
│
├── native messaging host（純リレーの小バイナリ、app-support配下に設置）
│
│   UNIXドメインソケット（app-support配下、0700ディレクトリ + 起動毎トークン）
│
└── Soroeru.app（Electron main、信頼側）
    ├── ChromeExtensionBridge
    │   ├── ソケットlisten、ハンドシェイク（トークン照合）
    │   ├── メッセージスキーマ検証（バージョン付き、未知コマンド拒否）
    │   └── 接続状態のtyped IPCイベント化（レンダラーへはマスク済みのみ）
    ├── ExtensionPageDriver（PageDriver実装、§5）
    └── AutomationService / VisibilityRunner / DomainService / Vault（既存のまま）
```

### 3.1 拡張マニフェストと権限モデル

- `permissions`: `nativeMessaging`, `scripting`, `activeTab`, `storage`
  （`storage`は接続メタデータのみ。収集値・認証情報・スナップショットは保存禁止）。
- ホスト権限は**静的に要求しない**（`<all_urls>`も広域パターンも禁止）。
  `optional_host_permissions: ["https://*/*"]` を宣言し、ワークフロー実行の開始時に
  対象サイトの**オリジン単位**で `chrome.permissions.request` を出してユーザーが
  その場で承認する。承認済みオリジンは拡張のオプションページから一覧・取り消し可能。
- **要求しない権限**: `history`、`bookmarks`、`cookies`、`downloads`、`webRequest`、
  `debugger`。閲覧履歴・ブックマークはSoroeruの機能に不要であり、将来も拡張経由で
  読まない。cookieはサイトが自分で使うだけでSoroeruは読み取らない。
- 拡張自身は外部ネットワーク通信を行わない（`fetch`等の使用ゼロ）。通信相手は
  Native Messaging host のみ。

### 3.2 content script と service worker の責務分離

- **content script**（信頼度: ページと同居するため最小権限）: DOM構造の抽出と
  承認済みコマンドの実行のみ。判断ロジック（分類、壁検出、ゲート）は持たない。
  抽出する構造は既存の`PageSnapshot`（`src/types.ts`）と同形状 — ラベル /
  `name` / `id` / type / options / 近傍テキスト / 壁マーカー — で、**値を含まない**。
  値は`readValues`コマンドへの応答としてのみ読み、ページ内に保持しない。
- **service worker**: hostとの接続、タブバインド、権限リクエスト、コマンドの
  検証とルーティング、バッジ。コマンドは「バインド済みタブ + 承認済みオリジン」
  以外への実行を拒否する。

### 3.3 Native Messaging host の登録（macOS）

- manifest JSONを
  `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/jp.soroeru.bridge.json`
  に書き、`allowed_origins`をSoroeru拡張の拡張IDに固定する。
- **hostバイナリは`.app`内を直接指さない。** 未署名DMG（MVP配布形態）はGatekeeperの
  App Translocationで起動パスがランダム化されうるほか、ユーザーが`.app`を移動すると
  manifestの`path`が壊れる。接続セットアップ時にhostバイナリを
  `~/Library/Application Support/Soroeru/native-host/` へコピーし、そのパスを登録する。
- hostは**純リレー**とする: stdio（Chrome側、4byte長プレフィックスJSON）と
  UNIXドメインソケット（Electron側）の間でフレームを転送するだけで、ロジック・
  永続化・ログ出力（メッセージ本文）を持たない。Soroeru本体が起動していなければ
  接続失敗を拡張へ返して終了する。
- 登録の解除（manifest削除・バイナリ削除）はアプリ内の切断操作とアンインストール
  手順の両方から行えるようにする。

### 3.4 Electronブリッジと型付き境界

- `ChromeExtensionBridge`はElectron main（信頼側）に置き、`AutomationService`の
  背後に隠す。レンダラーは拡張と直接通信しない — 既存の typed IPC
  （`electron/ipc/contract.ts`）に接続状態・タブ選択・実行イベント用のチャネルを
  追加し、ペイロードは既存規約どおり「参照 / 件数 / マスク済み文言のみ」とする。
- ソケットはapp-support配下の0700ディレクトリに置き、Electron起動毎に生成する
  ランダムトークン（0600のファイル経由でhostが読む）でハンドシェイクする。
  トークン不一致・スキーマ不一致・未知コマンドは即切断する。
- 拡張・host・Electronで**メッセージスキーマを共有する単一モジュール**
  （バージョンフィールド付きの判別可能ユニオン）を持ち、三者すべてが受信時に
  スキーマ検証する。スキーマ検証・拒否パスは単体テスト対象（§9）。

### 3.5 タブ選択とワークフローへの結び付け

- ワークフロー実行は**ユーザーが明示的に選んだタブ**（または拡張が承認済み
  オリジンで新規に開き、ユーザーが確認したタブ）1つに束縛される。
- 実行中、コマンドはバインドタブにのみ届き、ナビゲーションは承認済み
  オリジン内に制限される。タブがバインド外のオリジンへ遷移したら実行は
  自動的に一時停止し、ユーザー操作待ちにする。
- バッジ（拡張アイコン）とページ内バナーで「Soroeruがこのタブを操作中」を常時
  表示し、バナーとアプリ側の両方から即時停止できる。停止は無条件・即時
  （Delegation Boundaryの縮小と同じ非対称原則）。
- タブグループの管理・複数タブ並列駆動はスコープ外（v1は常に1タブ）。

## 4. データ取り扱いルール

| データ | 扱い |
| --- | --- |
| DOM構造（PageSnapshot） | ワークフローの1ステップで消費し破棄。永続化はPlaywright経路と同じ暗号化Disclosure/Evidence（参照+ハッシュ、`docs/architecture.md` §3.3）のみ。拡張側・host側では保持しない。 |
| 収集した値 | `readValues`応答としてブリッジ経由でElectron mainに渡り、即時に既存の暗号化vaultレコードへ。カード番号は下4桁化、CVVは収集しない（REQ-004のまま）。 |
| 記入する値（fill） | Playwright経路と同じく自動化層が充填時に注入する。経路がNative Messaging/ソケットになるが、これはローカルIPCであり外部egressではない。host・ブリッジ・拡張のどの層でも値を含むメッセージをログ・永続化しない。 |
| スクリーンショット | 取得しない（既存のEvidence最小化方針のまま）。 |
| cookie / storageState | 読まない・エクスポートしない・保存しない。`SiteSession.exportStorageState`は拡張経路では**実装しない**（#294はPlaywrightサーフェス専用。ユーザーの実プロファイルのセッションを吸い出さない）。 |
| 閲覧履歴 / ブックマーク | 権限自体を要求しない（§3.1）。 |
| ダウンロード / アップロード | v1スコープ外。必要になったら個別Issueで境界を設計する。 |
| 認証情報 | 既存vaultからfillコマンドで注入。拡張の`storage`には置かない。 |

**AI不変条件は不変**: AIに渡りうるのは構造（PageSnapshot）と規約テキストのみで、
生の個人値は拡張経路でもmapper入力・AIプロンプトに入らない
（`tests/unit/soroeru-poc-contracts.test.ts`の不変条件がそのまま適用される）。

**egressチェック（PRIV-001）への影響**: ソケット/Native Messagingは外部egressでは
ないが、拡張コードは新しいコード面になるため、実装時は`check-egress`のスキャン対象に
`extension/`を追加し、拡張内からの外部`fetch`等をゼロとして強制する。

## 5. `PageDriver` / `BrowserEngine` との相互運用

- `ExtensionPageDriver implements PageDriver`（`src/automation/page-driver.ts`）:
  `goto` / `currentUrl` / `snapshot` / `readValues` / `readDisplayValues` /
  `fillField` / `click` / `waitForReady` をそれぞれブリッジ経由のコマンド往復に
  写像する。`VisibilityRunner`・分類・壁検出・チェックポイントのロジックは
  無変更で両サーフェスに乗る。
- `SiteSession`対応物は「バインド済みタブ」: `close()`はバインド解除
  （タブは閉じない — ユーザーのタブなので）。`exportStorageState`は未実装のまま
  （optionalメソッドなので契約違反にならない。§4）。
- セッション生成は`BrowserEngine.openSession`と並ぶ第2のファクトリ
  （例: `ChromeExtensionBridge.openTabSession`）とし、どちらを使うかは
  ワークフロー開始時のユーザー選択（既定は従来のPlaywright）。
- **壁ハンドオフは拡張経路のほうが自然**: ユーザーは既に自分のChromeにいるので、
  `handoff`イベント→本人がそのタブで解決→`resume`という既存の形
  （`docs/architecture.md` §6）がそのまま成立する。壁検出は`snapshot`ベースなので
  変更不要。ハンドオフ中もSoroeruは何も回避しない。

## 6. UX要件

1. **接続**: 設定画面の「Chromeと接続」→ (a) hostバイナリのコピーとmanifest登録、
   (b) 拡張のインストール案内（実験段階はdeveloper mode / unpacked、§8）、
   (c) ハンドシェイク往復の自動確認と接続状態表示。
2. **per-site許可**: 実行開始時にChromeの権限プロンプトでオリジン単位承認。
   承認済み一覧と取り消しを拡張オプションページとSoroeru設定の両方に表示。
3. **タブ選択**: 実行開始時に「このタブで実行」確認。実行中はバッジ+バナー表示。
4. **一時停止/再開**: 壁・オリジン逸脱・ユーザー操作で一時停止し、既存の
   handoff/resume UIに乗せる。停止は常に即時・無条件。
5. **切断/アンインストール**: 切断でmanifest・hostバイナリ・承認済みオリジンを
   掃除し、拡張の削除手順を案内する。掃除結果を表示する。

## 7. セキュリティ境界（不変条件の確認）

- **never-bypass不変**: 実Chrome利用は「ユーザー本人のブラウザ状態で正面から」で
  あり、CAPTCHA/MFA/bot検知/レート制限/アクセス制御の解決・迂回・隠蔽は実装しない。
  拡張はUA・fingerprint・自動化痕跡を偽装せず、実行中を可視化する（§1、
  `docs/security.md` §7の適用対象に拡張コードも含める）。
- **実プロファイルという影響範囲の拡大への緩和**: 1実行1タブ束縛、オリジン制限、
  即時停止、世界に触れる操作（送信・確定）は既存のreview-and-confirmゲート/
  三ガード/絶対境界の対象のまま（Slice Aでは送信系そのものが範囲外）。
- **レンダラー不信の維持**: 拡張・hostはレンダラーと直接通信しない。追加IPC
  チャネルも既存規約（マスク済みビューのみ）に従う。
- **hostなりすまし対策**: manifestの`allowed_origins`固定 + ソケットの
  0700ディレクトリ + 起動毎トークン。トークン・スキーマ・コマンドallowlistの
  三段で未知の相手・未知の要求を拒否する。

## 8. パッケージング・配布への影響

- **MVPのDMGには含めない。** `docs/architecture.md` §1・`docs/requirements.md` §9の
  「browser-extension distributionはpost-MVP」を維持し、`docs/development.md` §8の
  「beta docsが拡張配布を示唆しないこと」チェックもそのまま。
- 実験段階（開発者限定プロトタイプ）: 拡張はリポジトリ内`extension/`から
  developer modeでunpacked load。Chrome Web Store公開は採用決定後の配布Issue
  （ストア審査・拡張ID固定・自動更新の設計を含む）。
- 採用時は`docs/security.md` §12.1のMac betaチェックリストに追加する:
  DMGにhostバイナリを同梱してよいが、manifest登録はユーザー操作起点のみ;
  アンインストール掃除の確認; 拡張・hostがログ/バンドルに値を残さないこと。

## 9. 推奨する最初の実験と受け入れ基準

- **段階0（この増分）**: 本設計ドキュメントのみ。実装なし。
- **段階1（再検討トリガー成立後）**: フィーチャーフラグ配下・UI非公開の
  **開発者限定プロトタイプ**。受け入れ基準:
  1. 接続セットアップ（host登録→拡張ロード→ハンドシェイク）が手順書どおり再現できる;
  2. per-siteオリジン承認とタブバインドがUXどおり動く;
  3. `ExtensionPageDriver`の`snapshot()`がPlaywright経路と同一形状の
     `PageSnapshot`を返す（ローカルフィクスチャサイトで自動テスト比較）;
  4. 実サイト1件で、Playwright経路が失敗しExtension経路でVisibility収集が成功する
     事例を手動ベータで記録できる（fake dataの原則はローカルテストに適用。実サイト
     検証はユーザー本人のアカウントで手動実施）;
  5. 切断・アンインストールで登録物が残らない;
  6. `release:check`系ゲート（egress・bypass denylist）が拡張コードを含めて通る。
- 段階1の結果とベータ比較データをもって、ユーザー向け機能に昇格するか
  （＝architecture.md本文の改訂を伴うスコープ変更）を判断する。

## 10. フォローアップ実装Issue分割（トリガー成立後に起票）

1. **メッセージスキーマ共有モジュール + native hostスキャフォールド**:
   判別可能ユニオン+バージョン、hostリレー、登録/解除、ハンドシェイク。
   単体テスト: スキーマ検証、トークン不一致拒否、未知コマンド拒否。
2. **Electron `ChromeExtensionBridge`**: ソケットlisten、接続ライフサイクル、
   typed IPCイベント。統合テスト: fakeホストとのハンドシェイク往復（fake dataのみ）。
3. **Chrome拡張本体**: service worker + content script、PageSnapshot抽出、
   コマンド実行、バナー/バッジ。フィクスチャページでの抽出同形性テスト。
4. **`ExtensionPageDriver` + VisibilityRunner統合**: `PageDriver`適合、
   タブバインドセッション、壁ハンドオフ経路の結線。
5. **接続/タブ選択/停止のUIフロー**: 設定画面、実行開始時の確認、承認済み
   オリジン管理。
6. **パッケージング・登録UX・チェックリスト**: DMG同梱、アンインストール掃除、
   `docs/security.md` §12.1 / `docs/manual-test.md`への項目追加。

## 11. Issueのopen questionsへの回答

| 問い | 回答 |
| --- | --- |
| post-MVPオプションか、開発者限定ツールか、MVPスコープ変更か | 両建て: アーキテクチャ上はpost-MVPオプションとして記録し、最初の実装は開発者限定プロトタイプ（§9）。MVPスコープは変更しない。 |
| タブはユーザー明示選択のみか、専用タブグループ管理か | 明示選択のみ（承認済みオリジンでの新規タブ開設は確認付きで可）。タブグループ管理はスコープ外。 |
| 履歴/ブックマークを読むか | 読まない。権限自体を要求しない（§3.1）。 |
| DOMスナップショットの保存 | 処理後破棄。永続化は既存の暗号化Disclosure/Evidence（参照+ハッシュ）のみ（§4）。 |
| 未署名ビルドでのhost登録の最小UX | hostバイナリをapp-supportへコピーして登録し、App Translocation/`.app`移動の影響を絶つ（§3.3）。登録・解除・確認をアプリ内から実行。 |
