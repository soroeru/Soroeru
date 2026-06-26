# 検証結果: ローカルテストサイト10パターンでの新規登録・一括更新（Issue #33）

> **⚠️ SUPERSEDED（2026-06-25）。** 本書は **旧 Catashiro**（新規登録優先 MVP）の検証結果で
> あり、プロダクトは **Soroeru（揃える）** として再基礎づけされた（正典:
> [`requirements.md`](requirements.md)）。最初のスライスは **可視化（Visibility）** であり、
> 技術・アーキテクチャは後続の RFC でゼロベースに再選定される。本書は履歴参照用にのみ残す。

RFC-001 v3（[`rfc/rfc-001-chrome-autofill-pivot.md`](rfc/rfc-001-chrome-autofill-pivot.md)）§8 の
検証。実サイトを使わず、**ローカルのテストサイト10パターン**に対して
「URL → 登録ページ発見 → 項目マッピング → 確認ゲート → 入力 → 送信」と「差分一括更新」を
Chromium / Firefox / WebKit で検証し、**決定的版と AI 版のマッピング精度を比較**する。

- データはすべて**ダミー**（実在の個人情報・実カードなし）。
- すべて localhost で完結（外部送信は AI 版のユーザー契約プロバイダのみ）。
- CAPTCHA / MFA はテストサイトに置かない。検知スケルトンのみフィクスチャで検証（§10b）。

## 構成

```text
sites/                # テストサイト10パターン（defs.ts に正解マッピングを内包）＋ローカルサーバー
src/
├── store/            # 暗号化ストア最小実装（Argon2id + AES-256-GCM、PBKDF2-SHA-512 フォールバック）
├── agent/            # スキャナ / 決定的分類器 / ガード / 確認ゲート / 壁検知 / 充填 / オーケストレーション
│   └── ai/           # AI 版（プロバイダ抽象化＋AIマッパー。実値はモデルに渡さない）
├── app/              # CatashiroApp / AppRunner / startWebUiServer / AppUI（ローカルWebアプリ＋旧CLI）
└── types.ts          # 共有型
run/                  # 計測ランナーと CLI
```

層構成は RFC-001 v3 §7（ストア / エージェント / Playwright 自動操作 / UI）に対応する。
UI 層は `src/app/`（`CatashiroApp` / `AppRunner` / `startWebUiServer` / `AppUI`、§9・§11）が提供する。
`npm run poc -- ui` はローカルWebアプリを起動し、旧対話CLIは開発者向けに
`npm run poc -- ui:cli` として残す。

## 使い方

```bash
npm install
npx playwright install chromium firefox webkit

# テストサイトをブラウザで眺める
npm run poc:serve            # http://127.0.0.1:4333/

# 計測（決定的版を3エンジンで実行。OPENAI_API_KEY/ANTHROPIC_API_KEY があれば AI 版も実行）
npm run poc:matrix -- both

# 全サイトを headed + 確認ゲート自動承認で連続自動登録する様子を見る（既定: AI版）
npm run poc -- demo                  # demo [deterministic|ai] [engine]
npm run poc -- demo deterministic    # API 不要・無料で動きだけ見る

# 1サイトを headed + 対話ゲートでデモ実行（ゲートを手動で y/N 承認）
npm run poc -- register 09-trial-card [deterministic|ai]

# アプリシェルのlifecycle確認（unlock -> ブラウザ起動/終了 -> lock）
npm run poc -- app

# ローカルWebアプリUI（ブラウザで個人情報・サイト一覧・設定を管理）
npm run poc -- ui [deterministic|ai] [port]

# 旧ターミナルUI（新規登録・一括更新の開発者向けfallback）
npm run poc -- ui:cli [deterministic|ai]

# PRIV-001: network egressがtarget sites / AIプロバイダ以外に増えていないかの静的チェック
npm run poc -- check-egress

# PRIV-002: ローカルへの書き込みが暗号化ストア/暗号化エクスポート/マスク済み計測結果以外に
# 増えていないかの静的チェック
npm run poc -- check-persistence
```

- マスターパスフレーズは `AF_POC_PASSPHRASE`（未指定時は PoC 用の固定値）。ストアは
  `state/catashiro-poc/` に暗号化保存される（`state/` はコミット対象外）。
