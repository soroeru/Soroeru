# Research: Chrome autofill のロケール別成熟度

- Status: **調査メモ（2026-06-12）**
- 関連: [`rfc-001-chrome-autofill-pivot.md`](rfc-001-chrome-autofill-pivot.md)、Issue #29（R/R2/R3 PoC）

> **後日の決着（2026-06-12）**: 本調査の §4 で提示した方針案のうち **A（Chrome 依存をやめて自前完結）が
> 採用**された。ただし「v0.1 原案回帰」ではなく、**自前完結＋自律型 AI エージェント**という新方向
> （RFC-001 v3）へ発展した。本メモは「Chrome autofill を基盤に据えられない」ことの技術的裏付けとして
> 引き続き有効。以下の §4 方針案 A/B/C は決着前の検討記録。
- 目的: RFC-001 が前提とする「Chrome 標準 autofill にデータの保存・自動入力を任せる」方針が、
  日本語・英語・スペイン語・中国語の各ロケールでどこまで成立するかを、実機検証（#29）と
  公開情報の両面から評価する。

> このドキュメントは方針判断のための調査記録であり、`docs/requirements.md` /
> `CLAUDE.md` / `AGENTS.md` の正式更新は行わない。RFC-001 の合意プロセスに従う。

---

## 0. TL;DR

- Chrome autofill の精度・成熟度は **ロケールによって極端に不均一**。米国（英語）が最も成熟し、
  非英語圏ほどローカライズが遅れている。
- 「連絡先情報」（Google アカウント連携の氏名・メール・自宅/勤務先住所）と「高精度の自動入力
  （Enhanced autofill）」は **2025年11〜12月にリリースされたばかり**で、移行期にある。
- 日本（Chrome 149 実機）では **氏名・メールしか自動入力が発火せず**、住所・電話・会社名は
  楽天・Amazon の実フォームでも発火しなかった（Issue #29 R3/R3-4）。
- **結論**: RFC-001 の「Chrome autofill を基盤に観測・補助する」前提は、非英語圏に行くほど
  成立しにくい。自前プロフィール＋自前フィルで Chrome の取りこぼしを埋める価値は
  **非英語圏ほど大きい**。多言語対応は「Chrome の穴埋め」というポジションと整合する。

---

## 1. 機能リリースのタイムライン（公式）

| 時期 | 機能 | 要点 |
| --- | --- | --- |
| 2025-11-03 | 高精度の自動入力（Enhanced autofill、旧 Autofill with AI） | パスポート・運転免許証・車両情報等に対応。**デフォルトはオフ（オプトイン）**。「現在は限定的なウェブサイトとフォームのみに対応」とヘルプに明記。 |
| 2025-12-05 | Google アカウント連携 autofill | **氏名・メールをアカウントから直接取得**。**自宅/勤務先住所**もアカウント側（myaccount.google.com の個人情報）から供給。地点は Google Map 選択式。desktop/Android/iOS に順次展開。 |
| Chrome 148 | 高精度の自動入力が Android にも展開 | — |
| Chrome 149（検証時） | iOS にも展開、対応国・言語を拡大 | — |
| Chrome 150（次期、2026年央見込み） | 高精度の自動入力が**全ユーザーでデフォルトオン**。フォーム項目認識が Private Inference ベースの「最高品質予測」へ移行予定（Enterprise リリースノート） | Private Inference = Google サーバー側処理に依存 |

含意: 主要機能はまだ「移行期」で、不具合修正やロケール対応が進行中。**Chrome 150 リリース後に
#29 の R3/R3-4 を再検証する価値がある**。

---

## 2. ロケール別の評価

### 2.1 英語圏（米国・英国・豪州）

- **米国**: Chrome autofill の設計上のベースラインで最も成熟。住所形式が単純
  （address-line1/2 + city + state + zip）。新機能も英語・米国から先行展開され、修正も最速。
- **英国**: 建物番号/建物名 + 通り名の組み合わせや postcode 起点の住所検索ウィジェット
  （postcode lookup）が普及。**検索ウィジェット型フォームは autofill が苦手**。
- **豪州**: 住所検索ウィジェットの採用率が高く、英国と同様の課題。

評価: **米国型の静的フォームは強いが、検索ウィジェット型では英語圏でも完璧ではない。**

### 2.2 スペイン語圏（メキシコ・中南米・スペイン）

