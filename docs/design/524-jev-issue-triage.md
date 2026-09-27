# Issue #524: Jev による Issue トリアージとルート推薦

- Issue: [#524](https://github.com/soroeru/Soroeru/issues/524)
- 状態: レビュー用の設計案。実装、外部 API 呼び出し、有料契約の追加は含まない。
- 基準: `origin/main` の `9c34ef3`。外部仕様の確認日: 2026-09-27。
- 関連方針: [architecture §13](../architecture.md#13-multi-agent-orchestration-architecture)、[requirements §2](../requirements.md#2-product-principles)、[security §6](../security.md#6-network-and-external-services)。

## 1. 目的と範囲

Issue の内容からリスクと作業規模を別々に推定し、検証済み worker route の選択を支援する。
Jev は候補を作り、オーケストレーターが採否を決め、既存の決定的ポリシーが実行可能性を検証する。
Project の Priority、依存関係、release milestone、レビュー回数、同時実行上限は変更しない。
Project の Size は書き戻さず、起票時に Size を設定する運用も再導入しない。

本 Issue の成果物はこの設計である。
実装の分割と依存関係は §10 に示す。
アプリの AI provider、vault、Visibility の収集処理、並列 analyst モードの実装は対象外である。

## 2. 現状と接続位置

[`project-issue-roles.mjs`](../../scripts/project-issue-roles.mjs) の `selectExecutionMode` は `riskCategory` がなければ `low`、Size がなければ `M` として扱う。
現行の Project 取得から実行グラフまでの通常経路には、Issue 内容から riskCategory を設定する処理がない。
[`project-issue-modes.mjs`](../../scripts/project-issue-modes.mjs) は high/critical に対して direct-review を候補から外し、medium では `modePreferencesFor` が planning を優先する。
したがってリスクを候補の並べ替えだけに使わず、`selectExecutionMode` の入力に渡す必要がある。

実際の role program は [`project-issue-graph.mjs`](../../scripts/project-issue-graph.mjs) の `assignRoutesNode` が呼ぶ `ensureRoleState` で作られる。
この処理は現在 Dynamic assignment の `interrupt()` より前に走り、既存 roleState があればそれを再利用する。
採否を待たずに role program を確定すると、後から high と判定しても planner を挿入できない。
実装時は次の順序へ変更する。

```text
build_runnable_plan
  → refresh_triage_routes（新設。CLI で今回の候補をモデルごとに再検証）
  → prepare_triage（新設。現在 dispatch 可能な Issue だけを処理）
  → resolve_triage（新設。初回 role program 作成前に採否を確定）
  → assign_routes（ensureRoleState → 既存のルート選択 interrupt）
  → dispatch_worker
```

`prepare_triage` は非同期処理を持つ専用 node とし、再実行される `interrupt()` 内にネットワーク呼び出しを置かない。
本文取得と API 通信は別プロセスの新規 `scripts/project-issue-triage.mjs` が所有し、グラフには検証済みの閉じた出力だけを返す。
[`project-issue-orchestrator.mjs`](../../scripts/project-issue-orchestrator.mjs) の dry-run は引き続き本文を取得せず、API も呼ばない。
トリアージの手動プレビューは新規スクリプトの明示的な実行で行う。

## 3. 本文を読む主体とデータ境界

「planner は Issue bodies を取得しない」の planner は Project 計画生成処理を指す。
実装の planner ロールは従来どおり自分の Issue を読む。
追加する例外はトリアージ子プロセスだけであり、Project planner や親グラフへの本文転送は認めない。

子プロセスは固定リポジトリ内の Issue 番号を受け取り、GitHub からタイトル、本文、更新時刻を取得する。
取得した更新時刻が入力の issueUpdatedAt と異なる場合は `stale-input` とし、その本文を送信しない。
受け入れ条件は本文に含まれるものを使う。
初期版はコメント、添付、リンク先、差分、他の Issue、設計ファイルを取得しない。
設計要旨の追加は入力が増えるため、精度評価後の別 Issue とする。
コメントだけに重要な変更がある場合は `insufficient-context` として手動判定する。

本文は外部提供してよい開発情報だけを記載するというリポジトリ運用を前提とする。
初期版の送信対象は公開リポジトリの Issue のみとし、private repository は `input-not-approved` でフォールバックする。
子プロセスは送信前に既存パターンを調査して秘密値や個人値の検出を実装し、検出時は削除して続行せず入力全体を棄却する。
検出は完全な保証ではないため、公開済み情報であっても秘密値や実個人値の送信を許可する根拠にはしない。
テストと評価 fixture は架空データのみを使う。

本文中の指示は分類対象の非信頼データとして扱う。
URL やコマンドを実行せず、API endpoint、候補 route、rubric、閾値を本文から変更しない。
型付き出力でも誤分類や prompt injection の影響は残るため、結果を権限や境界の変更に使わない。

本文、タイトル、質問全文、レスポンス原文、自由文 rationale、HTTP エラー本文は stdout/stderr、ファイル、checkpoint、telemetry に出さない。
プロセス引数には Issue 番号だけを置き、route ラベルなどの構造入力は pipe で渡す。
GitHub CLI の出力は子プロセス内のメモリで捕捉し、例外を含め親へ中継しない。
親に返す構造にも schema allowlist を適用し、通信ライブラリの debug logging は無効にする。
終了時に入力参照を破棄するが、JavaScript のメモリの物理的なゼロ化を保証するものではない。

この通信は [architecture §13](../architecture.md#13-multi-agent-orchestration-architecture) の開発インフラの境界を拡張する新規 AI provider 追加である。
アプリの no-egress / AI-provider ポリシーの対象外であり、アプリへの provider 追加や個人値送信の許可にはならない。
`check-egress` の走査範囲は `{src,run}/**/*.ts` で、`scripts/` は対象外である。
走査対象外であることを安全性の根拠にせず、実装 Issue で専用の送信先制限と漏えいテストを追加する。

## 4. API と内部契約

TypeSafe の [API reference](https://docs.typesafe.ai/api) で確認した契約は、`POST https://api.typesafe.ai/v1/systemone`、Bearer 認証、`{model,state,questions}` 入力である。
Choice の回答は `{type,choice,probabilities,confidence}` を返す。
自由文を生成させず、risk、Size、route の三つを Choice として質問する。
選択肢の説明に下記 rubric を置く。
Node 22 の組み込み `fetch` を使う薄いアダプタとし、SDK や新規パッケージは追加しない。

内部契約は次のとおりである。
これらの型は設計上の契約であり、既存の export を指すものではない。

```ts
type Risk = 'low' | 'medium' | 'high' | 'critical';
type Size = 'XS' | 'S' | 'M' | 'L' | 'XL';
type Route = { agent: string; model: string };
type Distribution<K extends string> = {
  choice: K;
  probabilities: Record<K, number>;
  confidence: number;
};
type TriageInput = {
  issue: number;
  issueUpdatedAt: string;
  routes: Route[]; // 現在の検証済み pool のラベルのみ
  policyVersion: 'triage-v1';
  model: string; // 設定済みの固定 model ID
};
type FallbackReason =
  | 'disabled' | 'missing-key' | 'provider-unavailable'
  | 'input-not-approved' | 'sensitive-input' | 'input-too-large'
  | 'fetch-failed' | 'stale-input' | 'timeout' | 'cancelled'
  | 'auth-failed' | 'rate-limited' | 'provider-error'
  | 'invalid-response' | 'budget-exhausted' | 'insufficient-context';
type TriageResult = {
  issue: number;
  issueUpdatedAt: string;
  policyVersion: 'triage-v1';
  routeSetHash: string;
} & (
  | { status: 'fallback'; reason: FallbackReason }
  | {
      status: 'recommended'; model: string;
      risk: Distribution<Risk>;
      size: Distribution<Size>;
      route: Distribution<string>; // r0..rN と abstain のみ
      routeMap: Record<string, Route>; // abstain は含まない
      disposition: 'review-required' | 'usable';
    }
);
type TriageDecision = {
  issue: number;
  issueUpdatedAt: string;
  policyVersion: 'triage-v1';
  routeSetHash: string;
  action: 'accept' | 'override' | 'fallback';
  riskCategory?: Risk;
  size?: Size;
  preferredRoute?: Route;
  reason: 'accepted' | 'domain-review' | 'insufficient-context'
    | 'route-unavailable' | 'legacy-fallback';
};
```

risk の rubric は、low が可逆で局所的な変更、medium が複数責務や契約にまたがる変更、high が個人値、egress、暗号、認証境界、不可逆操作の経路変更、critical が複数の安全境界にまたがり回復困難な影響を持つ変更とする。
緊急度をリスクに読み替えず、Size が小さい安全性変更も high に分類する。
Size は XS が文言など単一の局所変更、S が単一責務、M が複数ファイルの一機能、L が責務境界をまたぐ設計変更、XL が段階分割を要する変更とし、速度や金額の推定には使わない。
判定不能は低リスクの意味にせず、分布と `disposition` で表す。

route の候補は安定ソートした `{agent,model}` を `r0..rN` に写像し、`abstain` を追加する。
候補は上限 32 件とし、超過時は route 質問を見送り、内部の route を `{choice:"abstain", probabilities:{abstain:1}, confidence:0}`、routeMap を空にする（risk と Size は評価できる）。
これは API の回答ではなく、推薦を棄権したローカル値である。
ラベルだけからモデル能力を実証したとはみなさず、同等または未知なら abstain を選ぶ rubric とする。
rankedRoutes は確率順にローカルで導出し、同率では安定ソート順を使う。
初期版は実装担当の推薦だけを行い、planner と reviewer は既存の distinctness 規則で選ぶ。

レスポンスは質問と回答のキー集合、Choice 型、選択肢集合、有限な確率と confidence の範囲 `[0,1]`、確率和（許容誤差 `1e-6`）、choice が最大確率の候補であることを検証する。
model は要求した固定 ID と一致する必要がある。
未知フィールドを内部状態へコピーせず、未知の route ID、欠落、NaN、不正 JSON は `invalid-response` とする。
レスポンスは 64 KiB までストリーム読取で制限する。
本文と質問を含むリクエスト全体も UTF-8 で 24 KiB までとし、超過時は途中切断による誤分類を避けてフォールバックする。
この上限は API の最大値ではなく、本システムのコストと待ち時間の制限である。

## 5. 設定と障害処理

新規の `run.triage` 設定を `project-issue-config.mjs` の allowlist に追加する。
既定値は `{mode:'off', model:'jev-1.13.0', maxRequests:20}`、mode の候補は `off | shadow | assisted` とする。
CLI の `--triage off|shadow|assisted` が YAML を上書きし、変更は run 単位とする。
鍵は環境変数 `TYPESAFE_API_KEY` から子プロセスだけが読み、YAML、checkpoint、CLI 引数に置かない。
親が起動する通常の worker の環境からこの変数を除去する。
`run.unavailableAgents` / `run.unavailableModels` は worker pool 専用のままにし、Jev の不調は `triage.providerUnavailable` という run 内状態で区別する。

[Models](https://docs.typesafe.ai/models) にある `jev-1.13.0` を評価対象として固定する。
動く alias は評価と本番の再現性を損なうため使わない。
バージョン変更は再評価する。
契約やアカウントの送信データ保持条件の確認は初回有効化の実装 Issue の完了条件とし、ZDR を既定の保証とはみなさない。
本設計のレビュー承認だけでは API を有効化しない。

| 条件 | 処理 |
| --- | --- |
| off、鍵なし、private、秘密値検出、入力上限超過 | 通信せず理由コードを返す |
| GitHub 取得失敗 | 本文をログに出さず `fetch-failed` |
| 1 回の要求 | 5 秒で abort。redirect は拒否し endpoint を固定 |
| 接続失敗、timeout、5xx（529 を除く） | 自動再試行なし。`provider-error` または `timeout` |
| 429 / 529 | 当該 run の provider を unavailable にし、再試行せず手動運用へ戻す |
| 401 / 403 | `auth-failed`。当該 run は以後呼び出さない |
| その他の非成功、schema 違反 | `provider-error` / `invalid-response`。生のエラーを残さない |
| 中断 | 子プロセスと要求を abort。未完了の推薦を採用しない |
| pool が空 | 既存の `no-worker-route-available` で停止。Jev は架空の代替を作らない |

自動 retry はゼロとする。
安価な補助判断のために orchestration を待たせず、次 run で再評価する。
1 run の API 要求は最大 20 回、同時通信は 1 件とし、要求前に checkpoint に消費枠を記録する。
中断が送信前だったか不明でも枠は戻さず、再起動による無制限課金を防ぐ。
子プロセス全体にも GitHub 取得を含む 10 秒の期限を置き、超過後は従来運用を継続する。
費用は実測 input token 数と確認済み単価から別々に集計し、token 数が取得できない場合は unavailable と記録する。

## 6. 判定の採用と実行モード

`shadow` では結果と既存の選択を比較表示するだけで、risk、Size、route の実行値を変えない。
`assisted` では `resolve_triage` の interrupt が構造化推薦を提示し、オーケストレーターが `TriageDecision` を返す。
同意はユーザーへの毎回の確認ではなく、親エージェントによる明示的な採用である。
`autoAssign` はその同意の代用にならず、採否がない場合は assisted でも既存入力による fallback を選ぶ。

[Confidence](https://docs.typesafe.ai/confidence) は回答分布から計算した指標であり、「この Issue が正しい確率」とは同一視しない。
初期の暫定値として、各質問で confidence が `0.7` 未満、または最大の二候補の確率差が `0.2` 未満なら当該質問を要確認とする。
risk または Size が要確認なら `disposition=review-required` とし、`accept` は拒否する。
親は内容を確認できる狭いトリアージ調査または worker 側の調査を用いて `override` を明示するか、従来運用へ fallback する。
route だけが要確認または abstain の場合は risk/Size を採用できるが、preferredRoute は設定しない。

採用後の入力は次の優先順位で作る。

1. `accept` は推薦値から risk と Size を埋める。`override` は risk と Size を必須とし、reason を閉じた値で残す。`fallback` は推薦値を実行入力に混ぜない。
2. 既存の明示的 risk と採用した risk の高い方を `effectiveRisk` とする。Jev に既存の安全判断を引き下げさせない。
3. 既存の Project Size と採用した Size の大きい方を `effectiveSize` とする。Project Size が未設定で推薦を採用した場合は推薦 Size を使い、両方なければ現行の `M` とする。
4. `dependencies` と `changeScopeCount` は既存値を保ち、`selectExecutionMode({...item, riskCategory:effectiveRisk, size:effectiveSize})` へ渡す。現在の dependencyDepth は実際には直接依存の件数であり、本 Issue では推移的深さへの変更をしない。
5. 選択結果は `determineEligibleModes` と `rankAndSelectMode` の制約内とし、未実装の `parallel-analysis-implement-review` は選ばない。high/critical は現状の `plan-implement-review` に進む。

明示的な `item.executionMode` / `item.roleProgram` の既存 override も、採用後の eligible modes と実装済み program に照らして検証する。
矛盾する direct-review は採用せず、`triage-mode-conflict` として構造化採否を取り直す。
`--single-worker` は role program を使わないため shadow のみとし、assisted 指定時は `triage-single-worker-shadow` を表示する。

未設定、障害、棄却時は既存の Size ベースのモード選択と手動ルーティングをそのまま使う。
この場合に Size 未設定を自動的に high に変える設計ではないため、従来の見逃しの可能性は残る。
表示には必ず fallback 理由を付け、親が run 内の明示的 risk/Size override を渡せるようにする。

## 7. ルーティングと再開

Jev に選択させるたびに、直前の `refresh_triage_routes` で CLI のモデル一覧と実行可否を確認する。
Astra や Fable など特定モデルの契約、有効化、利用可能性を固定の前提にしない。
`loadOrRefreshCapabilities({refresh:true,...})` 相当の discovery を使い、前回 run の cache、同一 CLI バージョン、別モデルの成功だけを根拠に候補を採用しない。
同じ評価バッチ内の Issue は一度の確認結果を共有できるが、次の評価バッチ、再選定、handoff では再確認する。
この確認は Jev 子プロセスの 10 秒期限とは別で、既存の capability probe の時間制限に従う。

既存の Claude adapter は exact selector/model ごとに headless probe を実行するが、Codex adapter は最初の候補の probe 成功で他の候補も登録する。
後者はこの要件を満たさないため、後続の A0 で Codex を含む全 worker adapter をモデル単位の検証にそろえる。
候補は CLI が返したものに限り、架空の固定リストを補わない。
モデル単位の利用資格、quota、headless 実行可否を確認できない候補は除外する。
probe が別モデルへ代替されたことが分かる場合も成功扱いにせず、確認できた canonical model と selector の対応だけを採用する。
probe は既存の隔離された作業ディレクトリと架空入力を使い、Issue 内容を渡さない。

確認後に親 runtime と run の unavailable 指定を適用して `workerRoutes` を再構成し、そのラベルだけを Jev に渡す。
selector と CLI パスは capability record に保持し、Jev には渡さず、回答のラベルを現在の検証済み record へ戻して dispatch する。
選択済み route は dispatch 直前にも exact model で確認し、使えなければ推薦を破棄する。
再選定が必要な場合は pool を再検証してから Jev を再度呼ぶか、API 予算切れなら検証済み pool から手動選択する。
同一 dispatch 機会での自動再選定は 1 回までとし、再失敗時は構造化エラーで待機して、同じモデルを無制限に再試行しない。
API 障害による手動 fallback も利用不可モデルを復活させず、pool が空なら従来どおり停止する。


採用した preferredRoute は `assignRoleRoutes` の implementer 候補順の先頭に置く提案に変換する。
Dynamic assignment には推薦、分布、採否を追加表示するが、最終的な route は現在の `workerRoutes` に属する必要がある。
親 runtime の除外、unavailable 指定、reviewer の distinctness、単一路線時の記録付き縮退を保持する。
使用量の予測や budget snapshot は初期割当の入力に追加しない。

checkpoint の新規 `triageByIssue` は `TriageResult` と `TriageDecision` の allowlist 射影、評価時刻、消費枠だけを保存する。
Issue 本文や任意の rationale を保存する列は作らない。
routeSetHash はソートした agent/model ラベルから計算し、Issue 更新時刻と policy/model version を併せて鮮度判定に使う。
既存 checkpoint にこの欄がない場合は mode=off と扱い、実行済み program を変更しない。

初回 dispatch 前に Issue 更新時刻と pool を再確認する。
Issue 内容、policy、model の変更で推薦と採否を無効化し、枠内なら再評価する。
pool だけの変更では risk/Size の採否を保持し、route 推薦を破棄して現在の pool から手動選択する。
変更の検出を再評価ループにせず、1 dispatch 機会につき再評価は 1 回までとし、再び変われば `stale-input` で fallback する。

role program 開始後は途中に planner を挿入せず、完了済み role、review budget、worktree を維持する。
handoff は現在の役割と pool で既存の回復処理を使い、初期 implementer 推薦を reviewer や代替 route に流用しない。
実行中の Issue 編集は本機能だけでは継続監視しないため、スコープ変更を発見した worker は既存の停止と再計画の運用に従う。

## 8. #517 の再発への対応

架空の回帰 fixture として「Size 未設定、個人値を AI provider に送る新しい経路、受け入れ条件に漏えい防止を含む Issue」を作る。
現行処理では risk=low、Size=M から direct-review が選ばれる。
Jev が high を推薦して親が採用した場合、Size が S/M でも `effectiveRisk=high` が `selectExecutionMode` に届き、planner → implementer → reviewer となる。
既存の direct-review override で planner を飛ばすことも §6 の検証で防ぐ。

shadow、誤分類、API 障害ではこの防止を保証できない。
親は構造化警告を見て high を手動設定できるが、採用しなければ従来の選択が残る。
この限界を隠さず、§9 の評価を満たすまで Jev を権威ある判定にしない。
#517 で観測された worker のクラッシュや timeout は別の問題であり、planning や route 推薦によって解消すると約束しない。

## 9. 精度評価と検証

初期リリースは opt-in の shadow とする。
人間がラベル付けした架空 Issue を最低 100 件用意し、そのうち 30 件以上を high/critical とする。
日本語中心の本文、英語、混在、Size と risk の不一致、曖昧な本文、悪意ある指示、秘密値を模した入力を含める。
rubric の調整用と固定 holdout を分け、同じケースで閾値を調整して合格を主張しない。

risk の混同行列、high/critical の見逃し率、確率の Brier score と reliability bins、abstain 率、親の override 率を記録する。
route はモデル名の好みとの一致率だけで評価せず、既存の手動割当と、完了率、review の修正率、所要時間、取得できた正確な token 数を比較する。
障害や時期による差を明示し、母数のない route を優秀と結論しない。

assisted への移行条件は、固定 holdout の high/critical 30 件以上で direct-review への見逃しゼロ、漏えいと制約違反ゼロ、親の override の原因分析完了、Product Owner の導入判断とする。
見逃しゼロは将来のゼロリスクの保証ではなく、件数と不確実性を併記する。
自動採用はこの設計に含めず、別 Issue と追加評価を必要とする。
モデル、rubric、閾値を変えたら shadow に戻す。

| 検証層 | 必須ケース |
| --- | --- |
| アダプタ単体（HTTP fake） | 正常 Choice、未知候補、不正分布、上限、redirect、認証失敗、429/529、timeout、中断、非 JSON |
| データ境界 | fake の本文、秘密値、エラー内容が stdout/stderr/checkpoint/telemetry/dispatch payload に出ない。鍵が worker 環境にない |
| 設定と予算 | off/鍵なしで通信ゼロ、CLI 優先、run 分離、20 回上限、中断再開で予算が復活しない |
| モード結線 | #517 相当、medium、Size との矛盾、dependency 件数、changeScopeCount、明示的 mode の矛盾、single-worker |
| graph と checkpoint | 採否後に初回 program を生成、interrupt 再開で再通信しない、古い checkpoint、Issue 更新、pool 更新、program 開始後の維持 |
| ルート検証 | 評価ごとの CLI 再確認、Astra/Fable 相当の未有効モデル除外、一モデルの成功が他を検証済みにしない、古い cache 不使用、選択後の利用不可と再選定上限、親除外、未検証候補の拒否、distinct reviewer、単一路線縮退、abstain、handoff で推薦を再使用しない |
| opt-in の手動試験 | 架空 Issue だけで実 API の契約、使用量、待ち時間、鍵なし fallback、shadow 表示と assisted 採否を確認 |

実装時のテストは [testing](../testing.md) と `writing-good-tests` skill に従う。
API の実呼び出しを CI の合格条件にせず、fake transport と決定的 fixture で境界を検証する。
この設計 Issue では Markdown、参照、既存コードとの整合と設計レビューを検証対象とする。

## 10. 実装 Issue の分割案

設計レビュー後に次の単位で起票する。
各 Issue の本文にこの文書を参照し、起票時の Project Size は空欄にする。

| フェーズ | 実装単位と完了条件 | 依存 |
| --- | --- | --- |
| A0 | CLI discovery と exact model ごとの実行可否確認を全 worker adapter で統一。cache だけで推薦しない refresh 経路と、未契約モデルを除外する回帰テスト | #524 の設計レビュー |
| A | 入出力 schema、独立子プロセス、設定と鍵管理、HTTP adapter、予算、データ境界テスト。既定 off。利用条件と保持条件を確認し、architecture §13 と development に開発時通信を記載 | #524 の設計レビュー |
| B | graph の refresh/prepare/resolve node と checkpoint、shadow の比較表示、既存 dry-run の Jev 無通信の保証。orchestrate skill の両コピーに本文取得の限定例外を記載 | A0 と A |
| C | 架空の評価セット、固定 holdout、risk 校正と route 比較のレポート。導入判断に必要な数値と限界を提出 | A。運用比較部分は B |
| D | assisted の採否契約、effective risk/Size、mode override 検証、Dynamic assignment の推薦、更新と再開、#517 回帰テスト。利用手順を更新 | B と C の移行条件達成 |

A/B の段階では実行判断を変えない。
D は Product Owner が評価結果を受けて選ぶ後続実装であり、本 PR の merge で自動的に有効化しない。
アプリ runtime の外部依存、production package、ユーザー設定画面には変更を加えない。

## 11. 比較した代案

| 代案 | 採否と理由 |
| --- | --- |
| Size とキーワードだけで判定 | 障害時の fallback と比較 baseline として残す。Size と安全性は別なので内容を読む補助判定を追加する |
| 親エージェントが毎回本文を読む | 不採用。本文を checkpoint や親 context へ広げず、狭い子プロセスで閉じる |
| 汎用生成モデルに自由文 JSON と理由を返させる | 初期版では不採用。閉じた Choice で十分であり、自由文の漏えい経路と解析負担を増やさない |
| SDK の追加 | 初期版では不採用。単一 endpoint に必要な timeout、検証、ログ抑制を組み込み fetch で管理する |
| Jev の低判定で既存 Size/risk を下げる | 不採用。作業規模の最適化より既存の安全判断の維持を優先する |
| 最初から自動採用 | 不採用。ソフトウェア Issue と日本語本文での精度をまだ測っていない |
| 不明なら全件 planner を必須にする | 本設計では不採用。Issue が求める従来運用への fallback を保持する。見逃しが続く場合は別の方針変更として判断する |

## 12. 受け入れ基準との対応

| #524 の要求 | この設計での決定 |
| --- | --- |
| 本文取得の例外と状態最小化 | §3 の独立子プロセスと §7 の allowlist 状態 |
| API 統合と障害時動作 | §2、§4、§5 |
| 設定と鍵 | §5 の既定 off と環境変数 |
| risk と mode の結線 | §6 の採否前置と effective 入力 |
| Dynamic assignment と追加要望（毎回 CLI でモデル可用性を確認） | §7 の都度検証、pool 内推薦、親の最終選択 |
| 精度評価と段階導入 | §9 の shadow、holdout、assisted 移行条件 |
| 新規外部依存の扱い | §3 の開発時境界と §10 の後続 Issue |
| #517 の具体例、fallback、実装分割 | §8、§5/6、§10 |
