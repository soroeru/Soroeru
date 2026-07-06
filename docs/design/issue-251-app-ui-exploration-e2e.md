# Visibility探索フローの実UI E2Eハーネス 設計

Issue: #251

## 背景・目的

Issue #251は当初、Visibility探索（複数ページ収集）フローに対する新規Playwright E2E
シナリオを、`run/measure.ts`の登録/一括更新10サイトマトリクスと同様の形で追加する計画
だった。しかしIssue策定後に前提が変わっている：

- Phase 6（#249, closed）で、`VisibilityRunner.runSite()`
  （`src/automation/visibility-runner.ts:118-121`、`collectFromExploration`
  同ファイル312-395行）が実ブラウザ相手にすでに複数ページ探索＋壁ハンドオフ→resumeを
  実装済み。
- Phase 6/7で追加された`tests/unit/soroeru-exploration-collection.test.ts` /
  `soroeru-page-explorer.test.ts`が、複数ページ収集・壁ハンドオフ→resume・複数ページに
  またがる動的属性候補を`FakePageDriver`によるユニット/インテグレーションレベルで
  すでに検証済み。ただし実ブラウザ・実Electron UIは通っていない。
- Issue #303（closed）が、Visibilityの「実UIを通した genuinely end-to-end」検証手段を
  `tests/e2e/app-ui.e2e.ts`として確立した：`playwright`の`_electron.launch()`で
  Electron開発ビルドを直接起動し、レンダラーUIをrole/textロケータで操作する
  ローカル専用ハーネス。対象は`01-basic`の単一ページ収集のみ。

`docs/testing.md` §10は「同じ振る舞いが下位層と上位層の両方でカバーされる場合は
下位層を優先し、E2Eは本当にエンドツーエンドな振る舞いにのみ残す」「`run/measure.ts`
自体の再設計は本ドキュメントのスコープ外」と明記している。したがって本Issueの残る
価値は、探索・壁ハンドオフ→resumeを**実Electronアプリの UI と実ブラウザを通して**
検証することに絞られる。`run/measure.ts`型のマトリクス追加はやり直さない。

**ガバナンス**: `docs/github-operations.md` §3は「PRが計画を大きく変える場合はIssueを
更新するか、PR説明で変更点を説明する」ことを求めている。本設計は#251の当初計画（登録
マトリクス方式）からの実質的な方向転換であるため、実装着手前にGitHub Issue #251本文
自体を本ドキュメントと同じ内容（Goal/Scope/Non-Scope/Approachを`/explore-flow/*` +
`app-ui-exploration.e2e.ts`方式に更新）で書き換え済み（`gh issue edit 251`）。PR説明
にも、この方向転換の理由と更新済みIssue本文への言及を含める。

## 決定事項

- **ハーネスは#303のパターンをそのまま再利用する**：`_electron.launch()`で開発ビルド
  （`dist/compiled/electron/main.js`）を起動し、`SOROERU_STATE_ROOT`で状態を分離し、
  role/textロケータでレンダラーUIを操作する。新規`data-testid`は追加しない。Soroeru
  自身が収集用に開く別の自動化ブラウザ（`BrowserEngine`）は#303と同様にテストコードから
  直接操作しない — レンダラーの`visibility:onEvent` IPC購読によるUI状態のみを観測する。