- **メキシコ**: Google が明示的に投資。2025-12 の発表で「entre calles（通りの間）」表記の
  認識改善が出荷済み。州→市町村→市→コロニア（地区）の4階層も認識対象。
- **構造的ギャップ**: `between-streets`（AR/MX）、`first-family-name`/`second-family-name`
  （スペイン式の父姓・母姓2フィールド）は **標準 autocomplete 属性に存在しない拡張概念**。
  サイト側が正しくマークアップできず、Chrome のヒューリスティック頼み。
- **スペイン**: 特に複雑。通りの種別（tipo de vía: Calle/Avenida 等）と通り名の分離、
  階数・階段・部屋番号・文字（letra）の個別フィールドを要求するサイトが多く、対応が弱い。

評価: **メキシコ向けは改善進行中、スペイン型の構造化フォームは依然ギャップ大。**

### 2.3 中国語圏（本土・台湾・香港）

最も厳しい。

- **本土**: 2012年以降すべての Google サービスがブロック。Chrome ブラウザ自体は高シェア
  （デスクトップ約30%、トラフィック全体で約49%）だが、**Google アカウントのサインイン・同期が
  機能しない**ため、「連絡先情報」（アカウント連携）や「高精度の自動入力」（Chrome 150 からは
  Private Inference = サーバー側処理）は**事実上利用不能**。使えるのはローカル保存の旧来 autofill のみ。
- **フォーム慣行**: 省→市→区→鎮の4階層を**カスタム JavaScript の連動セレクトボックス**で
  選ばせる方式が主流。Chrome autofill はこの種のカスタムウィジェットを操作できない。
  全角/半角の使い分け要求も障害。淘宝・京東など大手 EC はサイト内住所帳を持ち、
  ブラウザ autofill 自体が文化的に使われていない。
- **配布**: **Chrome Web Store も本土ではブロック**。拡張機能配布自体が困難。
- **台湾・香港**: Google サービスは使えるため本土よりは健全だが、階層住所＋連動セレクトという
  フォーム慣行は共通で、構造的課題は残る。

評価: **本土は autofill 精度以前に、Google 依存機能の全滅と配布チャネル不在という別次元の問題。
優先度を分けるべき。**

### 2.4 日本（実機検証 = Issue #29）

- Chrome 149 で `chrome://settings/addresses` は `chrome://settings/contactInfo` にリダイレクト。
  氏名・メール・電話は各1件、住所は「自宅の住所」「勤務先の住所」の2枠で Google Map 地点選択式
  （郵便番号・建物名などのフィールド分割なし）、「会社名」項目なし。
- **氏名・メールのみ autofill が発火**。電話番号は contactInfo に登録済みでも不発。
  自宅/勤務先住所（`street-address` フィールド）も不発（R3-4）。
- **楽天・Amazon の実フォームでも氏名・メール以外は発火しなかった** → サイト側でなく
  Chrome 側の対応範囲の問題。
- 公式も「ふりがな対応は今後提供予定（upcoming support for phonetic names in Japan）」と
  日本対応が移行途上であることを明言。

評価: **現時点では氏名・メールのみ実用レベル。住所・電話・会社名は実用に達していない。**

---

## 3. 横断する構造的要因

Chrome autofill 開発者（Dominic Battré）の公開分析文書は、**現行の HTML autocomplete 標準が
非英語圏の住所フィールドを表現しきれていない**ことを認めている。標準に存在しない拡張概念の例:

| フィールド | 対象 | 用途 |
| --- | --- | --- |
| `phonetic-name` | 日本 | ふりがな/カナ |
| `first-family-name` / `second-family-name` | スペイン語圏 | 父姓・母姓の2姓 |
| `between-streets` | アルゼンチン・メキシコ | 交差点間の場所指定 |
| `street-name-type` / `street-name-name` | スペイン・ハンガリー | 通りの種別と名前の分離 |
| `floor` / `apartment` / `staircase` / `location-in-building` | 複数国 | 建物内位置 |
| `patronymic-name` | ロシア・ウクライナ等 | 父称 |

これらは標準トークンがないためサイト側で正しくマークアップする手段がなく、Chrome のヒューリスティック
任せになる。**多言語フォームほど autofill が外しやすい根本理由。**

---

## 4. RFC-001 / 製品設計への示唆