- AI 版はユーザー契約のAPIキーを使う。既定はOpenAI（`OPENAI_API_KEY`、モデルは
  `AF_POC_OPENAI_MODEL` で変更可・既定 `gpt-5.4`）。`OPENAI_API_KEY` が未設定で
  `ANTHROPIC_API_KEY` がある場合はAnthropicにフォールバックする（モデルは
  `AF_POC_AI_MODEL` で変更可・既定 `claude-opus-4-8`）。
- API キーは環境変数で渡すか、リポジトリ直下の `.env` に `OPENAI_API_KEY=...`（または
  `ANTHROPIC_API_KEY=...`）と書く（`npm run poc*` は `.env` があれば自動で読み込む。
  `.env` は gitignore 済み・コミットしない）。キーはローカルでのみ使用し、ログ・計測結果・
  ストアには出力しない。
- `npm run poc:matrix` は各結果行の末尾に `overall: OK|NG` を出力する。新規登録・3ガード・
  一括更新（mandate含む）・トライアルカード解約・wall検知/復帰のいずれかが失敗すると `NG`
  となり、コマンドは非ゼロ終了する（`hasFailures`, TEST-001 / #45）。CI
  （`.github/workflows/ci.yml`）はこれを `e2e-deterministic` ジョブ
  （`npm run poc:matrix -- deterministic chromium`）のゲートとして使う。詳細は
  `docs/testing.md` §7・§8。

## テストサイト10パターン

| # | siteId | フォーマット差・特性 |
| --- | --- | --- |
| 1 | `01-basic` | 標準: `<label for>`・標準 `name`/`autocomplete`・単一住所 |
| 2 | `02-split` | 姓名/カナ分割・郵便3-4分割・住所構造化（都道府県 select）・電話3分割・メール確認欄 |
| 3 | `03-cryptic` | レガシー table レイアウト・`name` が `f01..`・label/id/placeholder なし（近傍 `<th>` のみ） |
| 4 | `04-shuffled` | 項目順シャッフル・placeholder のみ・無意味な `name` |
| 5 | `05-choices` | select/radio/checkbox 多用・生年月日 select・**未保存項目「ご職業」**（不足データ催促→カスタム項目追加） |
| 6 | `06-wizard` | 多段ステップ（STEP1→STEP2→確認→送信） |
| 7 | `07-dynamic` | SPA 風動的描画（約400ms後に描画・fetch 送信） |
| 8 | `08-terms` | 規約同意＋高リスク条項（**自動更新・第三者提供**）＋資格表明「18歳以上」（ガード1・3） |
| 9 | `09-trial-card` | **無料トライアル→サブスク課金**・カード項目あり（ガード2の例外） |
| 10 | `10-no-auto` | 規約で**自動アカウント作成を禁止** → assisted fill（Q2c） |

正解マッピング（ground truth）は `sites/defs.ts` の各フィールド定義に内包し、計測ランナーが
エージェントのマッピング計画とサーバー側が受信した値の両方を突き合わせる。

## 検証結果（2026-06-13, macOS / Node 25 / Playwright 1.60）

### 新規登録（10サイト）＋差分一括更新

決定的版（#9 scanner の方式を拡張＋ルールベース分類）と AI 版（claude-opus-4-8）:

| variant | engine | 新規登録成功率 | 誤マッピング率 | 差分更新 | ゲート/3ガード | 壁検知フィクスチャ |
| --- | --- | --- | --- | --- | --- | --- |
| deterministic | chromium | **10/10 (100%)** | **0.0%**（87項目中0） | 8更新/2スキップ 全OK | 全発火 | OK |
| deterministic | firefox | 10/10 (100%) | 0.0% | 全OK | 全発火 | OK |
| deterministic | webkit | 10/10 (100%) | 0.0% | 全OK | 全発火 | OK |
| ai (claude-opus-4-8) | chromium | **10/10 (100%)** | **0.0%**（87項目中0） | 8更新/2スキップ 全OK | 全発火 | OK |

- 誤マッピング率 = （誤キー割当＋余計な割当）/ 正解マッピング総数（87項目）。
  未保存項目「ご職業」は両版とも誤割当せず、不足データとして催促→カスタム項目化することを確認。
