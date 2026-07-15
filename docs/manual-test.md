# 手動テスト — Soroeru スライス A（Visibility / 開示台帳）

これは **Soroeru スライス A — Visibility**（Epic #156）の **プロダクトオーナー受け入れチェックリスト**
です。未署名 macOS DMG、暗号化ボールト、CSV 取り込み、Visibility 収集（自動ログイン →
開示台帳）、横断フィルタと初回 Reflection、CAPTCHA / MFA ウォールのハンドオフ、アプリ終了時の
ライフサイクルまでを対象とします。

> **テストには必ずフェイクデータを使用してください。** 使い捨てのテストアカウントと架空の個人情報のみを
> 使い、本物の認証情報・カード・個人情報はこのチェックリストのどこにも入力しないでください。ボールト
> ファイル・`state/` の出力・秘密情報を含むスクリーンショットを Issue / PR に添付しないでください。

スライスの範囲（[`architecture.md`](architecture.md) §5・[`requirements.md`](requirements.md)）: **A Visibility のみ。** 一括更新
（B）・退会整理（C）・新規登録ゲート（D）は後続スライスであり、ここでは対象外です。コマンド一覧の
正典は [`development.md`](development.md)、テスト種別のマトリクスは [`testing.md`](testing.md) です。

このチェックリストには 2 通りの実施方法があります。

- **パッケージ済み DMG**（パート 1・2・7）: ベータユーザーが実際にインストールする成果物。
- **開発モード × ローカルのテストサイト**（パート 3〜6）: 実在のサイトに一切触れず、フェイクデータで
  自動ログイン／収集を試せる安全な方法。`npm run poc:serve` で同梱のフェイクサイトを起動し、
  `npm run dev` でアプリを起動します。

いずれの場合も、**自分が所有していない第三者のサイトに対して本物の認証情報で Visibility 収集を
実行しないでください。**

---

## 0. 事前チェック（ビルドごとに 1 回）

フェイクデータのみを使用します。これらが通過したコミット SHA を記録してください。

- [ ] `npm ci`
- [ ] `npx playwright install chromium`
- [ ] `npm run typecheck`
- [ ] `npm test`

### 0.1 Chrome bridge developer prototype (Issue #337)

This experiment is developer-only and is not part of the MVP DMG. Use a fake
HTTPS fixture or a test account with fake values; never use another person's
account or real personal data.

- [ ] Run `npm run build:extension` and load `dist/extension/` with
      Chrome's **Load unpacked** developer-mode flow.
- [ ] Confirm the extension lists only `nativeMessaging`, `scripting`,
      `activeTab`, and `storage`; no cookies/history/bookmarks/debugger access.
- [ ] From the extension popup, approve one HTTPS origin with the explicit
      button; confirm a different origin is not silently approved.
- [ ] Start the Electron bridge and confirm the extension badge shows `ON` and
      the selected page shows `Soroeruがこのタブを操作中` while a command runs.
- [ ] Confirm a command for another tab, an unapproved origin, or an HTTP page
      fails without navigation or DOM changes.
- [ ] Close the bound tab or disconnect Chrome; confirm the command fails and a
      later command does not silently bind a replacement tab.
- [ ] Disconnect/unload the extension and confirm no extension-side values,
      cookies, screenshots, or logs were persisted.
- [ ] `npm run poc -- check-egress`（ネットワーク送信先のアローリスト）
- [ ] `npm run poc -- check-persistence`（ローカル書き込み先のアローリスト）
- [ ] `npm run poc -- check-bypass`（CAPTCHA 解決・ボット回避への依存がないこと）
- [ ] `npm run poc:matrix -- deterministic chromium`（決定論的フィールドマッピング）
- [ ] ブランチ / PR 上で GitHub の `ci / unit`・`ci / e2e-deterministic`・`shellcheck` がグリーン

### 0.2 Chrome bridge UI flow (Issue #339)

This UI is a developer-only prototype and remains hidden unless
`SOROERU_ENABLE_CHROME_BRIDGE=1`. Use only a fake HTTPS fixture and fake values.
Never enter a real credential, cookie, card value, or personal value during this test.

