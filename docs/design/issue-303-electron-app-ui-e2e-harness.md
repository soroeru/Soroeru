# Electron アプリ UI の Playwright E2E ハーネス 設計

Issue: #303

## 背景・目的

Soroeru の Electron アプリ自体の UI（ボールト作成/解錠 → CSV 取り込み → サイト管理
→ Visibility 収集 → 開示台帳反映）は、現状 [`manual-test.md`](../manual-test.md) の
手動チェックリストでしか検証できない。本 Issue では、実際にアプリをビルド・起動し、
UI を Playwright で操作して Visibility のハッピーパスを自動検証できるハーネスを追加する。

対象は **スライス A（Visibility）の最も基本的な一連の流れ**。ウォールハンドオフや
複数サイトの一括収集など高度な分岐は範囲外（後続 Issue で拡張）。

## 決定事項

- **自動化手段**: 新規依存を追加せず、既存の `playwright` パッケージが持つ Electron
  サポート `_electron.launch()` を使う（`node -e "require('playwright')._electron"` で
  インストール済みバージョン（`^1.61.1`）に存在することを確認済み）。
- **起動対象**: パッケージ済み `.app`/DMG ではなく、**開発ビルドを直接起動**する。
  `electron/main.ts` は `VITE_DEV_SERVER_URL` が未設定なら `dist/renderer/index.html` を
  直接 `loadFile` するため、`npm run build:app` の出力さえあれば Vite dev server も
  `concurrently` も不要。`_electron.launch({ args: [mainJsPath] })` で
  `dist/compiled/electron/main.js` を直接起動する。
- **状態分離**: `SOROERU_STATE_ROOT` を毎回フレッシュな
  `state/soroeru-poc/e2e-app-ui/<timestamp>/` に向けて起動する（`electron/main.ts`
  の `resolveVaultPath()` が既にこの環境変数を優先する）。実ユーザーボールト
  （`~/Library/Application Support/Soroeru`）には一切触れない。
- **テストランナー**: 新しいテストフレームワーク（`@playwright/test` 等）は導入せず、
  既存の `node:test` 上で Playwright をライブラリとして呼ぶ
  （`tests/e2e/real-visibility.e2e.ts` と同じパターン）。
- **対象サイト**: `sites/server.ts` の `startPocServer(0)` を同一プロセス内で起動し、
  ウォールのない `01-basic` サイトのみを対象にする。実サイトには一切触れない。
- **収集の観測方法**: Visibility 収集中に Soroeru 自身が開く自動化用の headed ブラウザ
  （`BrowserEngine`）は **テストコードから直接操作しない**。Electron レンダラーは
  `visibility:onEvent` IPC を購読して UI 状態を更新するので、テストはレンダラー側の
  UI テキスト（例:「収集済み（開示 N）」）の出現を Playwright の自動待機で確認するだけに
  留める。二重のブラウザ制御を避け、実装・保守コストを下げるための決定。
- **ロケータ方針**: 新規 `data-testid` は追加しない。既存の日本語ラベル/ボタン文言
  （「作成して解錠」「サイト管理」「ファイルを選択」「選択したサイトを収集」等）に対する
  role/text ベースの Playwright ロケータを使う。UI 文言が変わればテストも追従する必要が
  あるが、実ユーザーが読む基準と一致させることを優先する。
- **CI 方針**: 当面 **ローカル専用**。`npm run poc:matrix -- both` と同じ位置づけで、
  `.github/workflows/ci.yml` には追加しない。理由は Ubuntu CI ランナーでネイティブ
  Electron GUI を安定させるコスト（Xvfb 等）を今は払わないため。`docs/testing.md` に
  「ローカル専用、手動/リリース前チェック」として明記する。
- **Visibility 収集後の永続化バグを本 Issue で修正する**（ローカル AI レビューで検出、
  Product Owner 確認済み）: `electron/session.ts` の `runVisibility()` は
  `VisibilityService.runSite()` を呼ぶのみで、他の変更系メソッド（`importCsv`
  `importSavedPage` `deleteSiteAccount` `confirmDynamicAttributeCandidate`
  `setSessionPersistence` 等）と異なり `await this.vault.save()` を一切呼んでいない。
  `VaultV2` は変更をメモリ上の `Map` にしか保持しないため（`save()` が呼ばれて初めて
  暗号化 JSON としてディスクに書かれる、`src/store/vault-v2.ts`）、収集結果は
  ユーザーが施錠・終了した時点で失われうる — Visibility スライスの中核である
  「開示台帳を構築する」という約束を破る実害のあるバグ。修正は
  `runVisibility()` の成功・失敗を問わず（収集失敗時も Constraint 記録という
  ドメイン変更を伴うため）、既存の他メソッドと同型で `await this.vault.save()`
  を追加するだけの小さな変更（`electron/session.ts`）。これにより E2E の
  「収集後 vault.json に開示が永続化されている」というアサーションが初めて
  実際に成立する。

## この増分の範囲

- `electron/session.ts`: `runVisibility()` で `VisibilityService.runSite()` の
  結果を得たあと（成功・失敗・例外いずれの場合も、`finally` で）
  `await this.vault.save()` を追加する（上記「決定事項」参照）。
- `tests/unit/soroeru-visibility-persistence.test.ts`（新規）: 上記修正の
  **CI で実行される回帰テスト**。フェイク `PageDriver` で収集を 1 回実行した後、
  同じパスフレーズで `VaultV2.open()` を別インスタンスとしてやり直し、開示が
  ディスクに永続化されていることを検証する（ローカル専用 E2E だけに回帰防止を
  委ねない）。
