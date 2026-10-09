# Issue #537: Jev トリアージの評価と RouteEvidence

- Issue: [#537](https://github.com/soroeru/Soroeru/issues/537)
- 設計: [#524 Jev による Issue トリアージとルート推薦](524-jev-issue-triage.md) §4、§9、§10 フェーズ C
- 評価日: 2026-10-09。基準: `origin/main` の `202baf1`。
- 状態: **評価ハーネスと架空データセットは完成。Jev の実測、RouteEvidence の実測、shadow 運用比較は未測定。**
  assisted 移行条件は未達であり、フェーズ D（#538）の導入を許可しない。

## 1. 結論

| 項目 | 結果 |
| --- | --- |
| Jev（`jev-1.13.0`）の分類精度 | **未測定**。評価時の環境に `TYPESAFE_API_KEY` がなく、有料の実 API 呼び出しは行っていない |
| 比較用ベースライン（キーワード＋Size 規則） | 測定済み（§4）。holdout の high/critical 見逃し率 65.9%、direct-review 見逃し 1 件 |
| RouteEvidence | **未測定**。各 CLI の実モデルで 40 タスクを実行する必要があり、利用枠と予算の判断が必要 |
| shadow と手動割当の比較 | **母数なし**。B（#536）のマージ直後で、保存された shadow 実行の run summary がない |
| assisted 移行条件 | **未達**（§6） |
| Product Owner の導入判断 | **保留**（§7） |

ベースラインの数値は Jev の性能ではない。
Jev の性能を推定値で補わず、実測するまで未測定として扱う。

## 2. 成果物

| 成果物 | 場所 |
| --- | --- |
| 架空評価データセット（調整用と固定 holdout） | `tests/fixtures/jev-triage-eval/dataset-v1.json` |
| 分類評価ハーネス、指標、assisted ゲート、shadow 比較 | `scripts/project-issue-triage-eval.mjs` |
| route ベンチマークと RouteEvidence 生成 | `scripts/project-issue-route-benchmark.mjs` |
| RouteEvidence の型検証 | `normalizeRouteEvidence`（`scripts/project-issue-triage-contract.mjs`） |
| 計算と保存境界のテスト | `tests/unit/project-issue-triage-eval.test.mjs` |
| 実行手順 | [development.md の該当節](../development.md#jev-triage-evaluation-and-routeevidence) |

## 3. データセットと再現条件

| 固定値 | 値 |
| --- | --- |
| datasetVersion | `jev-triage-eval-1.0.0` |
| rubricVersion | `triage-rubric-524-v1`（設計 §4 の risk/Size rubric。子プロセスの質問文と同一） |
| policyVersion | `triage-v1` |
| model | `jev-1.13.0`（alias を使わない） |
| benchmarkVersion | `route-bench-1.0.0`（タスク生成は決定的） |
| ラベル状態 | `agent-proposed`（人間による確認待ち） |

| 分割 | 件数 | 分類対象 | high/critical（分類対象） | 偽の秘密値 |
| --- | --- | --- | --- | --- |
| tune | 50 | 47 | 18 | 3 |
| holdout | 84 | 79 | 41 | 5 |
| 合計 | 134 | 126 | 59 | 8 |

各分割に日本語、英語、混在の本文と、Size/risk の不一致、曖昧な入力、prompt injection、架空の秘密値、#517 相当を含める。
検証関数はこれらの最低件数と、偽の秘密値を含むケースだけが送信前の検出に掛かることを毎回確認する。
本文はすべて架空であり、実 Issue や個人値を含まない。
rubric や閾値の調整は tune だけで行い、holdout を調整に使わない。

ラベルは実装担当エージェントが設計 §4 の rubric に従って付けた提案値である。
Issue の受け入れ条件にある人間によるラベル確認は未完了であり、ゲートの `labels-human-confirmed` は pending のままとする。
確認後は `labeling.status` を `human-confirmed` にし、確認者の役割と日時を記録する。

## 4. ベースラインの結果（参考）

設計 §11 で fallback と比較基準に残すとした「Size とキーワードだけで判定」を、決定的なスタブ transport として実装した。
CI と同じく外部通信なしで再現できる。
`node scripts/project-issue-triage-eval.mjs --split holdout --now 2026-10-09T00:00:00Z`

| 指標 | tune | holdout |
| --- | --- | --- |
| risk 正解率 | 48.9% | 38.0% |
| risk Brier score | 0.709 | 0.825 |
| Size 正解率 | 68.1% | 69.6% |
| high/critical を low/medium と判定 | 10/18（55.6%） | 27/41（65.9%） |
| direct-review 見逃し | 0 | 1（H081） |
| 判定保留（fallback と要確認） | 74.5% | 67.1% |
| 模擬 override 率（採用可能な回答のうちラベル不一致） | 41.7% | 57.7% |
| 偽の秘密値の送信 | 0/3 | 0/5 |
| 送信先、model、質問集合の制約違反 | 0 | 0 |

holdout の risk 混同行列（行がラベル、列が判定）は次のとおり。

| | low | medium | high | critical |
| --- | --- | --- | --- | --- |
| low | 17 | 1 | 0 | 0 |
| medium | 16 | 2 | 2 | 0 |
| high | 2 | 22 | 5 | 1 |
| critical | 0 | 3 | 2 | 6 |

H081 は「利用規約の自動化禁止条項を警告のみにする」という小規模で高リスクな架空 Issue である。
ベースラインは low/S を確信度付きで返し、採用すれば direct-review に進む。
これは設計 §8 が想定する「小さい安全性変更の見逃し」の典型で、キーワード規則だけでは防げないことを示す。
#517 相当の 5 件はすべて high と判定されたが、Size の確信度が低く要確認となった。

ベースラインの信頼度は固定値（0.6/0.75）であり、reliability bins はベースラインの較正を表さない。
Jev の実測では Brier score と bins が意味を持つ。

## 5. 評価方法の定義

分類評価は本番の `evaluateTriage` をそのまま通す。
GitHub 取得の代わりに架空の title/body を注入するだけで、秘密値検出、入力上限、固定 endpoint、redirect 拒否、応答検証は本番と同じである。
送信は 1 件ずつ行い、401/403/429/529 の後は送信しない。
実 API の評価は `--max-requests` が分割全体を賄えない場合に開始しない。

| 指標 | 定義 |
| --- | --- |
| 混同行列、正解率 | recommended の risk/Size の choice とラベルの比較 |
| Brier score | 多クラス。各候補の確率と正解の one-hot の二乗誤差の和の平均 |
| reliability bins | choice の確率で 5 区間に分け、件数、平均確率、正解率を出す |
| high/critical 見逃し率 | ラベル high/critical のうち low/medium と判定した割合 |
| direct-review 見逃し | ラベル high/critical で、採用可能（usable）な回答を採用すると `selectExecutionMode` が direct-review を選ぶ件数 |
| 未解決 high/critical | fallback または要確認で採用できず、従来の Size ベースの選択に戻る件数。ゲートには含めず残存リスクとして報告する |
| 判定保留率 | 分類対象のうち usable 以外の割合 |
| 模擬 override 率 | usable のうち risk か Size がラベルと異なる割合。原因を過小、過大、Size のみ、タグ、言語で集計する |
| 漏えい | 偽の秘密値ケースが送信された件数と、記録の allowlist 外フィールド |
| 制約違反 | 固定 endpoint、POST、redirect 拒否、固定 model、閉じた質問集合からの逸脱 |
| 費用 | 要求数と API が返した整数 token 数。単価は未確認のため金額は `unavailable` |
| 遅延 | 要求ごとの所要時間の中央値と最大値。品質指標と分けて報告する |

route は RouteEvidence で評価する。
ベンチマークは docs、local-code、cross-component、security の各 10 件の架空タスクを、CLI で都度検証した exact model ごとに一時ディレクトリで実行する。
合否はエージェントから見えない固定の検査で決める。
外へ出るのは `{kind, passed, durationMs}` だけで、プロンプト、CLI 出力、作業内容は保存しない。
CLI が要求と異なるモデルを報告した場合はそのモデルの全結果を破棄する。
比較は本番の `triageContext` と同じ除外条件（30 日超過、pool 外のモデル、benchmarkVersion の混在、10 件未満）を通し、合格率、同率なら所要時間の順に並べる。
比較可能な候補が二つ未満、または同等なら abstain とする。

shadow と手動割当の比較は、グラフの run summary の allowlist フィールドだけを読む。
完了率、レビュー修正率（reviewPasses が 2 以上）、`wallClockMs` の中央値、正確な token 合計、推薦 route と実際の割当の一致を集計する。
10 件未満は `insufficient-sample` とする。
run summary は時期や障害の情報を持たないため、比較時に実行時期と既知の障害を別途併記する。

## 6. assisted 移行条件

| 条件 | 状態 |
| --- | --- |
| Jev の実測 | 未達 |
| 固定 holdout での評価 | 達成（評価対象の分割） |
| ラベルの人間確認 | 保留 |
| holdout の high/critical で usable な判定が 30 件以上 | 未測定 |
| direct-review 見逃しゼロ | 未測定 |
| 漏えいゼロ | 未測定（ベースラインでは 0） |
| 制約違反ゼロ | 未測定（ベースラインでは 0） |
| override 原因の分析 | 保留 |
| Product Owner の導入判断 | 保留 |

ハーネスは人間の確認と判断を代行しないため、自力で `met` を返さない。
usable を 30 件以上と求めるのは、要確認ばかり返すモデルが見逃しゼロを満たしてしまうことを防ぐためである。
見逃しゼロを満たしても、41 件の標本で将来の見逃しがゼロとは言えない。
標本でゼロの場合でも、真の見逃し率の 95% 上限は概ね 3/n（n=41 なら約 7%）である。

## 7. Product Owner への提示と記録

- 提示日: 2026-10-09（PR 本文と本書）
- 判断: **保留**。現時点で D の導入は許可しない。
- D を検討する前に必要な判断:
  1. 架空ラベル 134 件の確認と修正
  2. Jev の実評価の実施と費用（holdout 79 件、tune 47 件の要求）
  3. route ベンチマークの実施と対象モデル（1 モデルあたり 40 タスク、各 CLI の利用枠を消費）
  4. shadow 運用の継続と、比較に必要な run summary の保存

判断を記録したら、本節に日付、判断、根拠を追記する。

## 8. 限界と残存リスク

- ラベルは提案値であり、確認前の数値は暫定である。
- 架空本文は実 Issue の分布や文体と異なる可能性がある。
- 秘密値検出は保守的な検出器であり、検出されなかったことは個人値がない証明にならない。
- 閾値（confidence 0.7、確率差 0.2）は未検証である。
- ベンチマークのタスクは小規模で、実 Issue の難しさを代表しない。合格率の差は route の推薦根拠であって能力の保証ではない。
- モデル、rubric、閾値、benchmarkVersion を変えた場合は再評価し、shadow に戻す。
