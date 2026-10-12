# Issue #567: オフライン動作とクラウド書き込みの再送・冪等性（実装設計）

Issue: #567
親: #554（P1-2）。依存: #560（Tier 1）、#563（テレメトリ）はいずれも main にマージ済み。
後続: #568（テレメトリ設定、検証者キー再生成と未送信キュー破棄を含む）。
設計の正本: [`issue-554-extension-cloud-hybrid.md`](issue-554-extension-cloud-hybrid.md) §6.3、§8.3、§12、
[`architecture.md`](../architecture.md) §14.3。本書は現状コードとの差分と実装手順だけを扱う。

## 1. 現状（確認したコード）

| 領域 | 現状 | 根拠 |
| --- | --- | --- |
| Tier 1 オフライン | cloud 失敗時に暗号化 `formSchemaCache` を読む | `extension/resolution-orchestrator.ts` `resolveTier1`（`source === "cache"` 分岐） |
| キャッシュの鮮度 | `fetchedAt` は書かれるが読み時に使われない。30 日の上限がない | 同ファイル（`fetchedAt: Date.now()` のみ） |
| Tier 2・3 オフライン | `reachable` が false なら Tier 2 を呼ばない | `resolve()`、テスト `tests/unit/soroeru-tier2-resolution.test.ts` の `offline` モード |
| feedback キュー | 積まれるが、取り出し・送信・`attempts` 増加・破棄の処理がどこにもない | `queue` の参照は `resolution-orchestrator.ts` のみ。README も「Queue delivery ... follow-up work」と明記 |
| telemetry キュー | 種別 `telemetry` は型にあるが生産者がない | `extension/telemetry-builder.ts` は build のみで呼び出し元なし |
| クライアント再送 | `CloudClient` は自動再送しない（設計上の制約） | `extension/cloud-client.ts` ヘッダコメント |
| 冪等性（feedback） | クライアントは UUID `idempotencyKey` を付与 | `resolution-orchestrator.ts`、`src/shared/cloud-contract.ts` |
| 冪等性（サーバ feedback） | validator ドキュメントに保存された**最後の** key としか比較しない。A→B→A の再送で二重計上が起きる | `cloud/src/schema-feedback.ts` 約 L194–200 |
| 冪等性（outcome） | `OutcomeEvent` に `idempotencyKey` がない | `src/shared/cloud-contract.ts` `OutcomeEvent` |
| BigQuery 書き込み | `insertId` を付けていない | `cloud/src/telemetry.ts` `insert()` |

## 2. 方針

### 2.1 キュー配送（拡張）

- 配送ロジックは新規 `extension/cloud-delivery-queue.ts` に置く。`ResolutionOrchestrator` は解決のみに保つ。
  再試行の状態遷移（次回時刻、破棄判定）は純関数にしてユニットテストする。
- **再送はキュー層で行う。** `CloudClient` の「自動再送なし」は維持する。
- 配送の試行回数: 初回送信を 1 回目とし、失敗後の再送を最大 3 回まで。`attempts` は失敗回数を数え、
  4 に達したら破棄する。
- バックオフ: `nextAttemptAt = now + 30 s × 2^(attempts − 1)`（30 s、60 s、120 s）。定数として export する。
- 再試行対象は `cloud-unreachable` と `rate-limited` のみ。`budget-exhausted` と `ai-invalid-response`、
  契約検証エラーは再試行せず即破棄する（予算は数分で回復せず、不正応答は再送しても改善しない）。
- キュー内の項目は作成から 7 日を超えたら配送せず破棄する（Issue の「古い結果がスキーマ評価をゆがめる」リスク対策）。
- 配送は直列・1 パスあたり上限件数（例: 10 件）。`idempotencyKey` は再送のたびに再利用し、再生成しない。
- 実行タイミング: 解決の成功（`reachable` 判定の直後）と Side Panel の unlock 時。ネットワーク専用のタイマーは持たない。
- 競合対策: 配送と enqueue はどちらも `cloudSettings` を読み書きする。配送は書き込み直前に最新の設定を再読み込みし、
  配列の添字ではなく `idempotencyKey` で項目を除去する。これで並行 enqueue を失わない。
- `cloudAssistEnabled` が false のときは送信しない。キューの破棄は #568 の責務とし、本 Issue では触らない。

### 2.2 オフライン読み取り

- Tier 1 のキャッシュ分岐に鮮度判定を追加する: `Date.now() − fetchedAt > 30 日` のエントリは使わない。
  `status !== "active"` の既存フィルタはそのまま残す。
- オンライン復帰時の再検証: 既存の `resolve` は cloud 有効時に毎回先に呼ばれ、成功すればキャッシュを置き換える。
  追加の仕組みは不要。テストで「オフライン→オンライン」の遷移を確認する。
- Tier 2・3 はオフライン時に呼ばれないことを、Tier 3（#562）の経路も含めて明示的にテストする。

### 2.3 サーバ冪等性

- **feedback**: 最後の key との比較をやめ、`schemaFeedback/{schemaId}/receipts/{idempotencyKey}` の受領記録で判定する。
  同じトランザクション内で記録し、既存なら `accepted: true` を返して計数を変えない。validator による既存の重複排除はそのまま残す。
