# PoC: chrome:// リンク遷移と Chrome autofill 動作検証（Issue #29）

RFC-001（`docs/rfc/rfc-001-chrome-autofill-pivot.md`）の Open Questions **R / R2 / R3** を
実機 Chrome で検証する使い捨て PoC 拡張。**製品コードではない。出荷しない。**

- **R**: `chrome://password-manager/...` / `chrome://settings/...` を拡張から開けるか
- **R2**: 拡張ページ（`chrome-extension://`）上で Chrome autofill の発動と保存プロンプトが動くか
- **R3**: 通常ページでの autofill 発生を `input` / `change` イベントで安定観測できるか＋フォールバックの有効性

## 安全方針

- ログは**フィールドの値を一切記録しない**（イベント種別 / フィールド識別子 / isTrusted /
  inputType / 値の長さ / `:autofill` 状態のみ）。
- フォーム送信はすべてユーザーのクリックでのみ行う（自動送信なし）。
- **検証にはダミーデータのみ使用する**こと（下記の事前準備参照）。

## 事前準備

1. Chrome に**検証用のダミー住所プロフィール**を登録する:
   `chrome://settings/addresses` → 「住所を追加」→ 架空の氏名・住所・電話・メールを入力。
   実在の個人情報は使わない（結果を Issue / RFC に貼るため）。
2. この PoC 拡張を読み込む:
   `chrome://extensions` → デベロッパーモード ON → 「パッケージ化されていない拡張機能を読み込む」→
   `poc/issue-29-autofill-poc/` を選択。
3. 検証した Chrome のバージョンを控える（`chrome://version`）。結果表に記入する。

## 手順

### R: chrome:// リンク遷移

ツールバーの PoC 拡張アイコンをクリック → 検証ページが開く。

1. **R-1/R-2**: 「R」セクションの各ボタンを押し、ログ欄の結果（`tabs.create OK/失敗`、800ms後の
   到達URL）を確認する。`chrome://version`（比較用）と Google Wallet（https・対照用）も押す。
2. **R-3**: aタグリンクと `window.open` ボタンを試し、実際に遷移したかを目視で記録する。
3. ブロックされた場合のエラーメッセージ・挙動（何も起きない / エラーページ等）をメモする（R-4）。

### R2: 拡張ページ上での Chrome autofill

同じ検証ページの「R2」セクションで:

1. **R2-1**: 「氏名」フィールドをクリックし、Chrome の autofill 候補ドロップダウンが出るか確認。
2. **R2-2**: 候補を選択し、ログ欄で `input` / `change` / `animationstart(:autofill)` /
   `poll` の出方を確認（どのフィールドまで一括で入ったかも）。
3. **R2-3**: 入った値の一部（例: 郵便番号）をダミーの別値に編集 → 「送信」をクリック →
   遷移先ページで Chrome の「住所を保存/更新しますか？」バブルが出たか確認。
4. ログ欄の「ログをコピー」で結果を控える。

### R3: 通常ページでの autofill イベント観測

1. フィクスチャを localhost で配信する（リポジトリルートから）:

   ```bash
   python3 -m http.server 8420 --directory poc/issue-29-autofill-poc/fixtures
   ```

2. Chrome で `http://localhost:8420/address-form.html` を開く（右下に観測オーバーレイが出る）。
3. **R3-1**: 「氏名」フィールドから autofill を発動し、`input` / `change` イベントが
   対象フィールドすべてに発火するかオーバーレイで確認。
4. **R3-2**: トリガー種別ごとの差を確認:
   - 候補ドロップダウンから選択（フォーム一括）
   - 単一フィールドだけの autofill（候補のサブ項目選択など、出る場合）
   - ページ再読み込み後の再 autofill
5. **R3-3**: フォールバックの有効性を確認:
   - `poll` 行（1秒間隔の `:autofill` ポーリング）が「※input/changeイベント未観測（取り逃がし）」を
     出すケースがあるか
   - 「再スキャン」ボタン（手動再スキャン）で捕捉できるか
6. 「コピー」でログを控える。

## 結果記入表

検証後、この表を埋めて Issue #29 に貼り、RFC-001 §3 / §6 / §6e / §10 に反映する。

- Chrome バージョン: ___
- OS: ___
- 検証日: ___

| # | 検証項目 | 結果（可/不可/条件付き） | メモ |
| --- | --- | --- | --- |
| R-1 | tabs.create で password-manager 一覧/詳細 | | |
| R-2 | tabs.create で settings/addresses・payments | | |
| R-3 | aタグ / window.open での chrome:// 遷移 | | |
| R-4 | ブロック時のエラー・挙動 | | |
| R2-1 | 拡張ページで autofill 候補が出る | | |
| R2-2 | 選択で値が入り event / :autofill で観測できる | | |
| R2-3 | 送信後に保存/更新プロンプトが出る | | |
| R3-1 | 通常ページで input/change が発火する | | |
| R3-2 | トリガー種別による発火差 | | |
| R3-3 | ポーリング/手動再スキャンで取り逃がしを補足できる | | |

## 後片付け

検証後は `chrome://extensions` から PoC 拡張を削除し、ダミー住所プロフィールも
`chrome://settings/addresses` から削除する。この `poc/` ディレクトリの扱い（残す / 削除）は
Issue #29 の Open Question。