- [ ] Build the extension and host bundle (`npm run build:extension && npm run build:host`),
      set `SOROERU_CHROME_EXTENSION_ID` to the unpacked extension ID and
      `SOROERU_CHROME_BRIDGE_HOST_BINARY` to `dist/native-host/host.cjs`, then start the app
      with `SOROERU_ENABLE_CHROME_BRIDGE=1`. Without the flag, confirm the Chrome section is absent.
- [ ] In **設定 → Chrome と接続**, choose **host を登録して接続を始める**. Confirm the UI first
      reports registration / extension-install guidance and explicitly includes instructions to reload the
      extension (or restart the service worker) in chrome://extensions if it was already loaded. Confirm the UI changes
      to **接続済み** only after the extension completes the native-messaging handshake.
- [ ] Open the extension popup in Chrome when disconnected. Confirm that it displays a **CONNECTED/OFFLINE** badge
      and a **アプリに再接続** (Reconnect) button when offline. Click **アプリに再接続** and confirm it successfully reconnects.
- [ ] Verify that all connection transitions (connecting, connected, disconnected, rejected, registration success, registration failure) are recorded in the sanitized diagnostic log file (`~/Library/Application Support/Soroeru/logs/soroeru.log`) under the `chrome-bridge` category without leaking raw secrets, tokens, or credentials.
- [ ] Open one fake HTTPS site. In the app, confirm the instruction says to click the Chrome extension
      icon. Click the icon and then the popup permission button; confirm Chrome's permission prompt is
      caused by that popup gesture, not by an app/native-host message.
- [ ] Confirm the approved origin appears in Soroeru settings. Choose **取り消す**, then confirm the
      origin disappears and automation against it fails with permission required. Re-approve it from
      the extension popup before continuing.
- [ ] Select the fake site's row and start collection. Confirm **このタブで実行しますか？** shows only
      the HTTPS origin and numeric tab ID (no title, path/query, field value, credential, or cookie).
      Cancel once and confirm nothing starts; repeat and approve to start in that tab.
- [ ] During the run, confirm the extension badge and in-page Soroeru banner are visible. Choose
      **一括収集を中止** and confirm the app aborts immediately, the tab binding and badge/banner clear,
      and no later command silently resumes or binds a different tab.
- [ ] Choose **切断して登録物を掃除**. While connected, confirm approved origins are revoked before the
      native-host manifest and copied host are removed. Confirm the cleanup result is shown.
- [ ] Repeat disconnect with Chrome already closed. Confirm manifest/host cleanup still completes and
      the UI explicitly instructs manual removal of remaining site permissions and the unpacked extension
      from Chrome's extension management screen.
- [ ] Inspect app/host/extension diagnostics using fake canaries and confirm renderer IPC events contain
      only connection state, origin, tab ID, counts, and masked wording — never raw values,
      credentials, cookies, socket tokens, or command payloads.

### 0.3 Chrome bridge packaging and cleanup (Issue #340)

DMG に同梱されるのは不活性なリレーファイルのみです（フィーチャーフラグなしでは何も登録・実行
されない）。フェイクデータのみで確認します。

- [ ] `npm run package:dmg` が成功し、マウントした DMG の
      `Soroeru.app/Contents/Resources/native-host/host.cjs` に host バンドルが存在する
- [ ] DMG（`Soroeru.app` 全体）に、ブラウザプロファイル・cookie・`state/` のボールト・`.env`・
      ログ・実データが混入していない（`find`/`grep` による抜き取り検査。
      [`security.md`](security.md) §12.1 のチェックリスト）
- [ ] パッケージ版アプリを `SOROERU_ENABLE_CHROME_BRIDGE=1` と拡張 ID のみで起動し（
      `SOROERU_CHROME_BRIDGE_HOST_BINARY` 未指定）、**host を登録して接続を始める** が
      同梱の host バンドルから
      `~/Library/Application Support/Soroeru/native-host/jp.soroeru.bridge` へのコピーと
      manifest 登録を行うことを確認する（登録はこのユーザー操作までは一切起きない）
- [ ] フラグなしでパッケージ版を起動した場合、Chrome 接続 UI が現れず、manifest
      （`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/jp.soroeru.bridge.json`）
      も host コピーも作成されないことを確認する
