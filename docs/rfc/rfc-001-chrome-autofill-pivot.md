# RFC-001: Chrome標準autofillへの方針転換と要件再定義

- Status: **Draft（壁打ち中）**
- Issue: #28
- Branch: `claude/issue-28-chrome-autofill-pivot-rfc`
- Last updated: 2026-06-10

> このドキュメントは Issue #28 の壁打ちの作業メモです。結論が固まるまで `docs/requirements.md` /
> `CLAUDE.md` / `AGENTS.md` の正式更新は行わない。合意後に「正式docs更新Issue」と「実装Issue群」へ分割する。

---

## 1. 背景 / きっかけ

Chrome に、電話番号・メールアドレス・住所・生年月日・勤務先住所・クレジットカード情報などを
自動入力する機能が標準搭載された。これにより formfill-assistant が自前で「保存＋入力」を担う
価値が薄れた一方、Chrome には **「どのサイトに、いつ、どの種類のデータを入力したか」を一覧化する
機能がない**。ここを formfill-assistant で補完する。

## 2. 新しい製品ポジション（暫定）

- **Chrome に任せる**: 個人情報・支払い情報の **保存** と **自動入力**（Chrome標準 autofill を借用）。
- **formfill-assistant が担う**: Chrome autofill の **入力記録 / 監査レイヤ**。
  「いつ・どのサイトに・どの種別のデータを入れたか」をローカルに一覧化する。

## 3. 検知方式（論点A）— 合意した軸

拡張機能は Chrome autofill API を直接は使えないが、以下で観測する：

- **`:autofill` 擬似クラス**（旧 `:-webkit-autofill`）で「そのフィールドが Chrome により自動入力
  されたか」を判定できる（`el.matches(":autofill")`）。
- autofill 発生時に `input` / `change` イベントも飛ぶため、**発生タイミングと対象フィールドを観測可能**。

### 重要な制約

- クレジットカード等の機微フィールドは、**ユーザー操作前は値を JS から読めない / マスクされる**
  ことがある。→ **実値の取得は前提にしない**。
- 取れるのは「autofill された事実 / 時刻 / サイト（URL・ドメイン）/（分類による）データ種別」。

### 既存資産の転用

- #9 scanner（`scanFields`）と #10 分類ロジックは、**「fill するため」→「autofill されたフィールドを
  観測・分類して記録するため」** に転用できる見込み。捨てない。

### この軸の決定

> **`:autofill` 擬似クラス＋イベント観測でフィールドを捕捉 → #9/#10 を転用して種別を分類 →
> メタデータ（いつ/どこ/種別）として記録。値は保存しない。**

## 4. 製品の最終UIイメージ（壁打ちで具体化）

「いつ入れたかの時系列ログ」ではなく、**サービスごとの『何が保存されているか』のインベントリ
（ダッシュボード）＋公式管理画面へのショートカット**を目指す。

| サービス（名前＋アイコン / クリックで遷移） | 名前 | 電話 | 住所 | カード | ログイン |
| --- | --- | --- | --- | --- | --- |
| Coursera | 山田太郎 | …1234 | 〒150-0001 | → Google Wallet | → password-manager 詳細 |

- 行ヘッダはサービス名＋favicon。URL列は出さない。サービス名クリックでそのサイトへ。
- カード・パスワードは**値を持たず、公式管理画面へリンクするだけ**（最も機微なものは保存しない）。
- 名前・電話下4桁・郵便番号など**識別用の軽い値だけ**表示する。

## 5. 記録データのスコープ（論点B）— カテゴリごとに方針を分ける

「メタデータのみ(案X)」「一部の値(案Y)」の二者択一ではなく、**機微度に応じてカテゴリ単位で使い分ける**。