1. **「Chrome autofill を基盤に観測・補助する」設計は非英語圏ほど成立しにくい。** 日本の検証結果
   （氏名・メールのみ）は例外ではなく、ローカライズ遅れの一般パターンの一例。
2. **自前プロフィール＋自前フィルの価値は非英語圏ほど高い。** ふりがな（日本）、父姓・母姓
   （スペイン語圏）、階層住所（中国）など、Chrome と autocomplete 標準が取りこぼすフィールドこそ、
   CLAUDE.md の「動的スキーマ／ユーザー定義フィールド」方向と相性が良い。
3. **フィールド検出ルールはロケール別ラベル辞書をデータとして分離**しておく（「郵便番号」/
   「Código Postal」/「邮政编码」…）。将来のロケール追加が容易になる。
4. **中国本土は autofill 精度以前に配布チャネルと Google 依存の問題**。優先度を分ける。
5. **展開順の提案**: 第1波 = 日本語・英語、第2波 = スペイン語、中国本土は別途検討。

### 取りうる方針（RFC-001 §10 へ反映候補）

| 案 | 内容 | 評価 |
| --- | --- | --- |
| A. v0.1 原案回帰 | 自前ローカルプロフィール＋自前フィルに戻る（CLAUDE.md 原スコープ） | Chrome の不安定さに非依存。多言語と相性良 |
| B. ハイブリッド（推奨） | 確実に動く氏名・メールは Chrome に任せて観測し、住所・電話・会社名など壊れている部分を自前プロフィールで補完 | 「Chrome の穴を埋める」ポジションが明確。非英語圏で価値大 |
| C. Chrome 150 待ち | 次期リリース（デフォルトオン＋フォーム認識強化）後に #29 を再検証してから判断 | 手戻り最小化のための時間稼ぎ |

推奨は **B を軸に、Chrome 150 リリース後に R3/R3-4 を再検証（C）して裏取りする**構え。

---

## 5. 未確認・要追跡

- 旧来のフィールド分割型ローカル住所プロフィール（旧 `chrome://settings/addresses`）が**正式廃止
  されたという公式ドキュメントは未発見**。Chrome 149 で contactInfo にリダイレクトされ地点式しか
  登録できないのは、サーバーサイドフラグによる段階的切り替えの可能性（地域・プロフィールで挙動差）。
- 新しい連絡先情報モデルに対するユーザーの不満・不具合報告は、検索では具体的スレッドを確認できず
  （機能が新しすぎる。特に日本語圏）。
- **Chrome 150 リリース後の再検証**（#29 の R3/R3-4 を再実行）。

---

## 6. 出典

- [Chrome ヘルプ: フォームに自動入力する](https://support.google.com/chrome/answer/142893)
- [Google公式ブログ: Save time with new Chrome autofill enhancements（2025-11）](https://blog.google/products/chrome/enhanced-autofill/)
- [Google公式ブログ: Chrome's latest autofill improvements（2025-12-05、メキシコ between streets）](https://blog.google/products/chrome/autofill-improvements/)
- [Chrome Enterprise and Education リリースノート](https://chromeenterprise.google/resources/release-notes/)
- [9to5google: Chrome Autofill two-line design / Google Wallet integration（2025-12-05）](https://9to5google.com/2025/12/05/chrome-autofill-google-wallet/)
- [9to5google: Chrome can now autofill driver's license, vehicle info（2025-11-03）](https://9to5google.com/2025/11/03/chrome-autofill-license/)
- [Google Japan ブログ: Chrome がふりがなの自動保存と入力に対応](https://blog.google/intl/ja-jp/feed/google-chrome-autofill-kana/)
- [Address form analysis（Dominic Battré, Chrome autofill 各国住所フォーム分析）](https://battre.github.io/autocomplete-attribute-explainer/)
- [Chromium: Internationalization of Autofill 設計文書](https://www.chromium.org/developers/design-documents/form-autofill/internationalization-of-autofill/)
- [Comparitech: Is Google blocked in China?](https://www.comparitech.com/privacy-security-tools/blockedinchina/google/)
- [Statcounter: Browser Market Share China](https://gs.statcounter.com/browser-market-share/all/china)
- [Statista: China web traffic share of main browsers 2026](https://www.statista.com/statistics/1203531/china-web-traffic-share-of-main-web-browsers/)