- [ ] **切断して登録物を掃除** の後、manifest・host コピー・
      `~/Library/Application Support/Soroeru/native-host/` の残骸が残らない（承認済み
      オリジンは接続中なら取り消し、切断済みならベストエフォート + 手動案内、§0.2 と同じ）
- [ ] `npm run release:check` が extension/・native-host/ を含めて通過する（egress・
      persistence・bypass の各ゲートが両ディレクトリをスキャン対象に含む）

---

## 1. DMG パッケージングと初回起動（Node 不要）

Apple Silicon Mac、macOS 14 Sonoma または macOS 15 Sequoia で実施します。

- [ ] `npm run package:dmg` で `release/Soroeru-<version>.dmg` が生成され、`out/` と `release/` は
      Git で未追跡 / 無視のまま（`git status -sb`）
- [ ] DMG をマウントし、`Soroeru.app` を `/Applications` にドラッグ
- [ ] ビルドは **未署名 / 未公証** のため、初回起動時に macOS の Gatekeeper 警告が出ます。
      **右クリック → 開く** で解除するか、ローカルテストに限り
      `xattr -dr com.apple.quarantine /Applications/Soroeru.app`
- [ ] システムへの Node.js インストール・ホスト型アカウント・クラウドボールト・テレメトリのオプトイン・
      ブラウザ拡張のいずれも **なし** で起動する
- [ ] ウィンドウのタイトルが **Soroeru**、サブタイトルが「ローカルファースト・エージェンシーエンジン」

## 2. 暗号化ボールト: 作成・解錠・リカバリーキー

- [ ] 初回起動（ボールト未作成）では **ボールト作成** フォーム（パスフレーズ + 確認）が表示される
- [ ] 8 文字未満のパスフレーズは「パスフレーズが短すぎます。」と明確な日本語で拒否され、ボールトファイルは
      作成されない
- [ ] 妥当なパスフレーズで、既定では `~/Library/Application Support/Soroeru/vault.json`（`CATASHIRO_STATE_ROOT`
      設定時はその配下）に暗号化ボールトが作成され、解錠済みのアプリが開く
- [ ] `vault.json` をテキストエディタで確認すると、暗号化された JSON のみ（`vaultVersion`・`kdf`・
      `metadata`・`iv`/`ciphertext` を持つ `records[]`）で、**平文の個人情報・認証情報・値は一切ない**
- [ ] 「施錠」でボールトが施錠され、再起動すると作成フォームではなく **解錠** 画面（パスフレーズ +
      リカバリーオプション）が表示される
- [ ] 誤ったパスフレーズでの解錠は「解錠に失敗しました。…」で失敗し、データは表示されない（フェイルクローズ）
- [ ] リカバリーキー未生成のうちはダッシュボードにリマインダーが表示され、「作成」で保管警告とともに
      リカバリーキーが **一度だけ** 表示される
- [ ] 施錠後、**リカバリーキーでの解錠** が成功する。誤ったリカバリーキーはフェイルクローズで失敗する
- [ ] `Soroeru.app` だけを削除してもボールトは消えない。`Application Support/Soroeru` フォルダを削除すると
      次回起動が初回起動として振る舞う

## 3. CSV 取り込みと取り込み結果の確認

ヘッダーが `name,url,username,password,note` の **フェイク** な `Google Passwords.csv` を用意します。パート
3〜6 では URL をローカルのフェイクサイト（`npm run poc:serve`、例 `http://127.0.0.1:<port>/login`）に向け、
フェイクのユーザー名 / パスワードを使います。

- [ ] **設定** タブの CSV 取り込みで CSV を選ぶとローカルで取り込まれ、**件数のみ** のサマリーが
      表示される（データ行数 / 取り込んだ認証情報 / 新規サイト / 既存に一致 / スキップ）。生の
      ユーザー名・パスワード・note は **一切表示されない**
- [ ] サマリーには「取り込みは完了しています。開示台帳タブで対象にチェックを入れて収集できます。」と
      案内される（収集は **開示台帳** タブで行う）