- **Q8 の一次結論**: このローカル10パターンでは**決定的版と AI 版に差は出なかった**（両版とも満点）。
  フォーマットの難度がこの10パターンでは両アプローチの差を出すほど高くなかった、とも読める。
  差を見極めるには、より曖昧・変則的なフォーマット（実フォーム由来）の追加が要る（Q2a の続き）。
- AI 版はマッピング精度の測定が目的なので chromium のみで実行（エンジン横断は決定的版が担当）。
  測定値は `state/catashiro-poc/matrix-*.json` にも出力される。

### フェーズ別タイミング計測（PERF-001 / #18）

`src/agent/perf.ts` が定義する8フェーズ（discover / scan / map / terms / gate /
fill / submit / record）ごとに、`runRegistration` / `runUpdate` の所要時間（ms）を
`AgentDeps.onPhase` で報告する。`npm run poc:matrix` はこれを各サイトごとに集計し、
結果表とフェーズ名＋ms数のみを `state/catashiro-poc/matrix-*.json` に出力する
（実値・ページ内容・AIリクエスト本文・APIキーは一切含まない。詳細は `docs/testing.md` §9）。

代表3サイト（通常フォーム / ウィザード / 動的フォーム）の baseline
（deterministic / chromium, macOS / Node 25 / Playwright 1.60）:

| siteId | discover | scan | map | terms | gate | fill | submit | record | 合計 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `01-basic`（通常フォーム・新規登録） | 307 | 26 | 7 | 1 | 4 | 764 | 200 | 36 | 1345 |
| `06-wizard`（多段ウィザード・新規登録） | 79 | 5127 | 0 | 0 | 2 | 242 | 200 | 29 | 5679 |
| `07-dynamic`（動的描画・新規登録） | 129 | 421 | 0 | 0 | 1 | 140 | 53 | 12 | 756 |
| `01-basic`（差分一括更新） | 92 | 256 | 1 | 0 | 0 | 203 | 282 | 15 | 848 |
| `06-wizard`（差分一括更新） | 139 | 17 | 0 | 0 | 0 | 86 | 113 | 9 | 365 |
| `07-dynamic`（差分一括更新） | 76 | 13 | 0 | 0 | 0 | 65 | 378 | 26 | 559 |

- `06-wizard` の新規登録は `scan` フェーズ（ステップ1→2→確認の遷移待ち）が約5.1秒で
  既定の `AF_POC_SLOW_PHASE_MS`（5000ms）を超え、
  「処理に時間がかかっています（フォームのスキャン: 5.1秒）。このまま自動で続行します…」が
  ユーザー向けに表示されることを確認した（`slowPhaseNote`）。
- `fill` フェーズは新規登録で最も時間を占める（フォーム入力＋確認画面への遷移を含む）。
- 全10サイトの値は `npm run poc:matrix` 実行時の `phase timings (ms)` 表と
  `state/catashiro-poc/matrix-*.json` の `phaseTimingsMs` で確認できる。AI 版
  （`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` 設定時）では `map` / `terms` フェーズに
  プロバイダ呼び出しの時間が加わる。

### 確認ゲート・3ガードの発火（シナリオ別）

| 検証点 | 結果 |
| --- | --- |
| 確認ゲート（解析後・送信前に1回、送信項目＋規約リンク＋高リスク要約を提示） | 全サイトで表示。承認後のみ送信 |
| ガード1: `08-terms` の自動更新・第三者提供条項の検出と提示 | OK（該当箇所の引用つき） |
| ガード2: `09-trial-card` を trial-subscription と判定→承認後のみカード自動入力 | OK |
| ガード2 否認パス: 将来課金を**承認しない**場合カード入力せず中止・未送信 | OK |
| ガード3: 「私は18歳以上です」を自動チェックせず、ユーザーの個別判断で反映 | OK |
| Q2c: `10-no-auto` は入力のみ・自動送信せず最終ボタンをユーザーに委譲 | OK（人間サロゲートが押下して完遂） |
| 壁検知スケルトン: reCAPTCHA / OTP / メール認証フィクスチャの検知（解かない） | OK（3種とも検知） |

### 暗号化ストア

- Argon2id（64MiB, t=3）→ AES-256-GCM、レコード毎ランダム IV。PBKDF2-HMAC-SHA-512（60万回）
  フォールバックあり。誤パスフレーズ・改ざんは GCM 認証で失敗することをユニットテストで確認。