- `tests/e2e/app-ui.e2e.ts`（新規）:
  1. `startPocServer(0)` でローカルフェイクサイトを起動し、`01-basic` の実際のポート
     付き URL を取得する。
  2. フェイクの `name,url,username,password,note` 1 行 CSV を一時ファイルとして
     `state/soroeru-poc/e2e-app-ui/<timestamp>/import.csv` に書き出す（フェイク値のみ）。
  3. `SOROERU_STATE_ROOT` を同じ `<timestamp>` ディレクトリに向けて
     `_electron.launch()` でアプリを起動し、`electronApp.firstWindow()` で
     レンダラーの `Page` を取得する。
  4. ボールト作成フォームにフェイクパスフレーズを入力し「作成して解錠」。
  5. 「ファイルを選択」→ `setInputFiles()` で CSV を選択し、取り込みサマリー
     （「取り込んだ認証情報」等の `<dd>`）が表示されるのを待つ。
  6. 対象サイト行のチェックボックスを ON にし、「選択したサイトを収集」をクリック。
  7. サイト行に「収集済み（開示 N）」（N ≥ 1）が表示されるまで Playwright の
     自動待機で待つ。
  8. `finally` で `electronApp.close()` と `pocServer.close()` を必ず呼ぶ
     （`real-visibility.e2e.ts` の `finally { await engine.closeAll(); }` と同型）。
  9. アサーション: 取り込みサマリーの件数、収集後の開示件数 ≥ 1（UI 上）に加えて、
     `electronApp.close()` 後に `state/soroeru-poc/e2e-app-ui/<timestamp>/vault.json`
     を同じフェイクパスフレーズで `VaultV2.open()` し直し、対象サイトの開示レコードが
     実際にディスクへ永続化されていること（上記の永続化バグ修正の回帰防止）。
     `vault.json` の生バイト列にフェイクのパスワード/メールアドレス文字列が
     含まれないこと（平文残存なし）も合わせて確認する。
- `package.json`: `"e2e:app-ui": "npm run build:app && node --test dist/compiled/tests/e2e/app-ui.e2e.js"`
- `docs/testing.md`: 新しいローカル専用 E2E フローとして 1 セクション追記
  （§7 CI 表・§5 コマンド一覧・ローカル専用の理由）。

## 非範囲

- パッケージ済み `.app`/DMG の自動化（開発ビルドのみ）。
- CAPTCHA/MFA ウォールハンドオフの自動化検証（`01-basic` はウォールなし）。
- CI ワークフローへの組み込み。
- 複数サイトの一括収集、保存ページ取り込み、削除フロー等の UI 自動化（将来の別 Issue）。
- `tests/e2e/real-visibility.e2e.ts`（実サイト向けハーネス）への変更。

## 失敗時の扱い・後始末

- ウィンドウ起動・IPC 応答待ちは固定 `setTimeout`/`sleep` を使わず、Playwright の
  ロケータ待機（`waitFor` / auto-waiting アサーション）のみを使う
  （`writing-good-tests` スキル準拠）。
- テストが途中失敗しても `electronApp.close()` と `pocServer.close()` は
  `finally` で必ず実行し、Electron プロセスや HTTP サーバーを残さない。
- 状態ディレクトリ（`state/soroeru-poc/e2e-app-ui/<timestamp>/`）は削除せず残す
  （デバッグ用、`state/` は既に Git 管理外）。

## 検討した代替案

- **`@playwright/test` ランナーへの切り替え**: Electron 対応が公式に厚いが、
  リポジトリ全体のテストランナーを二本立てにすることになり、
  「新しいテストランナーを RFC なしに追加しない」方針に反するため不採用。
- **パッケージ済み `.app` を毎回ビルドして起動**: 実配布物によりネイティブ挙動を
  検証できるが、`npm run package:dmg` は `electron-forge make` を含み実行時間が長い。
  日常の E2E には開発ビルド起動を採用し、`.app` 検証は
  [`manual-test.md`](../manual-test.md) §0 のリリース前チェックに委ねる。
- **収集中の自動化ブラウザも Playwright で直接操作**: Soroeru 自身が既に
  `BrowserEngine`/`disclosure-collector` で検証済みのログイン・収集ロジックを
  テストコード側で再現することになり、二重実装・二重のタイミング制御が必要になるため
  不採用。レンダラー UI の反映だけを見れば十分な検証になる。

## テスト戦略

- 本 Issue 自体がテストインフラの追加であるため、E2E 側は `app-ui.e2e.ts` 自身が
  成果物であり対象。既存の `soroeru-poc-web-ui` 等ユニットテストとは層が異なる
  （Electron レンダラー + 実 IPC + 実ボールトを使う唯一のテスト）。
- 永続化バグ修正の回帰防止は、ローカル専用の E2E だけに委ねず、CI で実行される
  `tests/unit/soroeru-visibility-persistence.test.ts` が担う（E2E のディスク
  アサーションはその実機経路での再確認という位置づけ）。
- `npm run e2e:app-ui` の合否がこの機能の受け入れ基準（Issue #303 の Verification）。
- 将来、CI 組み込みを検討する場合は本ドキュメントの「CI 方針」を再検討ポイントとして
  更新する。