- [ ] 元の CSV をご自身で削除するよう促す注意が表示される。アプリは **自動削除しない**
- [ ] ヘッダー不正（列が想定と異なる等）の CSV は「CSV のヘッダー形式が想定と異なります（name,url,
      username,password,note）。」で拒否され、取り込みは発生しない
- [ ] 大きすぎる / 行数が多すぎる CSV は「CSV ファイルが大きすぎます。」「CSV の行数が多すぎます。」で
      取り込まれず拒否される

## 4. Visibility 収集（自動ログイン → 開示台帳）+ ウォールハンドオフ

**ローカルのフェイクサイト** に対してのみ実行します。

- [ ] **開示台帳** タブに取り込んだサイトが「未収集 / 収集済み（開示 N）」のバッジとともに表形式で
      表示され、行チェック＋「選択したサイトを収集」で収集できる
- [ ] 「選択したサイトを収集」を押すと **可視のブラウザ（headed）** が開き、保存済みの認証情報で自動ログインし、登録済みの
      値をボールトへ収集する。実行中は進捗が表示され、収集済みは「収集済み（開示 N）」になる
- [ ] **既存セッションの再利用:** Chrome bridge でフェイクサイトへ手動ログイン済みのタブ（ログアウト操作が
      表示され、ログイン ID / パスワード欄がない状態）から収集を開始すると、ログインページへ戻らず、保存済み
      認証情報を再送信せずに収集へ進む。診断ログには生の認証情報を含めず、既存セッションを利用した旨だけが残る
- [ ] 収集は **編集可能なフォーム欄の値** に加え、アカウント画面に **テキスト表示された登録情報**（`<dl>` /
      テーブル行 / 読み取り専用 input など）も対象にする。生値はローカルでのみ読み取り・ハッシュ化され、
      AI や外部へ送られない
- [ ] 開示が 1 件以上取れたサイトのみ「収集済み（開示 N）」になり、ステータス行に「収集が完了しました。」が
      表示される（**開示 0 件は成功扱いされない** — 下記参照）
- [ ] **ログイン未完了:** 認証情報があるのにログイン後もログインフォーム（パスワード欄）が残り何も収集
      できなかったサイトは「収集済み」にならず、「ログインが完了しませんでした（パスワードの変更や追加手順の
      可能性）。要確認に記録しました。」と表示され、要確認（Constraint `login-incomplete`）が記録される
- [ ] **情報なし:** ページには到達したが収集できる入力値が無かったサイトは「収集済み」にならず、「ページには
      到達しましたが、収集できる情報が見つかりませんでした（手動確認を推奨）。」と表示される
      （Constraint `no-collectable-data`）
- [ ] **アクセス不能サイト:** ナビゲーションに失敗するサイトでは突破を試みず、「サイトにアクセスできません
      でした。アクセス不能一覧に記録しました。」と表示され、開示台帳に要確認（Constraint、`access-unreachable`）
      が記録される。認証情報は漏れない
- [ ] **非 Web 認証情報:** Google パスワードマネージャーには Android アプリ等の `android://…` エントリも
      含まれます。これらは取り込み時にスキップされ（取り込みサマリーの「スキップ」に計上）、サイトとしては
      作成されません。万一サイト化されていても収集時に「Web サイトではない認証情報のため収集をスキップしました
      （例: アプリ）。」と表示され、ネットワーク到達不可とは区別されます
- [ ] **ウォールハンドオフ:** 流れの途中で CAPTCHA / OTP / 検証ページに到達するサイトでは実行が **一時停止**
      し、閉じられない確認ダイアログ「ウォールの解決が必要です」が表示され、可視ブラウザでご自身に解決を
      促す。保存済みの認証情報があるログイン系のウォールでは、コピー用のログイン ID / パスワードが
      あわせて表示される（パスワードは既定で隠され「表示」で開示、コピー後は自動でクリップボードから
      消去される）。案内は決してウォールの解決 / 突破を勧めない
- [ ] ブラウザでウォールを解決し「解決して再開」を押すと、ページを再観測して停止地点から再開する
- [ ] 代わりに「このサイトをスキップ」を押すと、このサイトの実行はハンドオフ状態で終了し、要確認
      （Constraint）が記録される。一括収集は次のチェック済みサイトへ進む。「一括収集を中止」を押すと
      一括収集全体が停止する。いずれの操作もウォールを突破しない