- ディスク上に平文が現れないこと、CVV を含む全値が暗号化されることを確認（テスト `tests/unit/catashiro-poc-crypto.test.ts`）。

### Recovery key / encrypted export・import（SEC-003 / #44）

`src/store/recovery.ts` と `store.ts` の `PocStore` に以下の zero-knowledge な復旧手段を実装した
（詳細は `docs/security.md` §4）。`npm run poc -- ui` のWeb UI設定画面、または
`npm run poc -- ui:cli` の「5. 設定」から生成・検証・削除できる（#17 / #66）。

- `store.setupRecoveryKey()`: 256bit の recovery key を生成し、現在の master key をその key で
  wrap して `recovery` フィールドとして保存準備する。**戻り値の recovery key は一度しか
  表示されない**。画面・ログ・スクリーンショット・AI への送信に絶対に含めないこと
  （ユーザー向け警告として、表示時に「安全な場所に書き留めたら閉じる」旨を案内する）。
- `PocStore.openWithRecoveryKey(filePath, recoveryKey)` /
  `CatashiroApp.unlockWithRecoveryKey(recoveryKey)`: passphrase の代わりに recovery key で
  解錠する。誤った recovery key は GCM 認証エラーでフェイルクローズする。
- `store.rekey(newPassphrase)`: passphrase を変更する。**既存の recovery key は無効化**
  される（古い master key を wrap しているため）。変更後に recovery key を再発行する
  必要がある。
- `store.exportEncrypted()` / `PocStore.importEncrypted(filePath, json, passphrase, { overwrite? })`:
  ディスク上と同じ暗号化 JSON（`version` / `kdf` / `records` / `recovery`）をそのまま
  バックアップ・復元する。**平文 export は提供しない**。import はバージョン不一致を
  fail-closed で拒否し、既存ファイルは `overwrite: true` を渡さない限り上書きしない。
- ユニットテスト `tests/unit/catashiro-poc-recovery.test.ts`: roundtrip・誤 recovery key・
  `verifyRecoveryKey`・`rekey` による無効化・export/import roundtrip（平文非混入を確認）・
  上書き拒否・バージョン不一致拒否をカバー。

### ローカルアプリUI（UI-001 / #17, UI-002 / #66）

`npm run poc -- ui [deterministic|ai] [port]` で `src/app/web-ui.ts` のローカルWebアプリが起動する
（詳細は `docs/extension.md` §13、設計計画は `docs/issue-66-local-web-app-ui.md`）。
既定では `127.0.0.1` にだけbindし、POSTはCSRF tokenを必須にする。フロントエンド依存は追加せず、
Node標準HTTPサーバーのserver-rendered HTML/CSSで初期UIを構成する。

現在のWeb UI foundation:

1. **オンボーディング / unlock**: マスターパスフレーズ、またはリカバリーキーで暗号化ストアを開く。
2. **個人情報**: 右上の「編集」から、既知フィールド（`KNOWN_PROFILE_KEYS`）とカスタム項目を
   1つの登録情報編集フォームでまとめて編集する。保存ボタンは画面下部。一覧表示は常に
   `maskValue` でマスクし、機密項目の表示にはマスターパスフレーズ再入力が必要。
3. **登録済みサイト**: サイトごとの `filledFields` / mandate数 / statusと、
   `staleFilledFields()` による一括更新候補をブラウザで確認できる。ページ上部に
   「新規登録」、差分のあるサイトがある場合のみその下に「一括更新」を表示する。
4. **設定**: AIプロバイダ（provider/model/APIキー、暗号化保存）、APIキー表示（要再認証）、
   recovery key の生成・検証・削除。

新規登録のWeb実行、review-and-confirm gate、missing-data prompt、wall hand-off / resume、
一括更新実行は次の #66 実装スライスで `AppRunner` に接続する。そこまでの開発者向けfallbackとして、
旧ターミナルメニューは `npm run poc -- ui:cli [deterministic|ai]` で利用できる。

- ユニットテスト `tests/unit/catashiro-poc-web-ui.test.ts`: ローカルWeb UIのroute、CSRF、マスク表示、
  再認証、settings、recovery key、一括更新候補表示をlocalhost上で検証。