| 種別 | ローカル保存 | 表示 | 外部リンク |
| --- | --- | --- | --- |
| 名前 | フル | フル | — |
| 電話 | **下4桁のみ** | …1234 | — |
| 住所 | **郵便番号のみ** | 〒… | — |
| カード | **保存しない** | — | Google Wallet (`https://wallet.google.com`) |
| ログイン（user/pass） | **保存しない**（ドメインのみ） | — | パスワードマネージャー詳細（後述） |

レコードは **サービス（オリジン）単位のインベントリ（サマリ型）** を基本とする。同一(オリジン×種別)は
最新値で上書き。時系列の履歴を持つかは Open Question。

データモデル（暫定）:

```ts
interface ServiceRecord {
  origin: string;        // 例: https://www.coursera.org（サイト粒度=オリジンで確定）
  serviceName: string;   // 表示名。autofill 検知時の document.title から導出する案
  updatedAt: number;
  entries: CategoryEntry[];
}

interface CategoryEntry {
  category: "name" | "phone" | "address" | "creditCard" | "login";
  displayValue?: string; // name=フル, phone=下4桁, address=郵便番号。card/login は持たない
  // creditCard -> Google Wallet, login -> password-manager 詳細リンク（origin から生成）
}
```

## 6. 外部管理画面へのリンク（要検証の最重要リスク）

- **カード**: Google Wallet（`https://wallet.google.com` ないし `https://pay.google.com`）。https なので問題なし。
- **ログイン**: Chrome パスワードマネージャーの詳細（例: `chrome://password-manager/passwords/coursera.org`）。
  - **`chrome://` URL は拡張機能 / Web ページからのリンク・遷移が原則ブロックされる**。`chrome.tabs.create()`
    でも多くの `chrome://` は弾かれる。**この成立性が製品の中核**なので、PoC で実機検証してから設計を確定する。
  - 開けない場合のフォールバック（URL のコピー表示 / 案内文 等）を用意するか、Open Question。
- **favicon / サービス名**: MV3 の `favicon` 権限＋ `_favicon/?pageUrl=` で取得（要 permission 追加・docs 記載）。
  サービス名は autofill 検知時の `document.title` を記録するのが最も確実。

## 7. プライバシー / セキュリティ（論点C）— 未確定

- 記録自体が新たな機微情報。ローカル限定 / 暗号化 / 保持期間 / 削除・エクスポート / 記録対象サイトの
  allow-deny を要件化するか検討する。
- 名前・電話下4桁・郵便番号をローカル保存することは、「保存はChromeに任せる」からの**部分的な後退**。
  カード番号・パスワード・電話フル桁は保存しないことで「カード情報非保存」原則とは両立する。

## 8. 既存 Issue の仕分け（論点D）— 未確定

| Issue | 内容 | 新方針での扱い（暫定） |
| --- | --- | --- |
| #9 | form scanner | **転用**（観測用に） |
| #10 | field classification | **転用**（種別判定に） |
| #11 / #12 | suggestion / selective fill | 縮小 or 破棄（fill しないなら不要） |
| #14 / #15 | re-scan | 観測のために一部転用の可能性 |
| #16 | site-field history | **新方針の中核**。再定義の土台 |
| #17 | options（履歴管理含む） | 中核 UI として再定義 |
| #21 / #22 | local-only / カード非保存 | 原則として維持（方針と整合） |

## 9. 維持する安全境界（不変）

- フォーム自動送信しない / CAPTCHA・MFA・bot検知・アクセス制御を bypass しない /
  同意・契約を自動チェックしない。
- パスワードとカード番号は読み取らない / 保存しない。

## 10. Open Questions（次に潰す）

- **R（最重要）**: `chrome://password-manager/...` を拡張から開けるか。PoC で実機検証する。
- A': Chrome autofill とユーザー手入力を区別する必要はあるか / できるか（特に下4桁・郵便番号の抽出）。
- B': インベントリ（最新値上書き）に加えて時系列履歴も持つか。
- C: 暗号化・保持期間・エクスポート・記録対象サイトの allow-deny の要件レベル。
- E: 製品名 / コンセプト表現（役割が「記録・管理ハブ」中心になる）。