- [ ] **自動化を禁止する ToS** 文言が検出された場合は、黙ってブロックしたり自動で続行したりせず、ユーザーが
      判断するための要確認（Constraint）として提示される
- [ ] 1 件の収集が進行中に 2 件目の収集を開始しようとすると、「選択したサイトを収集」は無効化され、開始は
      拒否される

## 5. 開示台帳（サイト別・古い値フラグ・マスク表示、収集操作）

- [ ] **開示台帳** タブの表に各サイトが表示され、開示件数を含む「収集済み（開示 N）」バッジ、
      古い件数バッジ、関係チップ（ニュースレター / 継続課金 等）、該当時の「要確認 N」、および
      「詳細 / 保存ページを取り込む / 削除」ボタンが表示される
- [ ] 行の「詳細」を開くと構成済みの詳細が表示され、開示された各属性に古さフラグ（最新 / 古い / 不明）と
      **マスク済み** プレビュー（••• 等）が付く。既定では生の値は表示されない
- [ ] 正典の Personal Attribute と異なる値は **古い**、一致する値は **最新**、ハッシュのみの値は **不明** と
      フラグされる
- [ ] 表示可能な行の「表示」は **マスターパスフレーズの再入力** を要求する。「確認して表示」で正しければ
      一時的に値が表示され、誤りなら「パスフレーズが一致しません。」で失敗する。「隠す」で再びマスクできる
- [ ] 最も機微な項目（カード CVV）は台帳から **一切表示できない**（「この値は表示できません（最も機微な
      項目）。」、ハッシュのみの値は「表示できる生の値がありません（ハッシュのみ収集済み）。」）
- [ ] 明示的な再認証による表示までは、台帳ビューのどこにも生の値が現れない
- [ ] 分類器が既知/確認済み属性にマッピングできなかった必須項目があるサイトでは、詳細に「新しい項目が
      見つかりました」としてラベル付きで提示される（生の値は含まれない）
- [ ] 提示された項目名を確認（必要なら編集）して「この項目として追加する」を押すと再利用可能な属性として
      確定し、一覧から消える。以降の収集で同じラベルの項目が自動的にこの属性へ再マッピングされる
- [ ] **ログイン認証情報の更新（Issue #362）:** サイト詳細に「ログイン認証情報を更新」が表示される。
      既存パスワードは表示されず、新しいパスワード入力はマスクされる。ログイン ID と／または
      新しいパスワードを入力し、「既存のログイン認証情報を上書きすることを確認しました」にチェックして
      「認証情報を保存」を押すと保存できる（確認なしでは保存できない）。保存後、当該サイトを再収集すると
      **新しい認証情報** で自動ログインが試みられること（旧パスワードではログインできないこと）。
      台帳ビュー・診断ログに新しいパスワードの平文が出ないこと
- [ ] **セッション永続化トグル（Issue #294、既定オフ）:** サイト詳細に「ログインセッションを保持する」
      チェックボックスが表示される。オフのままでは「保存されたセッションはありません。」のまま
      変化しない
- [ ] トグルを **オンにして再収集** すると、収集完了後にサイト詳細の表示が「保存済み（最終更新: …）」に
      切り替わる（Playwright の `storageState` がボールトへ暗号化保存された印）
- [ ] 保存済みの状態で **再度収集を実行** すると、毎回ログインフォームを要求する作りのフェイクサイトでも
      保存済みセッション（Cookie）により通常のログインフォーム入力が省略されることを確認する（同じ
      フェイクサイトを `channel: "chrome"` 検証のときと同様に用意する）。これは「ログイン状態を維持する」
      一般的な Cookie セッションの再利用であり、CAPTCHA / MFA /本人確認等のウォールを回避するものでは
      ない点に注意する（ウォールはこの機構と無関係で、検出時は常にハンドオフされる）
- [ ] **「今すぐ削除」** を押すと保存済みセッションが即座に消え、表示が「保存されたセッションはありません。」
      に戻る。トグル自体はオンのままなので、次回収集はまた新規に保存される