- ユニットテスト `tests/unit/catashiro-poc-ui.test.ts`: 旧CLIメニューを注入可能な `UiIo`
  フェイクで駆動（実ブラウザは起動しない）。

### ネットワークegress（PRIV-001 / #20）

許可される外部送信先は (a) ユーザーが指定した **target sites**（通常の Playwright
ナビゲーション・フォーム送信。規約リンクの取得 `fetchVisibleText` を含む）と
(b) ユーザーが設定した **AI プロバイダ**（フォーム構造・規約テキストのみ）に限る
（詳細は `docs/security.md` §6）。

- `npm run poc -- check-egress`（`src/dev/egress-check.ts`）が
  `src/`・`run/` 配下のネットワーク呼び出し箇所を静的に検査する。各箇所には
  `// egress: target-site` または `// egress: ai-provider` の注釈が必須で、
  未注釈の新しい通信先や `package.json` への telemetry/analytics 系依存追加は
  このチェックで失敗する。`sites/`（ローカル 127.0.0.1 のテストサイトサーバー）は
  対象外（外部送信ではない）。
- AI プロバイダ（`src/agent/ai/provider.ts`）はステートレス呼び出しのみ
  （`store` / `previous_response_id` / `metadata` / プロンプトキャッシュ不使用）。
  ユニットテスト `tests/unit/catashiro-poc-provider.test.ts` で OpenAI 経路のリクエスト
  本文を検証し、`tests/unit/catashiro-poc-contracts.test.ts` で `mapFields` に渡る
  ペイロードがフォーム構造のみ（実値を含まない）であることを検証する。
- ユニットテスト `tests/unit/catashiro-poc-egress.test.ts`: 上記チェックが現状の
  リポジトリで違反なしであること、未注釈の通信・許可外の注釈・telemetry系依存・
  `sites/` 配下が対象外であることをそれぞれ確認する。

### 個人データのマスキングとローカル永続化（PRIV-002 / #21）

`src/agent/gate.ts` に2つのマスク方針を定義し、表示・ログ・ファイル出力のすべてで
これを使う（詳細は `docs/security.md` §3）。

- `maskValue(key, value)`: 確認ゲート（`renderGate`）とローカルUIの一覧表示用。
  カード番号は末尾4桁、CVV/カード有効期限/名義/パスワードは `••••••`、メール/電話番号は
  `du***@example.com` / `090-****-5678` の部分マスク。氏名・住所・会社名・ログインIDは
  ゲートでの確認に必要なため全表示する。
- `maskForArtifact(key, value)`: `npm run poc:matrix` が書き出す
  `state/catashiro-poc/matrix-*.json` の不一致ノート用。カード/CVV/パスワード等は同じ
  強マスク、それ以外は値そのものを書かず文字数（例: `(17文字)`）または `(空)` のみ書く。
- `npm run poc -- check-persistence`（`src/dev/privacy-check.ts`）が `src/`・`run/`
  配下のローカル書き込み箇所を静的に検査する。各箇所には `// persist: encrypted-store`
  （暗号化ストア本体）・`// persist: encrypted-export`（暗号化エクスポート/インポート）・
  `// persist: measurement-output`（上記のマスク済み計測結果）のいずれかの注釈が必須で、
  未注釈の新しいローカル書き込みはこのチェックで失敗する。`sites/` は対象外。
- ユニットテスト: `tests/unit/catashiro-poc-gate.test.ts`（`maskValue` / `maskForArtifact`
  のマスク内容）、`tests/unit/catashiro-poc-privacy.test.ts`（上記チェックが現状の
  リポジトリで違反なしであること、未注釈の書き込み・許可外の注釈・`sites/` 配下が対象外
  であることをそれぞれ確認）。
- `state/ai-reviews/`（ローカル AI レビューhook）はソースコードの `git diff` のみを
  扱い、暗号化ストア（`state/catashiro-poc/`）には触れない。両方とも Git 管理対象外。

## 所見・既知の制限

- **決定的版・AI 版とも10パターン全てで成立**した。決定的版のラベル語彙ルールは
  `03-cryptic` / `04-shuffled` のような name/label 欠落フォーマットも近傍テキスト＋placeholder で
  吸収できたが、これはルールをこの10パターンに合わせて整備した結果でもある（語彙の汎化性は
  実フォーム由来のパターン追加で要再評価 = Q2a の続き）。