- **outcome**: `OutcomeEvent` に `idempotencyKey`（UUID）を追加し、`validateCloudRequest("outcome")` で検証する。
  `BigQueryTelemetryWriter.insert` は `insertId` にこの値を渡す。BigQuery の列は追加しない（§15.3 の許可リストを変えない）。
- 応答形は変えない（feedback は `{ accepted }`、outcome は 204）。

### 2.4 契約と静的検査

- `src/shared/cloud-contract.ts` の変更は `extension` と `cloud` の両方に効く。#564 の静的検査と `check-egress` を通す。

## 3. 変更ファイル

| ファイル | 変更 |
| --- | --- |
| `extension/cloud-delivery-queue.ts`（新規） | 配送、バックオフ、破棄、鮮度判定の純関数と配送ループ。非 OK HTTP レスポンス（4xx を含む `schema-retired`、`schema-not-found` 等）は `CloudClient` が `cloud-unreachable` にマップするため、MAX_ATTEMPTS 回まで再試行される。 |
| `extension/resolution-orchestrator.ts` | キャッシュの 30 日判定、解決後の配送呼び出し |
| `extension/panel/visibility-host.ts` | `VisibilityHostOptions` に `deliveryClient` を追加し、セッションアンロック時に `deliverQueue` を fire-and-forget で呼び出す（§2.1 の unlock トリガー） |
| `extension/sidepanel.tsx` | `VisibilityHost` に `deliveryClient: cloudClient` を追加 |
| `src/domain/entities.ts` | `CloudQueueItem.nextAttemptAt?: number`（任意項目で互換を保つ）。新規エンキュー時は付与しない（`undefined` = 即時配送対象）；`isDue` はこの慣例に従い、`nextAttemptAt` が absent の場合は due とみなす。`schemaVersion` の要否は既存規約に合わせて確認 |
| `src/shared/cloud-contract.ts` | `OutcomeEvent.idempotencyKey` の追加と検証 |
| `cloud/src/schema-feedback.ts` | 受領記録による重複判定 |
| `cloud/src/telemetry.ts` | `insertId` の設定 |
| `extension/README.md` | 「Queue delivery ... follow-up」の記述を更新 |
| `docs/manual-test.md` | ネットワーク遮断時の手順（キャッシュ利用、再送、復帰）を追加 |

## 4. テスト

- 新規 `tests/unit/soroeru-cloud-delivery-queue.test.ts`: フェイククロックで次回時刻と破棄条件を確認する。
  4 回送信で破棄すること、`budget-exhausted` は即破棄すること、7 日超の項目は送らないこと、
  再送で `idempotencyKey` が変わらないこと、並行 enqueue が失われないこと。
- `tests/unit/soroeru-tier1-resolution.test.ts`: 30 日超のキャッシュを使わないこと、オフライン→オンラインで
  `source` が `cloud` に戻りキャッシュが更新されること。
- `tests/unit/soroeru-tier2-resolution.test.ts`: オフライン時に `mapStructure`、`readWithConsent`、Tier 3 チケットが
  呼ばれないこと。
- `cloud/tests/schema-feedback.test.mjs`: 同じ key の再送は計数を変えないこと、A→B→A の再送で二重計上されないこと。
- telemetry: `insertId` に `idempotencyKey` が渡ること（BigQuery クライアントをスタブ化）。
- 実行: `npm run format`、`npm run lint`、`npm run typecheck`、`npm test`、`npm run release:check`（契約と送信経路の変更のため）。
  `docs/manual-test.md` の該当手順も実施する。

## 5. リスクと残課題

- `telemetry` キューは生産者が未配線のため、本 Issue では契約と配送の経路だけが完成する。実送信は #563 の配線後になる。
- BigQuery の `insertId` による重複排除は短い時間窓だけで保証される。長期の重複排除は Firestore の受領記録が必要で、
  コストと複雑さが増す。
- 受領記録は増え続けるため、Firestore の TTL（`expiresAt`）が必要になる。TTL ポリシーは infra の変更で、
  Terraform 側の作業を伴う。
- Size は S と見積もられているが、契約、サーバ、拡張の 3 層に跨る。分割するなら「拡張の配送とキャッシュ鮮度」と
  「サーバの冪等性と outcome key」の 2 つに分けられる。

## 6. 未決事項（Product Owner の判断）

1. 受領記録の方式（推奨: 受領記録で判定する）か、最後の key 比較を残すか。
2. テレメトリの重複排除を BigQuery `insertId` の短期保証で受け入れるか（推奨: 受け入れて文書化する）、
   長期保証のために Firestore 記録を追加するか。
3. 再送の既定値（推奨: 初回 + 再送 3 回、基準 30 秒、2 倍、7 日の寿命）を確定してよいか。
4. Size を S のままにするか、2 PR に分けるか（推奨: 分ける）。

## 7. 実装手順（Issue 実装時）

1. `src/domain/entities.ts` と `src/shared/cloud-contract.ts` の型と検証を追加し、テストを先に書く。
2. `extension/cloud-delivery-queue.ts` を純関数と配送ループで実装する。
3. `resolution-orchestrator.ts` にキャッシュ鮮度判定と配送呼び出しを組み込む。
4. `cloud/src/schema-feedback.ts` と `cloud/src/telemetry.ts` を更新する。
5. テスト、ドキュメント（README、manual-test）、品質ゲートを実行する。