- [ ] トグルを **オフに戻す** と、保存済みセッションが存在していても即座に削除される（Delegation Boundary の
      縮小と同じ「無条件・即時」の挙動）
- [ ] ボールトを施錠 → 再解錠しても、保存済みセッションの表示状態（オン/オフ・最終更新日時）が正しく
      復元される（暗号化ラウンドトリップの確認）

## 6. 横断フィルタと初回 Reflection

- [ ] **インサイト** タブに「気づき（Reflection）」と「横断フィルタ」の 2 セクションが表示される
- [ ] 横断フィルタに 4 つのフィルタが並ぶ: ニュースレターが有効なサイト / 継続課金・無料トライアルの
      サイト / 連絡先・カードが古いサイト / 収集が止まっている（未確認の）サイト
- [ ] 「収集が止まっている（未確認の）サイト」には、ウォール / ログイン未完了 / 情報なし / アクセス不能の
      いずれかで収集が完了しなかったサイトが集約され、理由と要確認の根拠にひも付く（収集成功＝開示 1 件以上の
      サイトはここに出ない）
- [ ] 各フィルタ項目は理由・根拠（フィールドラベル / マスク済みスニペット / ページ URL）・「次の安全な
      アクション」の説明にひも付く（実行する後続スライスは後で着地。スライス A は記述のみ）
- [ ] 初回 **Reflection** が所見（古い値 / ニュースレター / 課金 / 過剰開示 / 収集停止）を **個別の観察** と
      して要約する。単一の盲目的な「全部承認」ボタンには **まとめない**（意志の委譲は決して行わない）

## 7. アプリ終了時のライフサイクル（孤児ブラウザなし・ボールト施錠）

- [ ] 収集を開始した状態で **アプリを終了**（⌘Q）すると、可視の Playwright ブラウザが閉じ、`Soroeru` /
      Chromium のヘルパープロセスが残らない（アクティビティモニタ / `pgrep` で確認）
- [ ] 再起動すると **解錠** 画面が表示される（終了時にボールトが施錠され、導出鍵は保持されない）

## 8. プライバシー・セキュリティの抜き取り確認

- [ ] テレメトリ / 分析 / クラッシュレポートのネットワーク通信が発生しない（ビルドはこれらを追加せず、
      `check-egress` が静的に強制する）
- [ ] 根拠 / 診断情報には **参照・ハッシュ・マスク済みスニペットのみ** が含まれる。実サイト由来の生の値・
      秘密を含むスクリーンショット・Cookie・トークン・Playwright トレースは含まれない
- [ ] AI プロバイダを設定した場合（任意）でも、送られるのはフォーム構造 / 規約テキストのみで、生の個人情報は
      送られない（既定は決定論モードでプロバイダ不要）

## 9.（任意）AI フォールバック（AiEngine）の実プロバイダ手動確認

`AiEngine`（`src/automation/ai-engine.ts`、Issue #276）は、Visibility 探索
（`DecisionEngine` / `RuleEngine` / `PageExplorer` / `LoginHandler`）の一部でルールが
判断できなかったときのオプションの AI フォールバックです。

**Issue #310 以降、`npm run dev` のアプリ本体でも実際に発火します**: `SoroeruSession`
（`electron/session.ts`）がバルト解錠のたびに `.env` の `OPENAI_API_KEY` /
`ANTHROPIC_API_KEY` を見て `AiEngine` を（設定されていれば）自動的に構築し、
`VisibilityRunner` の `DecisionEngine` へ結線します。**設定画面はまだなく、鍵が環境変数に
あるだけで有効化される開発・手動検証専用の暫定配線**です（本番の設定ストア連携は別
Issue）。ただし現状 `DecisionEngine` 経由で AI フォールバックが実際に発火しうるのは
`find-profile-links` / `should-continue`（`PageExplorer` の探索判断）のみです —
ログインページ探索・フォーム検出・ログイン結果判定は今も `login-handler.ts` の
決定的ヒューリスティックを直接使っており `DecisionEngine` を経由しません。