- **§8 Q8 の比較**: 両版とも満点で差がつかなかった（上の検証結果を参照）。差を出すには
  この10パターンより曖昧・変則的なフォーマットが要る。決定的版は API 不要・無料・高速、AI 版は
  ルール整備なしで未知フォーマットに追従しうる利点があり、難フォーマット追加後に再評価する。
- ウィザード型は構造上、ステップを進めるために確認ゲート前に値のタイプが必要
  （値は制御ブラウザ内に留まり、**最終送信は常にゲート承認後**）。
- 壁ハンドオフは骨組みのみ（`HumanHandoff` フック＋検知）。headed セッションでの
  pause-resume 実運用検証は実サイト段階の課題。
- 日本語のみ（Q7）。多言語は後続。

## 保守メモ: 決定的版 / AI 版の並行実装（2026-06-13 精査）

両バージョンを長期保守する方針（ユーザーがAIモデルを選ぶ自由＝使わない自由も含む）に対する
保守性の精査結果。**並行実装は保守性上成立する**が、放置すると静かにズレうる箇所があるため、
**Issue #37** で型連動・共有正規化・AIオフラインテスト・失敗時ポリシーを追加した。

**なぜ基本的に健全か**:
- 両版の違いは `Mapper` インターフェース（`mapper.ts`）の3メソッド（登録ページ発見・項目マッピング・
  規約分析）に閉じ込められ、戻り値型（`MappingPlan` / `TermsAnalysis`）は共通。
- `agent.ts` は**バージョンで分岐しない**（変種に触れるのは `deps.mapper.*` の3か所のみ）。
  確認ゲート・3ガードの強制・入力・送信・mandate 記録・壁検知は **`agent.ts` に一本化**され、
  両版が同じ共有路を通る。→ 安全に直結する処理は1コピーしかなく、「片方だけに効く予期せぬ変更」が
  構造的に起きにくい。変種が生むのは「理解」だけで、副作用処理は共有。
- `DeterministicMapper` はプロバイダ/APIキー非依存・オフライン・既定。「AIを使わない自由」は
  すでに第一級でサポート済み。

**Issue #37 後の保守モデル**:
1. `types.ts` の列挙（profile keys / transforms / high-risk flags）が AI スキーマとプロンプト語彙の単一出所。
   新メンバー追加時は `satisfies Record<...>` により説明未追加が型エラーになる。
2. `normalizeMappingPlan()` / `normalizeTermsAnalysis()` が Mapper 出力の共有後処理を担い、
   `agent.ts` でも必ず通す。不正キー・不正 transform・存在しない fieldId は副作用前に落とす。
3. AI 経路はスタブ `AiProvider` のオフライン単体テストで、スキーマ形状・レスポンス組み立て・不正キー除去・
   trial→高リスク昇格・失敗伝播を `npm test` で検証する。
4. AI 失敗時（refusal / 解析失敗 / ネットワーク）は、既定では明確なエラーで停止する。
   決定的版への自動フォールバックを入れる場合は、ユーザーに切替を明示する別オプションとして扱う。

**結論**: 並行実装は進めてよい。保守モデルは「両方直すのを覚えておく」ではなく
「型と単一経路が強制する」に移行済み。

## セキュリティ方針（このPoCで守っていること）

- 個人情報（ダミー）は暗号化ストア・暗号化エクスポート以外に書かない（PRIV-002 / #21、
  `npm run poc -- check-persistence` で静的検査）。計測結果には値そのものを書かず、
  確認ゲート/UI一覧はカード・CVV・パスワードを強マスク、メール/電話番号を部分マスクする
  （`maskValue` / `maskForArtifact` に統一）。
- AI 版はフォーム構造と規約テキストのみ送信し、実値はローカルの Playwright 層で充填（§6）。
  ステートレス補完のみ（プロンプトキャッシュ・保存スレッド不使用）。
- CAPTCHA / MFA / bot 検知の回避は実装しない（検知して停止のみ）。
- ネットワーク送信先は target sites と設定済み AI プロバイダのみ（PRIV-001 / #20、
  `npm run poc -- check-egress` で静的検査）。telemetry / cloud sync は実装しない。