- **新規テストサイトは`01-basic`を拡張せず、`SITES`配列にも追加しない**。理由は2点：
  1. `01-basic`の既存`/account`ページは`editSpecs(site)`の全フィールドを1ページで
     表示する行き止まりページで（`sites/server.ts:214-239`）、複数ページに情報を
     分散させる探索テストには向かない。ここに新しいリンク/サブページを足すと、
     `tests/unit/soroeru-poc-add-site.test.ts` / `soroeru-poc-importer.test.ts`が
     `01-basic`の`/account`に対して持つ既存の前提を壊すリスクがある。
  2. `run/measure.ts`は`sites/defs.ts`の`SITES`配列を直接イテレートし
     （`for (const site of SITES)`、run/measure.ts:327/384/438）、これはCIジョブ
     `e2e-deterministic`（`npm run poc:matrix -- deterministic chromium`）で実行
     される。`SITES`に新しいエントリを足すと、探索専用のフィクスチャが意図せず
     登録/一括更新のCIゲートマトリクスに巻き込まれる — Issue #251のNon-Scopeが
     明示的に除外している`run/measure.ts`統合そのものになってしまう。
  - 解決策：`sites/server.ts`の`handle()`にはすでに同じ状況に対する前例がある。
    `/wall-fixture/*` `/wall-flow/*` `/login-wall/*` `/saved-page-guide/*`は
    いずれも`/site/:id/...` → `SITES`検索より**手前で処理されるトップレベルの
    フィクスチャルート**であり、コード上のコメントも「10パターンの一部ではない、
    壁検出の骨格を検証するためだけのページ」と明記している
    （sites/server.ts:100-121）。本IssueもこのTierに新規`/explore-flow/*`を追加する。
  実装上の制約として、`/explore-flow/*`の分岐は`handle()`内で`/site/:id/...` →
  `SITES`検索（sites/server.ts:122以降）より**必ず手前**に置くこと。後ろに置くと
  `/site/:id/...`の正規表現に先にマッチしてしまい素通りする心配はないが（パスが
  `/explore-flow/...`で`/site/`から始まらないため実害はない）、`/wall-fixture/*`等
  既存の分岐と同じ並び順に置くことで、この一群が「`SITES`とは独立したフィクスチャ層」
  であることをコード上でも一目で分かるようにする。
- **壁の「解除」はサーバー側の再訪問状態で表現する**。
  `PageExplorer.resume()`（`src/automation/page-explorer.ts:76-82`）はresume時に
  必ず deferredURL を再キューし、`continueExploration`（同ファイル103行目）で
  同じURLに対して`pageDriver.goto()`をもう一度呼ぶ——その場でスナップショットを
  取り直すだけではない。したがって、`/explore-flow/payment`のようなフィクスチャ
  ページが「初回GETでは壁を出し、2回目以降のGETでは壁を出さない」という
  サーバー側の状態を持てば、それは実際のサイトが「一度CAPTCHAを解決したセッションを
  覚えている」動作を忠実に再現したことになる。これは既存のFakePageDriverベースの
  ユニットテストが「resume()前にスナップショットを入れ替える」ことで表現している
  ものと同じ意味論であり、Soroeru自身が開く別の自動化ブラウザウィンドウをテスト
  コードから操作する必要が一切ない。
- **壁マーカーは`/wall-fixture/captcha`の既存マークアップをそのまま再利用する**
  （「私はロボットではありません」+ `<div class="g-recaptcha" data-sitekey="dummy">`
  + `/wall-fixture/recaptcha-frame`への`<iframe>`）。このマークアップは
  `agent/walls.ts`の壁検出（`CAPTCHA_TEXT_RE`等）が実チェックDOMに対してすでに
  発火することが分かっている組み合わせであり、新しいマーカー文言を発明しない。
- **壁ハンドオフ/resumeのUIはテスト用フックなしにそのまま使う**。
  `CollectionPanel.tsx`はハンドオフ発生時にバナー「ウォールの解決が必要です」と
  ボタン「解決して再開」を表示し（`src/renderer/components/CollectionPanel.tsx:167,187`）、
  クリックすると`electron/visibility-service.ts`の`resumeHandoff()`を呼ぶ。これは
  `VisibilityRunner.collectFromExploration`が`await`している`onHandoff`の
  Promiseを解決し（同ファイル122-186行）、`explorer.resume()`につながる。つまり
  実UIの「解決して再開」を実際にクリックするだけで、本物のresume経路を最初から
  最後まで駆動できる。
- **収集済み件数のロケータは既存のものをそのまま使う**。`/収集済み（開示 \d+）/`
  （`tests/e2e/app-ui.e2e.ts:68`で使用）はサイト単位の累積開示件数なので、
  複数ページから3件以上収集されたことの確認に変更なく使える。

## この増分の範囲