- [ ] `.env` に `OPENAI_API_KEY`（または `ANTHROPIC_API_KEY`）を設定した状態で
      `npm run dev` を起動し、ローカルのフェイクサイト（`npm run poc:serve`）に対して
      パート 4 の「収集」を実行する。ログイン後ページのリンク文言が §2 の組み込み
      キーワード（マイページ／会員情報／住所 等）に一切マッチしないフェイクサイトを使うと、
      ルールが確信を持てず AI へフォールバックしやすい
- [ ] 開発ターミナルに `[ai-engine] { kind: "find-profile-links" | "should-continue", ... }`
      の形の `AiConsultationLog` が出力される（`outcome: "used"` を含む）。本文・プロンプトは
      一切出力されない
- [ ] `.env` の鍵を外して同じ操作を行うと、`[ai-engine]` ログが一切出ずルールベースのみで
      従来通り収集が完了する（既定挙動が変わっていないことの確認）

`classify-field` / `name-new-attribute` / `detect-login-form` / `judge-login-result` /
`find-login-page` は上記の理由でアプリ本体からは未到達のため、これらの実プロバイダ確認は
引き続き下記のような小さな Node スクリプトで `AiEngine.consult()` を直接呼び出して行います。

```ts
import { AiEngine } from "./src/automation/ai-engine.js";
import { aiProviderFromEnv } from "./src/agent/ai/provider.js";

const provider = aiProviderFromEnv(); // .env の OPENAI_API_KEY / ANTHROPIC_API_KEY を使用
if (!provider) throw new Error("set OPENAI_API_KEY (or ANTHROPIC_API_KEY) in .env");

const aiEngine = new AiEngine(provider, { currentValues: () => [] }, {}, (log) => console.log(log));

const result = await aiEngine.consult({
  kind: "classify-field",
  snapshot: {
    url: "https://example.com/mypage",
    title: "",
    fields: [],
    buttons: [],
    links: [],
    visibleText: "",
    iframeSrcs: [],
    wallMarkers: [],
  },
  context: {
    siteAccount: { domain: "example.com", displayName: "Example" },
    field: {
      fieldId: "f-1",
      tag: "input",
      type: "text",
      name: "",
      id: "",
      autocomplete: "",
      required: false,
      placeholder: "楽天ポイント番号",
      labels: [],
      nearbyText: "",
    },
  },
});
console.log(result);
```

```bash
npm run build && node --env-file-if-exists=.env dist/compiled/<script>.js
```

- [ ] 実プロバイダ（OpenAI または Anthropic）に対して呼び出しが成功し、`source: "ai"` の
      `DecisionResult` が返る（分類不能な場合は `classification: null` が返る想定で、それも成功扱い）
- [ ] `onLog` に渡される `AiConsultationLog` の `url` はクエリ・フラグメントを含まない
      origin+path のみで、プロンプト本文やレスポンス本文自体はログ・保存物のどこにも出力されない
- [ ] ネットワークキャプチャ（開発者ツール／プロキシ等、任意）で、送信される JSON に
      `visibleText` やフィールド値、生の個人情報が含まれないことを確認する

## 10. SSO ログイン・ハンドオフ（Issue #351）

ID/PW 欄のない SSO 専用ログイン、または ID/PW 失敗後の SSO フォールバックを確認します。
**フェイクデータ / 本人が所有するテストアカウントのみ**を使い、第三者のアカウントや本番の個人情報は使わないでください。
Soroeru は **SSO ボタンを自動クリックせず、IdP 上で入力・アカウント自動選択もしません**。壁（CAPTCHA/MFA）の
回避手順を案内することもありません。

- [ ] **Problem 1（SSO 専用）**: ログインが SSO のみのサイト（またはローカルで SSO ボタンのみのフィクスチャ）で
      Visibility 収集を開始する。ハンドオフ文言が「IDとパスワードの入力欄が見つかりませんでした」系であり、
      CAPTCHA 解決を求めないこと。開いているブラウザで**自分で** SSO を完了し「続行」すると、同一セッションで
      収集が再開すること
- [ ] **Problem 2（ID/PW 失敗 → SSO）**: ID/PW 欄と SSO の両方があるサイトで、意図的に誤った（または未連携の）
      テスト用 ID/PW で収集を開始する。失敗後に「IDとパスワードでのログインができませんでした」系の SSO
      案内が出ること。credential 提示があっても、Soroeru が SSO を自動操作しないこと
