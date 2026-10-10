# Issue #554: Chrome 拡張 + Google Cloud ハイブリッドアーキテクチャ

- Issue: [#554](https://github.com/soroeru/Soroeru/issues/554)
- 関連: [#555](https://github.com/soroeru/Soroeru/issues/555)（ハッカソン提出物）、#514 / #516–#519（AI 駆動 Visibility 収集）、#391 / #474（拡張を本番の入口にする決定）
- 状態: 詳細設計。本書の確定事項は [`requirements.md`](../requirements.md) §8・REQ-023〜REQ-030、[`architecture.md`](../architecture.md) §1・§14、[`security.md`](../security.md) §15 に反映済み。
- 基準: `origin/main` の `202baf1`。

## 1. 目的と範囲

Soroeru の実行基盤を **Electron trusted core + Native Messaging + 薄い Chrome 拡張** から、
**Chrome 拡張が主体のクライアント + Google Cloud の共有フォーム知識層** に移す。

守る境界は次の 1 文である。

> 個人情報は既定でローカルに留まる。共有フォーム知識は Google Cloud に置く。生の個人情報を
> Gemini に送るのは、フォールバックごとにユーザーが明示的に承認した例外だけである。

本書の範囲:

- 拡張内のコンポーネント分割（Side Panel / Service Worker / Content Script / ローカル暗号化永続化）
- 3 段の解決パイプライン（Tier 1 共有スキーマ、Tier 2 構造のみ Gemini、Tier 3 同意付き Gemini）
- Cloud Run API、Firestore の Form Schema Registry、BigQuery の改善テレメトリの契約
- データ分類と送信先、ログ禁止、スキーマ汚染への対策
- 移行順序と実装 Issue の分割（§12）

範囲外（Issue #554 の non-goals と同じ）: 複数ブラウザ対応、任意のクラウドストレージ対応、
個人 vault のクラウド同期、ユーザーの生データによる学習、壁の自動突破。Electron ファイルの全削除は
**ハッカソン範囲（P0）の対象外**であり、Issue #554 の P2 チェックリストどおり、同等性の確認後に
P2-1（§12）で本番ビルドから外す。

用語: Slice A〜D は [`requirements.md`](../requirements.md) §7 の順序（A Visibility、B 一括更新、
C 退会、D 新規登録）を指す。

## 2. 現状と接続位置

| 現状 | 場所 | 本設計での扱い |
| --- | --- | --- |
| Vault v2 がファイルシステムを所有する | `src/store/vault-v2.ts`（`node:fs/promises`、`node:crypto` の `randomUUID`） | `VaultPersistence` に永続化を切り出す（§6） |
| 暗号処理が Node 依存 | `src/store/crypto.ts`（`node:crypto` の `randomBytes` / `webcrypto`） | Web Crypto と `hash-wasm` だけに依存する形へ分割（§6.2） |
| 拡張は Native Messaging でコマンドを受ける | `extension/worker.ts` の `chrome.runtime.connectNative("jp.soroeru.bridge")` | デモ経路から外し、拡張内メッセージに置き換える（§4） |
| 拡張 manifest に `nativeMessaging` | `extension/manifest.json` | P2 で削除（§12） |
| 実行の主体は Electron | `electron/session.ts`、`electron/visibility-service.ts` | ブラウザ中立なサービスへ分割し Side Panel から呼ぶ |
| AI は利用者設定の Anthropic / OpenAI | `src/automation/ai-engine.ts`、`ai-visibility-collector.ts` | 目標構成では Soroeru Cloud Run 経由の Gemini に置き換える（§5） |
| 送信先の静的検査は `target-site` / `ai-provider` | `src/dev/egress-check.ts` | `soroeru-cloud` 区分を追加する（§10） |

再利用する資産: `src/domain/**`、`src/automation/page-driver.ts`、`extension-page-driver.ts`、
`src/agent/scan.ts` / `classifier.ts` / `walls.ts`、`wall-detection.ts`、#516 の位置セレクタ規則と
#518 の構造フィンガープリント契約、#517 のローカル照合（corroboration）規則。

## 3. データ分類と送信先

送信可否は **データ分類で決まる**。呼び出し元のコードが個別に判断しない。

| 分類 | 例 | ローカル | 共有スキーマ (Firestore) | テレメトリ (BigQuery) | Gemini |
| --- | --- | --- | --- | --- | --- |
| C0 秘密 | サイトのパスワード、vault パスフレーズ、マスター鍵、リカバリーキー、OTP・MFA コード、Cookie・セッショントークン、CVV（入力値・サイト表示値とも）、カード PIN、マイナンバー、API キー | 暗号化保存（マイナンバーと PIN は保存しない） | 不可 | 不可 | **不可（同意があっても送らない）** |
| C1 個人の値 | 氏名、住所、電話、メール、生年月日、カード番号・有効期限・名義、サイトのアカウント ID | 暗号化保存 | 不可 | 不可 | Tier 3 の同意後のみ |
| C2 個人情報を含み得るページ内容 | DOM のテキスト、入力値、表示値 | 一時的にメモリ上のみ | 不可 | 不可 | Tier 3 の同意後のみ（C0 はマスク済み） |
| C3 構造 | タグ、type、autocomplete、name/id のトークン、伏字処理済みラベル、構造フィンガープリント | 可 | 可 | 可（ハッシュのみ） | 可 |
| C4 スキーマ | フィールド → 正規属性キーの対応、構造アンカー | 暗号化キャッシュ | 可 | ID・版のみ | 可 |
| C5 結果メタデータ | 成功・失敗・ハンドオフ、エラー区分、信頼度の区間 | 任意（暗号化監査） | 不可 | 可（型付き許可リストのみ） | 通常は送らない |
| C6 同意イベント | Tier 3 の承認・拒否・失敗、対象サイト、属性キー | 暗号化監査 | 不可 | 件数の集計のみ（任意） | 不可 |
| C7 サイト単位の仮名検証トークン | `HMAC(validatorKey, site)`（§7.2） | 元の `validatorKey` を暗号化保存 | サーバ側で再 HMAC した値のみ | 不可 | 不可 |

決定事項:

- **C0 は Gemini に送らない。** Tier 3 でも、`type=password`、`autocomplete` が `current-password` /
  `new-password` / `one-time-code` / `cc-csc` の要素、およびローカル分類器が C0 と判定した項目は、
  ペイロード作成前に `[SECRET]` トークンへ置き換える。これは #514 の「サイトのパスワードと CVV
  もモデルが読む」方針を目標構成で置き換えるものである（§11.1）。
- 共有スキーマとテレメトリに入れてよいのは C3〜C5 だけであり、型で強制する（§8.2、§9）。

## 4. 拡張内のコンポーネント

```text
Chrome
├── Side Panel（信頼済み実行ホスト）
│   ├── VaultSession: 非抽出 CryptoKey を保持（パネルが閉じると破棄）
│   ├── DomainService / Policy / Delegation Boundary
│   ├── ResolutionOrchestrator（Tier 1 → 2 → 3）
│   ├── CloudClient（型付き API クライアント）
│   ├── StructureSanitizer / TelemetryBuilder / Tier3PayloadBuilder
│   └── UI: アンロック、台帳、レビュー、同意ゲート、ハンドオフ表示
├── Service Worker（リース発行とイベント中継、鍵と個人の値を持たない）
│   ├── タブリース（tab / origin / epoch）の発行・無効化
│   ├── chrome.scripting によるコンテンツスクリプト注入（リーストークンを渡す）
│   └── タブ・ナビゲーションイベントの監視 → Side Panel へ通知
├── Content Script（最小権限の DOM 操作。Side Panel と直接通信）
│   ├── 構造スキャン、値の読み取り、入力、クリック、遷移
│   ├── Tier 3 用の領域読み取りでは、返す前に C0 を `[SECRET]` に置換
│   └── 壁検出のシグナル収集
└── IndexedDB（暗号文のみ）／ chrome.storage.session（リースのメタデータのみ）
```

### 4.1 実行ホストを Side Panel に置く理由

MV3 の Service Worker はアイドル時に停止し、グローバル変数は残らない。Issue #554 の図では
オーケストレーションを Service Worker に置いているが、そのままでは鍵の保持場所がない。

| 案 | 内容 | 判断 |
| --- | --- | --- |
| A | Service Worker で実行し、鍵の生バイトを `chrome.storage.session` に置く | 不採用。生鍵がシリアライズ可能な形で残り、拡張内の他コンテキストから読める |
| B | Offscreen Document に実行と鍵を置く | 不採用。同意ゲートを表示できず、Offscreen の用途制約にも合わない |
| C | Side Panel に実行と鍵を置き、Service Worker はイベント中継に限る | **採用**。同意・ハンドオフを表示する画面と鍵の寿命が一致する |

結果:

- Side Panel が閉じる、ブラウザが再起動する、vault をロックする、のいずれかで鍵を破棄する。
  実行中なら中断し、暗号化チェックポイントを保存する（§7.4）。
- Service Worker が停止・再起動しても鍵と実行状態は失われない。Side Panel は長寿命ポートを
  張り、切断を検知したら再接続してリースを再検証する。

### 4.2 拡張内メッセージ契約

Native Messaging の代わりに拡張内メッセージを使う。既存の閉じたスキーマの検証
（`src/shared/chrome-bridge.ts`）を引き継ぐ。**ページ内容と値は Service Worker を通らない。**
Service Worker はリースの発行・無効化だけを行い、ページ操作は Side Panel から Content Script へ
`chrome.tabs.sendMessage` で直接送る。

```ts
// Side Panel ⇔ Service Worker（chrome.runtime.connect のポート）
type PanelToWorker =
  | { kind: "lease.open"; tabId: number; origin: string; nonce: string }
  | { kind: "lease.release"; leaseId: string };

type WorkerToPanel =
  | { kind: "lease.opened"; leaseId: string; epoch: number; tabId: number }
  | { kind: "lease.invalidated"; leaseId: string; reason: LeaseInvalidReason }
  | { kind: "page.event"; leaseId: string; event: "navigated" | "closed" };

// Side Panel → Content Script（chrome.tabs.sendMessage、結果は sendResponse）
type PanelToContent = { kind: "page.command"; leaseId: string; epoch: number; command: PageCommand };
type ContentToPanel =
  | { kind: "page.result"; leaseId: string; epoch: number; result: PageCommandResult }
  | { kind: "page.rejected"; reason: LeaseInvalidReason };

type LeaseInvalidReason =
  | "tab-closed" | "navigated-out-of-scope" | "origin-mismatch" | "epoch-mismatch"
  | "permission-revoked" | "worker-restarted" | "vault-locked" | "panel-closed" | "released";
```

- 注入時に Service Worker が Content Script へ `leaseId` と `epoch` を渡す。Content Script は
  コマンドごとに `leaseId`・`epoch`・自分の origin を照合し、一致しなければ `page.rejected` を返す。
- 無効化（タブを閉じる、範囲外への遷移、権限の取り消し、Service Worker 再起動の検知など）では、
  Service Worker が Content Script に失効を通知し、Side Panel に `lease.invalidated` を送る。
- `PageCommand` / `PageCommandResult` は現行の拡張コマンド（`extension/worker.ts` の
  `EXTENSION_COMMANDS`: snapshot、waitForReady、goto、currentUrl、fillField、click、readValues、
  readDisplayValues、captureCollectionObservation、checkCollectionObservation など）のページ操作分を
  移し、Tier 3 用の `readRegionMasked`（§5.3）を加える。メッセージ枠の検証は
  `src/shared/chrome-bridge.ts` の閉じたスキーマ検証を流用する。
- 一つのタブ、台帳の Site Account の範囲、壁でのハンドオフ（#474、`security.md` §7）は変えない。

## 5. 解決パイプライン

```text
start(op, siteAccount, page)
  │
  ├─ 壁検出 ──壁あり──> handoff（同じタブ）→ 解決後に再観測して最初から
  │
  ├─ Tier 1: スキーマ解決
  │    resolve(site, pageFingerprint) → active schema?
  │    ├─ あり & ローカル検証 OK ──> ローカルで読み取り/入力 → done(shared_schema)
  │    └─ なし / stale / 低信頼 / 検証 NG
  │
  ├─ クラウド到達不可 / クラウド支援オフ
  │    ──> キャッシュ済みスキーマ + 決定的な経路のみ → 未解決は unknown / ハンドオフ → done(local_only)
  │
  ├─ Tier 2: 構造のみ Gemini
  │    sanitize(page) → map-structure → 提案をローカル検証
  │    ├─ 必要な属性がすべて解決 ──> ローカルで読み取り/入力 → done(gemini_structure)
  │    ├─ API エラー（429 / 5xx / 予算超過 / タイムアウト）──> 未解決は unknown、ハンドオフ → done(failure)
  │    └─ 未解決の必須属性が残る
  │         ├─ 読み取り以外の操作 ──> ハンドオフ（Tier 3 は使わない）→ done(handoff)
  │         └─ 読み取り操作 ──> Tier 3
  │
  └─ Tier 3: 同意付き Gemini（読み取りのみ）
       同意ゲート表示（自動実行は停止）
       ├─ 拒否 / 閉じる / タイムアウト ──> 未解決は unknown、手動ハンドオフ → done(declined)
       └─ 承認 ──> 壁・リースを再確認 → 最小ペイロード → read-with-consent
                    ├─ 送信前に壁 / リース失効 / 遷移 ──> 送信せず unknown、ハンドオフ → done(handoff)
                    ├─ API エラー / 通信失敗 / 予算超過 ──> 再送しない（再送には新しい同意が必要）
                    │                            unknown、ハンドオフ、C6 に失敗を記録 → done(failure)
                    └─ 応答 ──> リース・epoch・観測リビジョンが送信時と同じか確認
                         ├─ 変化あり ──> 応答を破棄、unknown、ハンドオフ → done(handoff)
                         └─ 同じ ──> ローカル照合
                              ├─ 照合 OK ──> 暗号化 vault に書き込み
                              │    ├─ 書き込み成功 ──> done(gemini_pii_consent)
                              │    └─ 書き込み失敗 ──> 部分書き込みなし（1 回の save で全件か 0 件）、
                              │                        応答を破棄、unknown、エラー表示 → done(failure)
                              └─ 照合 NG ──> unknown（推測で保存しない）
```

- クラウド到達不可の判定は、resolve の失敗（通信エラー・5xx・タイムアウト 10 秒）で行う。到達不可の
  間は Tier 2・3 を呼ばない。
- Tier 2 の API エラーは、読み取り操作でも Tier 3 に進まない（意図的）。Tier 3 は「構造を見ても
  解決できなかった」ときの例外であり、「構造を見られなかった」ときに生値の送信へ切り替えると、
  障害が同意ゲートの頻度を押し上げ、同意の重みを下げるため。

### 5.1 Tier 1 — 共有スキーマとローカル実行

1. Content Script が構造をスキャンし、#518 の契約でページの構造フィンガープリントを計算する。
2. Side Panel が `POST /v1/schemas/resolve` に登録可能ドメイン（eTLD+1）と、ページの
   フィンガープリントを送る。値・URL のパス・クエリは送らない。
3. 応答の `active` スキーマが返った場合、ローカルで検証する。すべての必須アンカーがページ上に
   ちょうど 1 つずつ存在し、ローカル分類器の結果と属性キーが矛盾しないこと。1 項目でも不一致なら、
   その項目だけ Tier 2 に回す（#518 と同じく項目単位で隔離する）。
4. 値の読み取りと入力はローカルで行う。入力（Slice B〜D）は従来どおりレビュー確認ゲートを通る。
   スキーマは操作の権限を与えない。

### 5.2 Tier 2 — 構造のみの Gemini 対応付け

送る内容は `StructureSnapshot` だけである。

```ts
interface StructureSnapshot {
  site: string;                 // eTLD+1
  pageFingerprint: string;      // 64 桁 hex（#518）
  purposeHint: "profile" | "address" | "payment" | "contact" | "security" | "unknown";
  items: Array<{
    id: string;                 // 不透明 ID（f-N / d-N）
    tag: string;
    type?: string;
    autocomplete?: string;
    nameTokens: string[];       // name/id を区切ったトークン。値に見えるものは除去
    label?: string;             // 伏字処理済み、最大 64 文字
    heading?: string;           // 直近見出し、伏字処理済み、最大 64 文字
    valueShape?: { length: number; charClass: "digit" | "alpha" | "kana" | "kanji" | "mixed" };
  }>;
}
```

- `value`、`checked`、選択中の option、表示値のテキストそのものは入れない。表示値の候補
  （dt/dd・th/td の値側など）は `valueShape` だけを残す。
- ラベルと見出しは、メール・電話・カード番号・郵便番号・数字列の正規表現で伏字にし、伏字後も
  曖昧なら省く（現行 `ai-engine.ts` の構造サニタイザと同じ方針）。
- 応答は閉じたスキーマ `{ mappings: Array<{ itemId; attributeKey; confidence }>; pagePurpose }`
  のみ。未知の itemId、未知の属性キー、URL、セレクタ、自由形式の指示は拒否する。
- 提案は §5.1 と同じローカル検証を通ったものだけ使う。成功した対応付けは候補スキーマとして
  フィードバックする（§8.3）。

### 5.3 Tier 3 — 明示同意付きの Gemini 読み取り

起動条件（すべて満たすとき）:

- 操作が読み取り（Visibility 収集など）である。入力・送信・規約同意には使わない。
- Tier 1 と Tier 2 の後も、操作に必要な属性が未解決である。
- 壁が検出されていない。

同意ゲート:

- 自動実行を止め、Side Panel に表示する。既定の選択は「送信しない」。チェック済みの状態で
  表示しない。
- 表示内容: 対象サイト（origin）、ページの種類、読み取りたい属性の種類、送信先
  （Soroeru の Google Cloud を経由した Gemini）、パスワード・CVV などの秘密はマスクして送らないこと、
  送った内容は改善用データとして保存しないこと。
- 承認の有効範囲は **1 回のフォールバック（1 サイト、1 観測、表示した属性キー）** に限る。
  「次回から自動」は提供しない。Delegation Boundary の L1 でも省略できない。
- 承認・拒否・閉じる・タイムアウト（既定 5 分）のどれでも、C6 として暗号化監査に記録する。
  記録するのは時刻、サイトのハッシュ、属性キー、結果、ペイロードのバイト数とハッシュであり、
  送った値は複製しない。

最小ペイロード:

```ts
interface ConsentedReadRequest {
  consentId: string;            // ローカルで生成した使い捨て ID
  site: string;
  requestedKeys: AttributeKey[];// ゲートに表示した属性キーだけ
  items: Array<{ id: string; label?: string; text: string }>; // 対象領域のみ、C0 は "[SECRET]"
}
```

- C0 のマスクは **Content Script が `readRegionMasked` の結果を返す前に行う**。マスク前のテキストは
  ページの外（拡張メッセージ）に出ない。Side Panel の `Tier3PayloadBuilder` は同じ規則で再検査し、
  未マスクの C0 を見つけたら送信せずハンドオフにする。
- 要素属性で判定できない秘密（dd・td などに平文で表示されたパスワード・CVV・ワンタイムコード）に
  備え、近接ラベル（「パスワード」「セキュリティコード」「CVV」「認証コード」など）と値の形
  （3〜4 桁の数字のみ、など）によるテキストのマスクも行う。判定が曖昧なら `[SECRET]` 側に倒す。
- 対象領域は、未解決の属性に対応しそうな section / form / dl / table の部分木に限る。ページ全体は送らない。
- 上限 16 KiB。超える場合は Tier 3 を行わず、手動ハンドオフにする。
- 応答 `{ values: Array<{ itemId; attributeKey; value }> }` は #517 と同じ規則でローカル照合する。
  値が該当項目の `text` に（NFC・空白・電話とカードの区切りの正規化だけで）含まれなければ捨てて
  `unknown` にする。`requestedKeys` 以外の属性キーは捨てる。
- 照合を通った値は暗号化 vault にだけ書く。応答の本文はメモリから破棄する。

## 6. ストレージ

### 6.1 `VaultPersistence`

```ts
interface VaultPersistence {
  load(): Promise<EncryptedVaultData | null>;
  save(data: EncryptedVaultData): Promise<void>;   // 全体を 1 トランザクションで置き換える
  clear(): Promise<void>;                          // 呼び出し側で削除確認ゲート済みであること
}
```

- `EncryptedVaultData` は現行 Vault v2 のファイル形式（ヘッダ + レコードエンベロープ）と同じ形にする。
  既存のエクスポートファイルをそのまま取り込める。
- 実装: `FileVaultPersistence`（Electron・テスト用、現行のアトミック置換）と
  `IndexedDbVaultPersistence`（拡張既定）。IndexedDB は `readwrite` トランザクション 1 つで
  ドキュメント全体を置き換え、途中で失敗したら前の版が残る。
- 読めない・壊れたデータは従来どおり fail closed にし、空の vault を黙って作らない。

IndexedDB を唯一の保存先にする場合の耐久性:

| 事象 | 設計 |
| --- | --- |
| 途中で中断した保存 | `save` は 1 つの `readwrite` トランザクションでドキュメント全体を置き換える。`oncomplete` までは成功を返さない。中断・失敗時は前の版が残る |
| 容量超過 | `QuotaExceededError` は保存失敗として呼び出し側に返し、メモリ上の変更を「未保存」と表示する。manifest に `unlimitedStorage` を宣言し、起動時に `navigator.storage.persist()` を要求する |
| 退避・消去（ブラウザによる退避、利用者の「サイトデータを削除」、拡張の削除） | 防げないため、vault 作成直後と変更の多い操作の後に暗号化エクスポートを促す。P0 では既存形式の暗号化エクスポート（ダウンロード）だけを提供し、UX の強化は P2-2 |
| 破損 | ヘッダの形式バージョン検証と各レコードの AES-GCM 認証で検出し、fail closed。空の vault で上書きしない |
| 同時書き込み（複数ウィンドウの Side Panel） | `navigator.locks.request("soroeru-vault", { mode: "exclusive" })` を保持した Side Panel だけがアンロックできる。ロックを取れない Side Panel は「別のウィンドウで使用中」と表示する |

代替案: `chrome.storage.local` — 容量と大きな値の扱いで不利なため不採用。OPFS — 拡張ページでの
利用は可能だが、トランザクションの原子性を自前で作る必要があるため不採用。

### 6.2 暗号処理の移植

- `crypto.ts` を「エンベロープとKDFパラメータの論理」と「`CryptoRuntime`（`getRandomValues`、
  `subtle`、Argon2id）」に分ける。Node でも `globalThis.crypto` を使い、`Buffer` は使わない。
- AES-256-GCM、Argon2id（`hash-wasm`）、PBKDF2-HMAC-SHA-512 のパラメータは変えない。既存の
  Vault v2 フィクスチャを拡張側の実装で復号できることをテストで確認する。
- 拡張の CSP に WebAssembly 実行の許可（`wasm-unsafe-eval`）を追加する。`unsafe-eval` は追加しない。
- アンロック後の鍵は `extractable: false` の `CryptoKey` として Side Panel のメモリにだけ置く。
  リカバリーキーで包む処理だけは鍵の書き出しが必要なため、セットアップ時に限り一時的に抽出可能な
  鍵を導出し、包んだ直後に破棄する。

### 6.3 スキーマキャッシュ

どのサイトのスキーマを持っているかは、利用者の利用サイトを表す。キャッシュは暗号化 vault の
新しいレコード種別 `formSchemaCache` に置く。オフライン時はこのキャッシュと決定的な経路だけで動く。

### 6.4 追加・利用する vault レコード

| レコード種別 | 内容 | 新規 / 既存 |
| --- | --- | --- |
| `formSchemaCache` | `FormSchema`（§7.3）と取得時刻 | 新規 |
| `cloudSettings` | テレメトリ・クラウド支援の設定、`validatorKey`、未送信フィードバック・テレメトリのキュー（各項目に `idempotencyKey`、試行回数） | 新規 |
| `workflowCheckpoint` | 既存の形に `resolutionStage`（`tier1` / `tier2` / `consent-pending` / `tier3`）と未解決属性キーを追加。値・ページ内容・同意状態は持たない | 既存（拡張） |
| `evidence` | C6 の同意イベント（`kind: "tier3-consent"`、時刻、サイトのハッシュ、属性キー、結果、ペイロードのバイト数と SHA-256） | 既存（kind の追加） |

レコード種別の追加は `ENTITY_KINDS` と各レコードの `schemaVersion` で表し、vault ファイル形式の
版は上げない（エンベロープの形は変わらない）。既存レコードの形を変える `workflowCheckpoint` は
`schemaVersion` を上げ、旧版を読めるようにする。

## 7. Google Cloud

### 7.1 サービス構成

| サービス | 役割 | ログ方針 |
| --- | --- | --- |
| `soroeru-api`（Cloud Run） | `/v1/schemas/*`、`/v1/agent/map-structure`、`/v1/telemetry/outcome` | 構造化ログはエラー区分・件数・遅延のみ。本文は出さない |
| `soroeru-pii-fallback`（Cloud Run、別サービス） | `/v1/agent/read-with-consent` のみ | アプリケーションログはエラーコードと遅延のみ。本文・属性値・サイト名を出さない。トレースの本文取得なし |
| Firestore | Form Schema Registry、検証フィードバック | — |
| BigQuery | 改善テレメトリ（固定スキーマ） | — |
| Vertex AI（Gemini） | Tier 2 と Tier 3 の推論 | リクエスト・レスポンスのロギング機能とコンテキストキャッシュを使わない |

- リージョンは `asia-northeast1` を既定とする。
- 拡張に Google Cloud の認証情報を埋め込まない。Cloud Run はサービスアカウントで Firestore・
  BigQuery・Vertex AI を呼ぶ。PII フォールバック用のサービスアカウントは Vertex AI の呼び出し
  権限だけを持ち、Firestore・BigQuery の権限を持たない。
- 拡張に埋め込める値は公開値として扱う。API は匿名で呼べる前提で、次の仕組みで濫用を抑える。

| 対策 | 仕組み | 限界 |
| --- | --- | --- |
| 同時実行の上限 | 両サービスに Cloud Run の `max-instances` と `concurrency` を設定 | 正規利用も詰まり得る |
| IP 単位のレート制限 | 各インスタンス内のトークンバケット（IP はメモリ上のみ） | インスタンス数倍まで緩む。ベストエフォート |
| Gemini の日次予算 | `soroeru-api` が Firestore の `budgets/{yyyy-mm-dd}` をトランザクションで加算し、上限超過で 429。Tier 3 は次の行のチケットで同じ予算を使う | 上限到達後は全利用者が Tier 2・3 を使えない（fail closed → ハンドオフ） |
| Tier 3 のチケット | 拡張は承認後に `soroeru-api` の `POST /v1/agent/tier3-ticket` で予算を 1 件消費し、5 分有効の署名付きチケット（HMAC、Secret Manager の共有鍵、ワンタイムの nonce）を得る。`soroeru-pii-fallback` は署名と期限だけを検証する（永続化なし。nonce の再利用はインスタンス内でのみ拒否） | 期限内の同一インスタンス外での再利用は防げない。予算 1 件分に限られる |
| 課金の上限 | Cloud Billing の予算アラート | 通知のみで停止はしない |
| IP を残さない | 両サービスの Cloud Run リクエストログを Cloud Logging の除外フィルタで取り込まない。エラーはアプリの構造化ログ（IP なし）で見る | Google のインフラ側の一時的な処理は Soroeru の管理外 |

  代替案: Cloud Armor や API Gateway のクォータ — 外部ロードバランサか API Gateway が必要で、
  ハッカソン期間の構成としては重いため、本番前の再検討事項（§13）とする。

### 7.2 API 契約

すべて `POST`、JSON、閉じたスキーマ。未知のキーは 400。サイト名を URL のクエリに載せないため、
解決も `POST` にする（Cloud Run のリクエストログにクエリが残るため）。

| エンドポイント | 入力 | 出力 |
| --- | --- | --- |
| `POST /v1/schemas/resolve` | `{ site, pageFingerprint, clientVersion }` | `{ schema: FormSchema \| null, status: "active" \| "none" }` |
| `POST /v1/schemas/feedback` | `{ schemaId?, site, pageFingerprint, mappings, outcome, siteValidatorToken, idempotencyKey }` | `{ accepted: boolean }` |
| `POST /v1/agent/map-structure` | `StructureSnapshot` | `{ mappings, pagePurpose }` |
| `POST /v1/agent/tier3-ticket` | `{ consentId }` | `{ ticket, expiresAt }` または 429 |
| `POST /v1/agent/read-with-consent`（`soroeru-pii-fallback`） | `ConsentedReadRequest` + `ticket` | `{ values }` |
| `POST /v1/telemetry/outcome` | `OutcomeEvent`（§9） | `204` |

型は `src/shared/cloud-contract.ts`（P0-4 で新規作成）に置き、拡張と Cloud Run の両方が同じ検証
関数を使う。Cloud Run 側は `cloud/`（P0-4 で新規作成。独立した npm パッケージ、Node 22、`node:http`
と最小の Google Cloud SDK のみ）に置く。新しいパッケージと依存は Issue #554 の範囲
（Cloud Run・Firestore・BigQuery・Vertex AI の採用）で承認されたものに限る。

主要な型:

```ts
type AttributeKey = string;        // 既存の正規属性キー（src/domain の属性キー一覧）に限る
type PositionalSelector = string;  // ":root" + " > *:nth-child(N)" の並び（#516 の制約）
type ScannerId = `f-${number}` | `d-${number}`;

interface FormSchema {
  schemaId: string;
  site: string;
  formKey: string;                 // サーバが site + pagePurpose + 最初の pageFingerprint から決める
  version: number;
  pageFingerprints: string[];
  fields: Array<{ anchor: PositionalSelector | ScannerId; attributeKey: AttributeKey; required: boolean }>;
  confidence: number;
  status: "candidate" | "active" | "retired";
  provenance: "official" | "gemini_structure" | "feedback";
}

interface FeedbackRequest {
  schemaId: string | null;         // null は新しい候補の提案（Tier 2 成功時）
  site: string;
  pageFingerprint: string;
  pagePurpose: StructureSnapshot["purposeHint"];
  mappings: Array<{ anchor: PositionalSelector | ScannerId; attributeKey: AttributeKey }>;
  outcome: "validated" | "failed";
  resolutionTier: "shared_schema" | "gemini_structure"; // Tier 3 は型で表せない
  siteValidatorToken: string;      // 64 桁 hex
  idempotencyKey: string;          // UUID
}

type ErrorCategory =
  | "anchor-not-found" | "anchor-ambiguous" | "classifier-conflict" | "wall-detected"
  | "lease-invalidated" | "cloud-unreachable" | "rate-limited" | "budget-exhausted"
  | "ai-invalid-response" | "corroboration-failed" | "payload-too-large" | "consent-declined"
  | "consent-timeout" | "vault-write-failed" | "unknown";
```

- アンカーは拡張がローカルで計算し（#518 の生成器と同じ方法）、サーバは文法と個人値らしさだけを検証する。
- `schemaId: null` のフィードバックは、`(site, pagePurpose, pageFingerprint)` が同じ candidate を
  探し、なければ新しい `candidate` を作る（同じ `mappings` でなければ別の候補として扱う）。

`validatorKey` は拡張インストールごとのランダム値（256 bit、vault に暗号化保存、ユーザーが
再生成可能）で、**送信しない**。拡張は `siteValidatorToken = HMAC-SHA-256(validatorKey, site)` を
計算して送る。サイトごとに値が変わるため、サーバ側で同じインストールの複数サイトのフィードバックを
結び付けられない。Cloud Run はさらにサーバ側秘密で HMAC を取ってから Firestore に保存し、同じ
サイトの検証者の重複を数えるためだけに使う。BigQuery には入れない。このトークンはデータ分類 C7
（サイト単位の仮名検証トークン、`security.md` §15.1）である。

### 7.3 Firestore のスキーマモデル

```text
formSchemas/{schemaId}
  site                // eTLD+1
  formKey             // ページ目的 + 構造フィンガープリントの族
  version             // 単調増加
  pageFingerprints[]  // #518 形式
  fields[]: { anchor: PositionalSelector | ScannerId, attributeKey, required }
  confidence          // 0..1
  validationCount
  distinctValidators
  failureCount
  status              // candidate | active | retired
  provenance          // official | gemini_structure | feedback
  createdAt / updatedAt
schemaFeedback/{schemaId}/validators/{hmac(serverSecret, siteValidatorToken)}  // 最新の結果だけ、上書き
schemaFeedback/{schemaId}/recent/{seq}   // 直近の検証結果（成功/失敗と時刻）、最大 10 件
budgets/{yyyy-mm-dd}                      // Gemini 呼び出し件数
```

`schemaId: null` の提案は、まず `candidate` の `formSchemas` 文書を作ってからその `schemaId` に
フィードバックを書くため、フィードバックの置き場所は常に存在する。

アンカーは #516 の制限（`:root` + `*:nth-child(N)` の位置セレクタ、または `f-N` / `d-N`）だけを
許す。テキスト・属性値・ID・クラスを含むセレクタは保存時に拒否する。すべての文字列フィールドに
#80 と同じ個人値らしさの検査をかけ、ヒットしたら保存しない。

### 7.4 中断・再開

- 壁、同意待ち、Side Panel の終了、ブラウザ再起動、ロックでは実行を止め、`workflowCheckpoint`
  （暗号化）に段階・Tier・未解決の属性キーだけを保存する。値、ページ内容、同意の承認状態は保存しない。
- 再開には再アンロック、タブの再バインド、URL・範囲・壁状態の再検証が必要である。Tier 3 の承認は
  引き継がない。再開後に必要なら同意を取り直す。

## 8. スキーマの学習ライフサイクル

### 8.1 状態

```text
(none) ──Tier 2 成功のフィードバック──> candidate
candidate ──昇格条件を満たす──> active
candidate ──30 日間条件未達 or 失敗率超過──> retired
active ──失敗率超過 or 新しい版が active──> retired
official（保守者がレビューしたシード） ──取り込み──> active
```

### 8.2 昇格・退役の条件（既定値、すべて設定可能）

| 定数 | 既定値 | 意味 |
| --- | --- | --- |
| `MIN_VALIDATIONS` | 5 | 昇格判定に必要な検証の最小件数 |
| `MIN_DISTINCT_VALIDATORS` | 3 | 成功を報告した異なる検証者（同じサイトの `siteValidatorToken`）の最小数 |
| `WINDOW` | 10 | 成功率を計算する直近の件数。件数が `WINDOW` 未満なら全件で計算する |
| `PROMOTE_SUCCESS_RATE` | 0.9 | 昇格に必要な、直近 `WINDOW` 件の成功率 |
| `RETIRE_FAILURE_RATE` | 0.3 | 直近 `WINDOW` 件の失敗率がこれを超えると退役（candidate・active 共通） |
| `MAX_FAILURES_TO_PROMOTE` | 3 | 累計の失敗がこれ以上なら昇格しない |
| `CANDIDATE_TTL_DAYS` | 30 | candidate が昇格せずにこの日数を過ぎたら退役 |

- 昇格: 検証件数 ≥ `MIN_VALIDATIONS`、異なる成功検証者 ≥ `MIN_DISTINCT_VALIDATORS`、直近成功率 ≥
  `PROMOTE_SUCCESS_RATE`、累計失敗 < `MAX_FAILURES_TO_PROMOTE`。
- 判定はフィードバックの書き込みと同じ Firestore トランザクションで行う。同じ `formKey` の active
  が既にあれば、同じトランザクション内で新しい版を `active`（`version` + 1）、旧版を `retired` に
  する。2 つの候補が同時に昇格しようとした場合はトランザクションの競合で片方が再試行され、
  後から確定した方が新しい版になる。

1 件の観測では active にならない。Sybil（多数の validatorKey）による汚染は完全には防げないため、
スキーマに操作権限を与えず、毎回ローカル検証してから使い、入力は確認ゲートを通す（§11.2）。

### 8.3 フィードバック

- Tier 1・Tier 2 の結果だけを送る。Tier 3 の結果はスキーマに反映しない（同意は改善用保持の同意ではない）。
- `idempotencyKey` で重複を除く。送信失敗は暗号化キューに入れ、指数バックオフで最大 3 回再送し、
  それでも失敗したら捨てる。

## 9. 改善テレメトリ

```ts
interface OutcomeEvent {
  siteId: string;                       // eTLD+1
  formId: string | null;                // schemaId、なければ null
  schemaVersion: number | null;
  operationType: "visibility_read" | "update_fill" | "withdrawal" | "registration_fill";
  resolutionTier: "shared_schema" | "gemini_structure" | "gemini_pii_consent" | "local_only";
  result: "success" | "failure" | "handoff" | "declined";
  errorCategory: ErrorCategory | null;  // 閉じた列挙
  mappingConfidenceBucket: "lt50" | "50to80" | "80to95" | "ge95" | null;
  clientVersion: string;                // semver
  schemaFingerprint: string | null;     // 64 桁 hex
  occurredAt: string;                   // 時刻は 1 時間単位に切り捨て
}
```

- 構築は `TelemetryBuilder` だけが行い、入力は列挙値・数値・既知 ID だけを受ける型にする。
  任意の文字列・オブジェクトを受ける引数を作らない。
- Cloud Run は同じ検証関数で再検証し、未知のキーがあれば 400 で破棄する。BigQuery のテーブルも
  同じ固定スキーマで、自由記述の列を持たない。
- クライアント識別子、IP、URL のパス、ラベル、値、DOM は入れない。
- `schemaFingerprint` は、そのページで照合に使った `pageFingerprint`（#518 形式の構造フィンガー
  プリント）である。本書の「構造フィンガープリント」「pageFingerprint」「schemaFingerprint」は
  すべて同じ計算方法の値を指す。
- Tier 3 のイベントも `siteId` を含む（どのサイトで構造だけでは足りなかったかはスキーマ改善に必要）。
  本文・値・属性値は含まない。
- 利用者がテレメトリを止める設定は、本番リリース前に必須とする（REQ-027）。「本番リリース」は、
  保守者の検証用ビルドとハッカソン審査用ビルド以外のあらゆる配布（Chrome Web Store を含む）を指す。
  ハッカソン審査用ビルドは、拡張内に「改善用データを Soroeru Cloud に送る」旨の表示があり、
  審査員向け手順にも同じ記載があり、フェイクデータだけを使う場合に限り既定オンにできる。本番の
  既定値は Product Owner が決めて `security.md` §15.3 に記録し、記録されるまでは既定オフとし、
  本番リリースもしない。

## 10. 静的検査とテスト

| 対象 | 方法 |
| --- | --- |
| 構造サニタイザ | フェイクの個人値を含むフィクスチャで、出力にどの値も含まれないこと（プロパティテスト含む） |
| Tier 3 ペイロード | パスワード・CVV・OTP 要素が必ず `[SECRET]` になること、16 KiB 上限、`requestedKeys` 以外を捨てること |
| ローカル照合 | 捏造値・別項目の値・マスク済みカード番号が照合を通らないこと |
| テレメトリ・フィードバック | 型と実行時検証の両方で、未知キー・自由文字列・個人値らしい文字列が拒否されること |
| 同意ゲート | 拒否・閉じる・タイムアウトで Tier 3 の送信が 0 件であること（CloudClient をモックして呼び出し回数を検証） |
| Cloud Run ログ | PII フォールバックのハンドラがロガーに本文を渡さないこと（ロガーをスパイ） |
| 昇格 | 1 件の成功で active にならないこと、閾値で昇格すること、失敗で retired になること |
| Vault | 既存 Vault v2 フィクスチャをブラウザ実装で復号、IndexedDB 置換の原子性、ロックで鍵が消えること |
| 送信先 | `egress-check` に `soroeru-cloud` 区分を追加し、注釈のない送信を失敗させる。Google Cloud SDK は `cloud/` に限り許可する |
| オフライン・クラウド支援オフ | CloudClient を到達不可・無効にし、クラウド呼び出し 0 回、Tier 1 は `formSchemaCache` から、未解決は `unknown` になること |
| 中断 | 実行中に Side Panel を閉じると、値と同意状態を含まないチェックポイントが保存され、鍵が破棄されること |
| Tier 3 承認後の失敗 | API エラーで再送せず `unknown` + ハンドオフになり、C6 に失敗が記録されること |
| E2E | 既存の E2E と同じ構成（`playwright` ライブラリ + `node --test`、開発専用。新しいテストランナーは追加しない）で拡張を読み込み、ローカルのフィクスチャサイトとモックの Cloud API で Tier 1 → 2 → 3（承認と拒否）を通す |
| スキーマ汚染 | テキスト・属性値・ID・クラスを含むアンカー、個人値らしい文字列を含むスキーマ・フィードバックが保存時に拒否されること（REQ-029） |
| リース | Side Panel ホストで、epoch・origin・tab の不一致や失効後のコマンドを Content Script が拒否すること、Service Worker 再起動でリースが失効し再バインドが必要になること |
| Tier 3 の途中失効 | 承認後・送信前、または応答待ちの間に壁・遷移・リース失効が起きたら、送信しない／応答を破棄すること |
| マスクの位置 | `readRegionMasked` の結果に未マスクの C0 フィクスチャ値が含まれないこと、Side Panel の再検査で未マスクを検出したら送信しないこと |
| 予算・レート制限 | 予算超過・429 で Tier 2・3 がハンドオフになること、期限切れ・署名不正のチケットを fallback サービスが拒否すること |
| vault の同時利用 | Web Lock を取れない 2 つ目の Side Panel がアンロックできないこと |
| CSP と KDF | 拡張の CSP で `hash-wasm` の Argon2id が動くこと、拡張での KDF 所要時間を記録すること（手動） |
| 手動 | 実際の Cloud Run と Gemini でデモシナリオを通し、Cloud Logging（リクエストログ除外の確認を含む）・Trace・BigQuery・Firestore に本文・値・IP がないことを目視確認。壁でのハンドオフも実ブラウザで確認（`manual-test.md` に追加） |

## 11. 主要な判断と代替案

### 11.1 #514 との関係

#514 は「利用者が設定した AI プロバイダに、Visibility 収集のたびに、パスワード・CVV を含む
ページ全体を送る」方針である。#554 はこれを次のように置き換える。

- AI の送信先は Soroeru の Cloud Run を経由した Gemini に一本化する（目標構成）。
- 生の値を送るのは Tier 3 だけで、フォールバックごとの明示同意を要する。
- C0（パスワード、CVV など）は同意があっても送らない。
- 現行 Electron 実装の #514 経路と Anthropic / OpenAI アダプタは、移行が終わるまでの既存実装として
  残す。拡張には移植しない。

代替案: (a) #514 をそのまま拡張に移す — 不採用。共有スキーマで解決できる大半のページでも生値を
送り続けることになり、Issue #554 の境界に反する。(b) Tier 3 を設けない — 不採用。構造だけでは
読めないページで台帳が埋まらず、Issue の要求 6 を満たさない。(c) 利用者持ち込みの Gemini API キー
を拡張から直接呼ぶ — 不採用。ペイロード検証・ログ方針・PII 経路の分離を Cloud Run で強制できない。

### 11.2 スキーマ汚染への対策

代替案として「保守者のレビュー後のみ active」も検討した。ハッカソン期間と学習ループの実証には
重すぎるため、自動昇格を既定にし、汚染の影響を「スキーマは権限を持たない」「毎回ローカル検証」
「入力は確認ゲート」で限定する。センシティブなカテゴリ（`security.md` §8.1）のサイトは、本番前に
保守者レビューを必須にするかを再検討する。

### 11.3 Cloud Run の構成

- **PII フォールバックを別サービスにする**: 1 つのサービスでルートごとにログ設定を変える案は、
  ミドルウェアや依存ライブラリのログ・トレースが本文を拾う危険を設定だけで防ぐことになり、権限
  （Firestore・BigQuery へのアクセス）も分けられないため不採用。
- **`cloud/` を独立したパッケージにする**: ルートの `package.json` に Google Cloud SDK を入れる案は、
  拡張・Electron のビルドとサプライチェーン検査の対象を広げるため不採用。npm workspaces は
  ビルド構成の変更になるため採用せず、`cloud/` は自身の `package-lock.json` を持つ。

### 11.4 Cloud Run のフレームワーク

Express などを追加せず `node:http` と小さなルータにする。エンドポイントが 5 つで、依存を増やす
理由が乏しいため。

## 12. 実装 Issue の分割と依存関係

P0 はハッカソン提出（2026-10-15）までの必須経路である。

| # | Issue | 内容 | 依存 |
| --- | --- | --- | --- |
| P0-1 | #556 | 暗号処理のブラウザ移植と `VaultPersistence` 抽象 | — |
| P0-2 | #557 | IndexedDB 永続化と Side Panel の vault セッション（MV3 の鍵寿命） | P0-1 |
| P0-3 | #558 | Side Panel 実行ホストと拡張内メッセージ契約（デモ経路から Native Messaging を外す） | P0-2 |
| P0-4 | #559 | クラウド API 契約（`src/shared/cloud-contract.ts`）と Cloud Run 基盤・デプロイ | — |
| P0-5 | #560 | Firestore Form Schema Registry と Tier 1 解決 | P0-3, P0-4 |
| P0-6 | #561 | Tier 2 構造のみ Gemini 対応付け | P0-5 |
| P0-7 | #562 | Tier 3 同意ゲートと PII フォールバック専用エンドポイント | P0-6 |
| P0-8 | #563 | 型付き改善テレメトリと BigQuery | P0-4 |
| P0-9 | #564 | 送信先・個人値の静的検査の更新 | P0-4 |
| P0-10 | #565 | Tier 1 → 2 → 3 のデモ E2E と手動テスト手順 | P0-5〜P0-8 |
| P1-1 | #566 | スキーマのライフサイクル（candidate → active → retired）と検証の集計 | P0-5 |
| P1-2 | #567 | オフライン動作とクラウド書き込みの再送・冪等性 | P0-5, P0-8 |
| P1-3 | #568 | テレメトリ・クラウド支援の利用者設定 | P0-8 |
| P2-1 | #569 | Electron 画面の Side Panel への移植と、本番ビルドからの Electron / native host / `nativeMessaging` / 本番 Playwright の撤去（ハッカソン後、同等性確認後） | P0-10 |
| P2-2 | #570 | 利用者が選ぶ暗号化ストレージ（エクスポート・インポートの強化を含む） | P0-2 |

## 13. 未決事項

- 本番リリース時のテレメトリとクラウド支援の既定値（オン / オフ）。Product Owner がリリース前に決める。
- センシティブなカテゴリのサイトでスキーマの自動昇格を許すか（§11.2）。
- Gemini のモデル ID。設定値とし、実装時に Vertex AI の提供状況で決める。
- Electron 版 vault から拡張版への移行手順（暗号化エクスポートの取り込みを想定、P2-2 で決める）。
- 本番前に、IP 単位のレート制限を Cloud Armor / API Gateway のクォータに置き換えるか（§7.1）。
- Tier 1 の resolve とテレメトリにより、Soroeru Cloud は「ある IP からあるサイトのスキーマが
  要求された」ことを一時的に知り得る。Issue #554 が許す範囲（構造とサイト識別）だが、利用サイトの
  秘匿性を一部手放す判断である。緩和策はクラウド支援オフ（REQ-027 で本番前に必須）とリクエスト
  ログの除外。