- `sites/server.ts`: 新規トップレベルフィクスチャ`/explore-flow/*`
  （`exploreFlowFixture()`関数と、`handle()`内で`/wall-flow/`と同じ階層への
  dispatch分岐を追加）。
  - 固定のフェイク認証情報をモジュール定数として定義（`EXPLORE_FLOW_EMAIL`
    `EXPLORE_FLOW_PASSWORD` `EXPLORE_FLOW_ZIP` `EXPLORE_FLOW_CARD_NUMBER`
    `EXPLORE_FLOW_CARD_CVV`）。アカウントは常に「登録済み」固定値のため、
    `01-basic`の`seedRegisteredAccount()`のような登録エンドポイントは不要。
  - `startPocServer()`内に、`states`マップとは別の単一の状態スロット
    `exploreFlowState = { paymentWallCleared: false }`を持つ（`SITES`配列の
    どのIDとも紐付かない、このフィクスチャ専用の状態）。
  - ページ構成：
    - `GET /explore-flow`, `/explore-flow/` — ログインへのリンクのみのランディング。
    - `GET/POST /explore-flow/login` — email/passwordログインフォーム
      （`autocomplete="email"` / `type="password" autocomplete="current-password"`、
      送信ボタン「ログイン」）。成功時は`/explore-flow/mypage`へmeta-refresh。
    - `GET /explore-flow/mypage` — 「会員情報」→`/explore-flow/profile`、
      「お届け先住所」→`/explore-flow/address`、「お支払い方法」→
      `/explore-flow/payment`の3リンク。ラベル文言は
      `RuleEngine.PROFILE_LINK_RULES`（`会員情報|登録情報|プロフィール`、
      `住所|配送先`、`クレジットカード|お支払い`）に一致させる。
      「先に会員情報・住所を収集してから支払い方法の壁で止まる」という探索順序は、
      `address`と`payment`が`PROFILE_LINK_RULES`上で同じ優先度4であり
      （`src/automation/rule-engine.ts:44-45`）、同優先度内は安定ソート＋HTML上の
      リンク順（住所→支払い方法の順で並べる）で決まることに依存している。将来
      `PROFILE_LINK_RULES`の優先度を再調整する場合は、このE2Eの一時停止位置が
      黙って変わりうる点に注意すること。
    - `GET /explore-flow/profile` — readonlyなメールアドレス欄1つ。
    - `GET /explore-flow/address` — readonlyな郵便番号欄1つ。
    - `GET /explore-flow/payment` — `exploreFlowState.paymentWallCleared`が
      `false`なら、それを`true`に更新した上で`/wall-fixture/captcha`と同一の
      CAPTCHA風マークアップを返す（壁）。`true`（2回目以降の訪問）なら、
      readonlyなカード番号欄（`autocomplete="cc-number"`）とセキュリティコード欄
      （`autocomplete="cc-csc"`）を返す——CVV欄は、収集後にvaultへ絶対に
      到達しないことをE2Eで確認するために意図的に含める。
  - `sites/defs.ts`・`01-basic`・既存`SITES`エントリへの変更は一切なし。
- `tests/e2e/app-ui-exploration.e2e.ts`（新規）:
  1. `startPocServer(0)`でフィクスチャを起動。
  2. `name,url,username,password,note`のCSV1行を一時ファイルに書き出す
     （`url`は`${site.url}/explore-flow/login`、認証情報は上記固定値）。
  3. `_electron.launch()`でアプリを起動、ボールト作成→CSV取り込み→対象サイトを
     選択→「選択したサイトを収集」まで#303と同じ手順で操作。
  4. バナー文言「ウォールの解決が必要です」の出現を待つ（=`/explore-flow/profile`と
     `/explore-flow/address`はすでに収集済みで、`/explore-flow/payment`の壁で
     一時停止した状態）。
  5. 「解決して再開」をクリックし、`/収集済み（開示 \d+）/`でN≥3になるのを待つ。
  6. `finally`で`electronApp.close()` / `pocServer.close()`。
  7. `electronApp.close()`後、`vault.json`を同じパスフレーズで`VaultV2.open()`
     し直し、`DomainService.listDisclosuresForSite()`で
     - 開示が3件以上あり、`sourcePageUrl`が`/explore-flow/profile`
       `/explore-flow/address` `/explore-flow/payment`の3ページにまたがること
       （実UI越しの複数ページ収集の証明）。
     - カードの開示値が末尾4桁のみであること。
     を確認する。
  8. `vault.json`の生バイト列に、フェイクパスワード・フェイクCVV・フルの
     カード番号のいずれも含まれないこと（末尾4桁は含まれてよい）を確認する
     （`app-ui.e2e.ts:92-94`と同型の平文残存チェック）。