- [ ] **SSO なし regression**: SSO のない通常の ID/PW ログイン失敗サイトでは、従来どおり `login-failed` 相当の
      結果になり、SSO ハンドオフが**出ない**こと
- [ ] **記録**: 診断ログ / Constraint / checkpoint に `sso-login-required` または `sso-fallback-suggested` が
      区別可能な形で残ること（生のアカウント識別子やパスワードをログに出さない）
- [ ] 中止した場合、Problem 1 は handoff 状態、Problem 2 は login-failed 相当で終わり、再プロンプトの無限
      ループにならないこと（1 サイト実行あたり SSO ハンドオフは最大 1 回）

## 11.（任意）ローカル限定の実サイト E2E ハーネス

実サイトでの自動ログイン → 収集 → 古い値フラグ → 関係検出 → ウォール検出を CLI で確認したい場合は、
ローカル限定の E2E ハーネスを使えます。CI では決して動かず、ユーザー名・パスワード・note・収集した生の値を
出力しません。

```bash
CATASHIRO_E2E_PASSWORD_CSV=tests/e2e/Google_Passwords.csv npm run e2e:real-visibility
```

- [ ] CSV を指定しない / 存在しない場合、テストは **スキップ** される
- [ ] CSV には本物の認証情報が含まれるため `tests/e2e/*.csv` は gitignore 済み。**コミットしない**
- [ ] この自動 E2E ではウォールに到達すると（人が介入できないため）中止 / スキップされる。実 UI / 実行時は
      通常のハンドオフ / 再開フローを使う
- [ ] 生成物は `state/catashiro-poc/e2e-real-visibility/` 配下に出力される。確認するのは件数（収集 /
      アクセス不能 / ウォールスキップ）のみで、**コミットしない**

---

## 12. ベータリリースメモと既知の制限

ビルドを共有する際は、テストしたコミット SHA / タグ、成果物名と配布チャネル、対応プラットフォーム
（Apple Silicon Mac、macOS 14/15）、**署名 / 公証の状態（現在は未署名）**、パート 1 の Gatekeeper 手順を
記録してください。実装とチェックが覆すまで、以下の制限を引き継ぎます。

- [ ] Mac 限定ベータ。Windows・Linux・モバイルは非対応
- [ ] ビルドは **未署名 / 未公証**。自動更新チャネルなし（各ビルドを手動インストール）
- [ ] システム Node.js は不要（Electron 同梱ランタイムを使用）
- [ ] ホスト型ボールト・バックエンド同期・テレメトリ・分析・クラッシュレポートなし。ボールトは既定で
      ローカル・暗号化
- [ ] CAPTCHA / MFA / 本人確認・メール / SMS 検証 / ボット検出 / レート制限 / ペイウォール / アクセス制御は
      **ハンドオフ地点であり、決して突破しない**
- [ ] スライス範囲は **Visibility のみ**。一括更新・退会・新規登録ゲートは後続スライス
- [ ] **収集はログイン後、発見したリンクを辿って複数ページを探索する**（Visibility探索、Issue #249 で
      導入）。「マイアカウント / 設定」等へのリンクが会員情報 / 住所 / お支払い方法のような文言で
      張られていれば追跡され、壁（CAPTCHA / MFA 等）に当たった場合はそのページで一時停止し、
      ハンドオフ→resume で継続する（`tests/e2e/app-ui-exploration.e2e.ts`、Issue #251 が実 UI 越しに
      回帰確認する）。下記の実サイト計測値（collected ≈16% / no-data ≈52% / unreachable ≈16% /
      handoff ≈12% / login-failed ≈4.5%）は探索導入前のものであり、探索導入後の再計測は
      `npm run e2e:real-visibility` を探索導入前後で手動実行して比較する運用にまだ委ねられている
      （自動アサーション化はしていない）。**開示 0 件は成功扱いしない**設計のため、`no-data` は
      「未収集」として正直に表示される
- [ ] フィールド検出は現在 **日本語のみ**
- [ ] AI プロバイダモードは任意で、ユーザー設定の鍵を使い、受け取るのはフォーム構造 / 規約テキストのみ。
      生の個人情報は決して受け取らない