- `package.json`: `"e2e:app-ui-exploration": "npm run build:app && node --test dist/compiled/tests/e2e/app-ui-exploration.e2e.js"`
- `docs/testing.md`: §5コマンド一覧・§7 CI決定（`e2e:app-ui`と同じ「ローカル専用、
  Xvfb未投資」の理由付け）に新シナリオを追記。
- `docs/manual-test.md`: 「収集はログイン直後に到達したページのみを観測し、
  マイページ等への自動遷移は後続Issueでスコープ外」という既存の記述はPhase 6の
  探索導入により古くなっているため、探索がすでにリンクを辿って複数ページを収集する
  ことを反映するよう修正する。実サイトでの収集率改善（no-data改善）の裏付けは、
  架空フィクスチャでは意味のある比較にならないため、`npm run e2e:real-visibility`を
  探索導入前後で手動実行して比較する運用メモとして残す（自動アサーション化はしない）。

## 非範囲

- `run/measure.ts`（登録/一括更新のE2Eマトリクス）への統合・再設計。
- `tests/e2e/real-visibility.e2e.ts`（実サイト向けハーネス）への変更。
- Soroeruが収集中に開く自動化用headedブラウザウィンドウをテストコードから直接操作
  すること（#303と同じ理由で不採用）。
- CIワークフローへの組み込み（`e2e:app-ui`と同じくローカル専用のまま）。
- 探索導入前後のDisclosure収集件数の**自動化された**回帰比較（手動運用に留める）。

## 失敗時の扱い・後始末

- 固定`setTimeout`/`sleep`は使わず、Playwrightのロケータ待機のみを使う
  （`writing-good-tests`スキル準拠、`app-ui.e2e.ts`と同様）。
- テストが途中失敗しても`electronApp.close()`と`pocServer.close()`は`finally`で
  必ず実行する。
- 状態ディレクトリ（`state/soroeru-poc/e2e-app-ui-exploration/<timestamp>/`）は
  削除せず残す（デバッグ用、`state/`はGit管理外）。

## 検討した代替案

- **`01-basic`の`/account`を多ページ化する**: 新規フィクスチャを増やさずに済むが、
  「上記決定事項」の通り既存テストの前提を壊すリスクと、`SITES`経由の
  `run/measure.ts`統合リスクを避けられないため不採用。
- **新しい`SiteDef`を`SITES`に追加する（例: `11-explore`）**: 探索専用の
  サイトとして明確に分離できるが、`run/measure.ts`が`SITES`を無条件にイテレートする
  ため、登録フォーム・ground truth・一括更新など探索と無関係な要件をすべて満たす
  必要が生じ、CIの登録マトリクスに意図せず参加してしまう。`/wall-flow/*`と同じ
  トップレベルフィクスチャ方式の方が、既存の前例に沿っており分離が明確。
- **壁の解除を、Soroeruの自動化ブラウザをPlaywrightで直接操作して行う**（実際に
  「人間役」としてCAPTCHAページ上のボタンを押す）: プロダクト上の壁ハンドオフの
  実際のUXにより忠実だが、Soroeruの自動化ブラウザは`playwright`の`chromium.launch()`
  で開かれる別プロセスであり、Electronのウィンドウ一覧（`electronApp.windows()`）
  からは見えない。CDP経由での追加接続が必要になり複雑化する。`PageExplorer.resume()`
  が同じURLに再度`goto()`する実装であることを踏まえ、サーバー側の再訪問状態で
  「セッションが壁の解決を覚えている」ことを表現する方が、実装コストに対して
  検証したい振る舞い（pause→resume→続きの収集）を過不足なくカバーできる。

## テスト戦略

- 本Issue自体がテストインフラの追加であるため、E2E側は`app-ui-exploration.e2e.ts`
  自身が成果物であり対象。`soroeru-exploration-collection` / `soroeru-page-explorer`
  とは層が異なる（Electronレンダラー＋実IPC＋実ボールト＋実ブラウザを使う、
  探索フローについての唯一のテスト）。
- 複数ページ収集・壁ハンドオフ→resumeの**ロジック自体**の回帰防止は、CIで実行される
  既存のFakePageDriverベースのユニットテストが引き続き担う。本E2Eはその実機経路
  （実UI・実ブラウザ・実vault）での再確認という位置づけで、ローカル専用のまま
  CIゲートにはしない。
- `npm run e2e:app-ui-exploration`の合否がこの機能の受け入れ基準（Issue #251の
  Verification）。
