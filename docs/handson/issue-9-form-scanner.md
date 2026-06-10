# ハンズオン: Issue #9 フォームスキャナー実装

このドキュメントは **プログラム初心者** の人が、
Issue #9「REQ-002: active pageの可視input/textarea/selectを検出する」
を自分の手で実装しきるためのガイドです。

進め方:

- 上から順に読み、コードはコピペではなく**自分で書く**
- 各ステップの末尾に「**動作確認**」がある → 必ず実行して期待通り動いてから次へ
- TypeScript の文法は、その時必要な分だけ随時挟みます

所要時間の目安: 4〜8 時間 (1日でやりきろうとせず、Step 区切りで休憩推奨)

---

## 0. ゴールと完成イメージ

### この Issue で作るもの

Web ページに注入された content script から呼べる関数 `scanFields()` を作る。
それを呼ぶと、そのページにある「ユーザーがフィルできそうな入力欄」のリストが返ってくる。

```ts
// 完成イメージ
const fields = scanFields(document);
// → [
//     { fieldId: "ff-1", tag: "input", type: "email",
//       value: "", visible: true, labelCandidates: ["Email"] },
//     { fieldId: "ff-2", tag: "input", type: "text",
//       value: "", visible: true, labelCandidates: ["お名前"] },
//     { fieldId: "ff-3", tag: "select", type: null,
//       value: "JP", visible: true, labelCandidates: ["国"] },
//   ]
```

### やらないこと (Non-Scope)

- フィールドの分類 (「これは email っぽい」みたいな判断)
- 自動フィル
- iframe や shadow DOM の中まで降りる
- 完璧な可視性判定

「保守的に、確実に fillable と言えるものだけを返す」が方針です。

### 触るファイル

| ファイル | 何をするか |
| --- | --- |
| `src/shared/types.ts` | スキャナーが返す型を追加 |
| `src/content/scanner.ts` | **新規** スキャナー本体 |
| `tests/fixtures/dom/*.html` | **新規** テスト用 HTML |
| `tests/unit/scanner.test.ts` | **新規** ユニットテスト |
| `docs/extension.md` | スキャナーの制約を docs に反映 |
| `package.json` | テスト用に `jsdom` を dev dep に追加 |

---

## 1. 開始前チェック

### 1.1 リポジトリ状態の確認

```bash
git status            # clean であること
git branch --show-current
# → handson/issue-9-form-scanner
```

ブランチが違ったら以下:

```bash
git switch handson/issue-9-form-scanner
```

### 1.2 依存インストールとビルド

```bash
npm install
npm run build
npm test
```

3 つとも成功すれば準備 OK。失敗したら、まず先に環境を直してから先に進んでください。
(これらが通らない状態で実装を始めると、自分のコードのせいか環境のせいか区別がつかなくなる)

### 1.3 関連コードの読みどころツアー

実装前に **15 分**だけ既存コードを読んでください。同じスタイルに揃えるためです。

| 見るもの | ファイル | なぜ |
| --- | --- | --- |
| 判別付きの union 型と型の検証関数 (詳しくは Section 2 で説明) | `src/shared/types.ts:1-46`, `src/shared/profile-validation.ts:53-103` | スキャナーの戻り値型を設計する時の参考 |
| 「実物」と「テスト用」を差し替えられる設計 | `src/storage/profile-store.ts:5-45` | scanner も `document` を引数で受ければテストしやすい |
| Node test runner のテスト書き方 | `tests/unit/profile-store.test.ts:1-60` | 同じ流儀で書く |
| ビルドフロー | `scripts/build-extension.mjs` | content script を追加した時に何が起きるか想像できる |

---

## 2. TypeScript 速習 (Issue #9 に必要な分だけ)

ここは「読むだけ」のセクション。実装中に分からなくなったら戻ってきてください。

### 2.1 そもそも「型 (type)」とは

プログラムで扱う値には「種類」があります。`42` は数値、`"hello"` は文字列、`true` は真偽値。
TypeScript ではこの種類を **型 (type)** と呼び、変数や関数の引数・戻り値に「**ここにはこの型しか入らない**」と宣言できます。

```ts
const name: string = "Alice";   // 文字列しか入らない
let count: number = 0;          // 数値しか入らない
const ok: boolean = true;       // true / false だけ
```

良いことが2つあります:

1. **間違いに事前に気づける** — `count = "hello"` と書くと実行する前にエラーで止まる
2. **エディタが補完してくれる** — `name.` まで打つと「文字列で使えるメソッド一覧」が出る

`const` / `let` は変数を作るキーワード:

- `const`: 後から値を入れ替えられない (定数)
- `let`: 入れ替えられる

初期値があれば型注釈は省略できます (TypeScript が自動で推測してくれる):

```ts
const message = "hello";   // string と分かるので : string は要らない
```

ちなみに型は **コンパイル時** (= プログラムを動かす前のチェック) だけで使われます。
実行時には消えるので、「型を間違えると動かない」ではなく「型を間違えるとビルドできない」が正しい理解です。

### 2.2 オブジェクトの型を作る (`interface` / `type`)

複数のフィールドをまとめた「オブジェクト」にも型を付けられます。

```ts
interface ProfileField {
  id: string;
  label: string;
}

const f: ProfileField = { id: "x", label: "Email" };
```

`interface` と `type` はほぼ同じ働きをします:

```ts
// interface で書く
interface User { name: string; age: number }

// type で書く
type User = { name: string; age: number };
```

このプロジェクトでは「単純なオブジェクトの形」は `interface`、「複数の型を組み合わせる時」は `type` を使う方針です (`src/shared/types.ts` 参照)。最初は **どちらを使ってもいい**と覚えておけば十分。

### 2.3 Union 型 — 「これか、これか」 ← Issue #9 で使う

`|` で型をつなげると、「**このうちのどれか**」という型になります。

```ts
type Tag = "input" | "textarea" | "select";

const t1: Tag = "input";    // OK
const t2: Tag = "button";   // エラー (3つのどれでもない)
```

`"input"` などの文字列を **値そのもの**として型に使えるのが TypeScript の特徴 (リテラル型と呼びます)。これで「決まった文字列のうちのどれか」を厳密に表現できます。

オブジェクト同士の union もできて、Issue #9 ではこの形を使います:

```ts
type ScannedField =
  | { tag: "input"; type: string; value: string }
  | { tag: "textarea"; value: string }
  | { tag: "select"; options: string[]; value: string };
```

これは「3 種類のオブジェクトのうちのどれか」という意味。`tag` というフィールドが「**どれなのか判別するための目印**」になっていて、この設計を **discriminated union (判別付き union)** と呼びます。

使う側で `tag` をチェックすると、TypeScript が「**これは input の型だ**」と勝手に判断して、対応するフィールドだけが使えるようになります:

```ts
if (field.tag === "input") {
  field.type;    // この中では field は "input" 用の型として扱われる
}
```

実例: `src/shared/types.ts:31` の `ProfileField = BasicProfileField | CustomProfileField`。

### 2.4 Optional `?` と `undefined`

オブジェクトのフィールドに `?` を付けると「あってもなくてもいい」になります。

```ts
interface LabelInfo {
  text: string;
  hint?: string;   // hint は省略可能
}

const a: LabelInfo = { text: "Email" };                // OK
const b: LabelInfo = { text: "Email", hint: "メール" }; // OK
```

フィールドが無いときの値は `undefined` です。
似たものに `null` がありますが、TypeScript では基本 `undefined` を使う流派が主流。最初は **`undefined` だけ覚えれば OK**。

### 2.5 `readonly` と `as const` — 「書き換えられない」を表す

普通の配列は後から中身を変えられます:

```ts
const arr = ["a", "b"];
arr.push("c");          // できる
arr[0] = "z";           // できる
```

`as const` を付けると、**書き換え禁止の固定配列**になります:

```ts
const arr = ["a", "b"] as const;
arr.push("c");          // エラー
```

さらに、推論される型もより精密になります:

| 書き方 | 推論される型 |
| --- | --- |
| `["a", "b"]` | `string[]` (要素は何かの文字列) |
| `["a", "b"] as const` | `readonly ["a", "b"]` (要素も順序も固定) |

このプロジェクトでは、これと `(typeof 配列)[number]` の組み合わせで、配列 1 個から union 型を自動的に作っています:

```ts
const TAGS = ["input", "textarea", "select"] as const;
type Tag = (typeof TAGS)[number];
// → Tag は "input" | "textarea" | "select"
```

`(typeof TAGS)` は「変数 `TAGS` の型を取り出す」操作、`[number]` は「その配列の全要素を集めて union にする」操作です。
配列を 1 か所書き換えれば union 型も自動で追従するので、書き間違いが起きません。

実例: `src/shared/types.ts:1-11`。

### 2.6 import の `.js` 拡張子

このリポジトリの import はこう書きます:

```ts
import type { ProfileField } from "../shared/types.js";
//                                            ^^^ .ts じゃなくて .js
```

**ファイルは `.ts` なのに `.js` と書く**のは、Node.js が ES Modules を扱う時のルールです。
TypeScript は型を取り除いた `.js` を出力するので、import のパスもコンパイル後の `.js` を指す必要があります。最初は変な感じがしますが、ルールとして覚えてください。

`import type { X }` は「これは型としてしか使わない」と宣言する書き方。コンパイル後の JS から完全に消えます。
値も使いたい時は `type` を付けずに `import { X }` と書きます。

### 2.7 型を絞り込む (narrowing)

union 型の値は、そのままだと特定の型のメソッドを呼べません:

```ts
function process(value: string | number) {
  value.toUpperCase();   // エラー: number には toUpperCase が無い
}
```

「今この値は union のどっち側なのか」を **絞り込み (narrowing)** してから使います。よく使う方法:

#### a) `typeof` で型の名前をチェック

```ts
if (typeof value === "string") {
  value.toUpperCase();   // value は string に絞られる
}
```

#### b) `instanceof` でクラスをチェック

```ts
if (el instanceof HTMLInputElement) {
  el.value = "hello";    // el は HTMLInputElement に絞られる
}
```

→ ハンズオンの scanner.ts で多用します。

#### c) リテラルの一致をチェック (discriminated union)

```ts
if (field.tag === "input") {
  field.type;            // input 用のオブジェクトに絞られる
}
```

#### d) ユーザー定義の判定関数 (type guard)

戻り値の型を `el is HTMLInputElement` の形で書くと、`true` を返した後で型が絞られます:

```ts
function isInput(el: Element): el is HTMLInputElement {
  return el.tagName === "INPUT";
}

if (isInput(el)) {
  el.value;   // ここでは el は HTMLInputElement
}
```

実例: `src/shared/profile-validation.ts:53-59`。

### 2.8 ジェネリクス (`<T>`) と `WeakMap`

`Map<キーの型, 値の型>` のように、`<>` の中で「中身の型」を指定する仕組みを **ジェネリクス**と呼びます。

```ts
const cache = new Map<string, number>();
cache.set("a", 1);              // OK
cache.set("a", "x");            // エラー (値は number のはず)

const ids = new WeakMap<Element, string>();
ids.set(someElement, "ff-1");
```

`Map` と `WeakMap` の違い:

- `Map`: キーは何でもよい (文字列・数値・オブジェクト)
- `WeakMap`: **キーはオブジェクトだけ**。キーになっているオブジェクトが消える (= ガベージコレクトされる) と、対応するエントリも自動で消える

Issue #9 では「`<input>` 要素 → "ff-1"」のような対応表を作りますが、ページから要素が消えた後も対応表に残骸が残るとメモリを食い続けます。`WeakMap` を使えば自動的に掃除されるので安心です。

### 2.9 strict モードでの注意点

このプロジェクトは厳しめのチェック設定を有効にしています (`tsconfig.json:6-8`):

- `strict: true` — 全体的に厳しめのチェック
- `noUncheckedIndexedAccess: true` — **配列の要素アクセスは `T | undefined` 扱い**になる
- `exactOptionalPropertyTypes: true` — optional 項目に `undefined` を明示的に入れるとエラー

つまり:

```ts
const items: string[] = ["a", "b"];
const first = items[0];                 // first の型は string | undefined
console.log(first.toUpperCase());       // エラー! first が undefined かもしれない
if (first) {
  console.log(first.toUpperCase());     // OK (絞り込んだ後)
}
```

「**配列から取り出した後は undefined チェックする**」のが癖になります。
最初は煩わしく感じますが、実行時の「`undefined` のプロパティを読もうとして落ちる」事故を防いでくれます。

### 2.10 `any` と `unknown`

- `any`: 「型チェックしない」型。書くのは楽だけど **使わないのが原則**
- `unknown`: 「何が入っているか分からない」型。使う前に narrowing しないと操作できない

外から来るデータ (JSON、ストレージから読んだ値、ユーザー入力) は `unknown` で受けて、検証してから使うのが安全策です。
実例: `src/shared/profile-validation.ts:66` の `assertProfileField(value: unknown)`。

---

## 3. DOM API 速習

### 3.0 DOM とは

Web ページの HTML は、ブラウザの中で **DOM (Document Object Model)** という階層構造に変換されています。
`<html>` の中に `<body>` があり、その中に `<form>` や `<input>` が並ぶ、というツリー (木) の形です。

JavaScript / TypeScript からはこの DOM をオブジェクトとして触れます。例えば「ページに `<input>` がいくつあるか数える」「ある要素のラベルを取り出す」といった操作が可能です。
今回作るスキャナーは、この DOM を歩いて入力欄を集めるプログラムです。

ツリーの全体を表すオブジェクトが **`document`**。ブラウザの中で動く JS からはグローバルに参照できます。
このプロジェクトでは、テストをしやすくするためにスキャナー関数の引数として `document` を受け取る形にします (実体は Section 5 で説明)。

### 3.1 要素の取得

```ts
const all = document.querySelectorAll("input, textarea, select");
// NodeListOf<Element> が返る (Array ではない)

// イテレートしたい時は Array に変換
for (const el of Array.from(all)) {
  console.log(el.tagName);
}
```

### 3.2 要素の型階層

```text
Node
└─ Element
   └─ HTMLElement
      ├─ HTMLInputElement       ← input
      ├─ HTMLTextAreaElement    ← textarea
      ├─ HTMLSelectElement      ← select
      └─ HTMLLabelElement       ← label
```

`querySelectorAll` の戻り値は基底の `Element` なので、具体的な操作 (`.value` など) には型を絞る必要があります。

```ts
for (const el of Array.from(all)) {
  if (el instanceof HTMLInputElement) {
    const type = el.type;        // string ("email", "text", ...)
    const value = el.value;      // string
    const disabled = el.disabled; // boolean
  }
}
```

### 3.3 可視性判定に使えるもの

完璧な可視性判定は不可能なので、**保守的に**「これは見えてないと言える」ものを除外します。

```ts
const rect = el.getBoundingClientRect();
// rect.width, rect.height : 画面上のサイズ (CSS で width:0 や非表示なら 0)

const style = getComputedStyle(el);
style.display     // "none" なら非表示
style.visibility  // "hidden" なら非表示

el.offsetParent   // null かつ position:fixed でもないなら、display:none の祖先がある
```

組み合わせ例:

```ts
function isVisible(el: HTMLElement): boolean {
  const style = getComputedStyle(el);
  if (style.display === "none") return false;
  if (style.visibility === "hidden") return false;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  return true;
}
```

### 3.4 label の取り方

3 種類の関連付け方法があります:

1. **`for` 属性で紐づけ** ← 最も明示的
   ```html
   <label for="email">Email</label>
   <input id="email" />
   ```

2. **input を label が包む**
   ```html
   <label>Email <input /></label>
   ```

3. **`aria-label` / `aria-labelledby`**
   ```html
   <input aria-label="Email" />
   ```

優先順としては (1) → (2) → (3) → 近接テキスト の順で見ていきます。

`<input>` 要素は `.labels` プロパティで関連した `<label>` リストが取れます (jsdom も対応)。

---

## 4. テスト環境の準備 (jsdom 導入)

DOM を扱うコードを Node のテストで動かすには、ブラウザ環境を**模擬**するライブラリが必要です。
このプロジェクトはまだ DOM 操作のテストが無いので、`jsdom` を新規に dev dependency として追加します。

> **新しい dep を入れる時は理由を docs に残す**のがこのリポジトリのルール (CLAUDE.md 参照)。Step 10 で `docs/testing.md` の更新もやります。

### 4.1 インストール

```bash
npm install --save-dev jsdom @types/jsdom
```

`package.json` の `devDependencies` に `jsdom` と `@types/jsdom` が増えていれば OK。

### 4.2 動作確認

`tests/unit/scanner.test.ts` を作って、jsdom が動くかだけ確かめる最小テストを書きます。

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JSDOM } from "jsdom";

describe("jsdom sanity", () => {
  it("can build a DOM from a string", () => {
    const dom = new JSDOM(`<input type="email" />`);
    const input = dom.window.document.querySelector("input");
    assert.equal(input?.type, "email");
  });
});
```

```bash
npm test
```

通れば次へ。

---

## 5. 実装ステップ

ここから本番。各ステップは「**何を作るか → 必要な知識 → コード → 動作確認**」の構成。

### Step 1: 型を定義する

`src/shared/types.ts` の末尾に、スキャナーが返す型を追加します。

**設計判断:**
- `tag` を `"input" | "textarea" | "select"` の union にする (discriminated union)
- `type` は `<input>` のときだけ意味がある → input 派生型にのみ持たせる
- `labelCandidates` は配列。優先度高い順に入れる
- `fieldId` は scan ごとに発行する一時 ID。`"ff-N"` 形式

```ts
// 追加するコード
export interface ScannedFieldBase {
  fieldId: string;
  value: string;
  visible: boolean;
  labelCandidates: string[];
}

export type ScannedField =
  | (ScannedFieldBase & { tag: "input"; type: string })
  | (ScannedFieldBase & { tag: "textarea" })
  | (ScannedFieldBase & { tag: "select" });
```

**動作確認:**

```bash
npm run typecheck
```

エラーが出ないこと。

### Step 2: 最小スキャナー (入れ物だけ作る)

`src/content/` ディレクトリを作り、`scanner.ts` を新規作成。

```bash
mkdir -p src/content
```

`src/content/scanner.ts`:

```ts
import type { ScannedField } from "../shared/types.js";

const SUPPORTED_INPUT_TYPES = new Set([
  "text", "email", "tel", "url", "search", "number",
  "date", "datetime-local", "month", "time", "week",
]);

export function scanFields(root: Document): ScannedField[] {
  const elements = Array.from(root.querySelectorAll("input, textarea, select"));
  const results: ScannedField[] = [];

  let counter = 0;
  for (const el of elements) {
    const fieldId = `ff-${++counter}`;

    if (el instanceof HTMLInputElement) {
      results.push({
        fieldId,
        tag: "input",
        type: el.type,
        value: el.value,
        visible: true,         // 後で実装
        labelCandidates: [],   // 後で実装
      });
    } else if (el instanceof HTMLTextAreaElement) {
      results.push({
        fieldId,
        tag: "textarea",
        value: el.value,
        visible: true,
        labelCandidates: [],
      });
    } else if (el instanceof HTMLSelectElement) {
      results.push({
        fieldId,
        tag: "select",
        value: el.value,
        visible: true,
        labelCandidates: [],
      });
    }
  }
  return results;
}
```

**ポイント:**
- 引数で `Document` を受け取る → テストの時は jsdom で作った仮の document を渡せる (本番のブラウザでは `document` を渡す)
- `instanceof` で型を絞っている → その中では `.value` などが安全に呼べる
- まずは全部 `visible: true`, `labelCandidates: []` で返す (中身は後のステップで埋める)

**動作確認:**

```bash
npm run typecheck
```

### Step 3: 1 つ目のテストを書く

テスト用に「読み込ませる用のサンプル HTML」(これを **fixture** と呼びます) を作ります。

```bash
mkdir -p tests/fixtures/dom
```

`tests/fixtures/dom/basic-form.html`:

```html
<!doctype html>
<html>
<body>
  <form>
    <label for="email">Email</label>
    <input id="email" type="email" />

    <label>お名前 <input type="text" name="name" /></label>

    <textarea name="message"></textarea>

    <select name="country">
      <option value="JP">Japan</option>
      <option value="US">USA</option>
    </select>
  </form>
</body>
</html>
```

`tests/unit/scanner.test.ts` を書き換え:

```ts
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { JSDOM } from "jsdom";
import { scanFields } from "../../src/content/scanner.js";

async function loadFixture(name: string): Promise<Document> {
  const fixturePath = path.join("tests", "fixtures", "dom", name);
  const html = await readFile(fixturePath, "utf8");
  return new JSDOM(html).window.document;
}

describe("scanFields", () => {
  it("returns input, textarea, and select elements", async () => {
    const document = await loadFixture("basic-form.html");
    const fields = scanFields(document);

    const tags = fields.map((field) => field.tag);
    assert.deepEqual(tags.sort(), ["input", "input", "select", "textarea"]);
  });
});
```

**動作確認:**

```bash
npm test
```

通ること。通らなかったら、エラーメッセージをよく読んで自分で直してみてください (詰まったら遠慮なく Claude に聞きましょう)。

> **テストの基本構造の読み方**: `describe("対象の名前", () => { ... })` で大きなグループ、`it("こうあるべき", () => { ... })` で個別のテスト、`assert.equal(実際の値, 期待する値)` で照合します。期待と異なれば失敗、同じならパス、というシンプルな仕組みです。

### Step 4: 未対応 input type を除外する

仕様: `password`, `hidden`, `submit`, `button`, `image`, `reset`, `file` は除外。

`scanner.ts` の `if (el instanceof HTMLInputElement)` ブランチを修正:

```ts
if (el instanceof HTMLInputElement) {
  if (!SUPPORTED_INPUT_TYPES.has(el.type)) continue;
  // ...既存の push
}
```

**テスト追加:**

`tests/fixtures/dom/unsupported-inputs.html`:

```html
<!doctype html>
<html>
<body>
  <input type="password" />
  <input type="hidden" />
  <input type="submit" />
  <input type="button" />
  <input type="image" />
  <input type="reset" />
  <input type="file" />
  <button type="submit">Send</button>
  <input type="text" name="ok" />
</body>
</html>
```

`scanner.test.ts` に追加:

```ts
it("excludes unsupported input types and buttons", async () => {
  const document = await loadFixture("unsupported-inputs.html");
  const fields = scanFields(document);

  assert.equal(fields.length, 1);
  assert.equal(fields[0]?.tag, "input");
});
```

**動作確認:**

```bash
npm test
```

`noUncheckedIndexedAccess` で `fields[0]` は `ScannedField | undefined` になるので `?.` を使うのを忘れずに。

### Step 5: 可視性判定 (visibility)

Section 3.3 のコードを `isVisible` ヘルパーとして実装し、結果を `visible` に入れる。
さらに「**`visible: false` の要素はそもそも返さない**」のがこのプロジェクトの方針 (= 「fillableと見なせる」ものだけ返す)。

```ts
function isVisible(el: HTMLElement): boolean {
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  if (!style) return true;  // jsdom で defaultView が無いケースは保守的に true
  if (style.display === "none") return false;
  if (style.visibility === "hidden") return false;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  return true;
}
```

`scanFields` 内で各要素について `if (!isVisible(el)) continue;` を入れる。

`tests/fixtures/dom/visibility.html`:

```html
<!doctype html>
<html>
<body>
  <input type="text" name="visible" />
  <input type="text" name="hidden-display" style="display:none" />
  <input type="text" name="hidden-visibility" style="visibility:hidden" />
</body>
</html>
```

テスト追加:

```ts
it("excludes elements that are hidden via CSS", async () => {
  const document = await loadFixture("visibility.html");
  const fields = scanFields(document);

  assert.equal(fields.length, 1);
});
```

> **注意:** jsdom はレイアウト計算をしないので `getBoundingClientRect` は基本 0 を返します。CSS による非表示テストには使えますが、「画面外にある」みたいなレイアウトベースの判定は実ブラウザでないと再現できません。docs に「pixel-perfect visibility は狙わない」と書く根拠でもあります。

### Step 6: disabled / readonly の扱い

仕様 (Issue #9):
- `disabled` → 除外
- `readonly` → fillable から外す方が安全なので除外 (where relevant)

```ts
if (el instanceof HTMLInputElement
    || el instanceof HTMLTextAreaElement
    || el instanceof HTMLSelectElement) {
  if (el.disabled) continue;
  if ("readOnly" in el && el.readOnly) continue;
  // ...
}
```

> `select` は `readOnly` を持たないので `in` でチェックしています。これも `noUncheckedIndexedAccess` 系の strict 設定との相性です。

fixture とテストを追加してください (パターンはこれまでと同じ)。fixture 名は `disabled-readonly.html` を推奨。

### Step 7: scan-local field ID を `WeakMap` で管理する

これまで `counter++` で連番を振っていましたが、Issue 仕様では **`WeakMap<Element, string>` を使う**ことになっています。なぜ:

- 同じ要素は scan 横断で同じ ID を返したい場面が将来ありうる
- 要素が DOM から消えたら自動で対応も消えてほしい (メモリリーク防止)

ただし「scan ごとに再構築」と書いてあるので、**スキャナーの呼び出しごとに新しい WeakMap を作る**のが今回の意図です。

```ts
function buildScanContext() {
  const ids = new WeakMap<Element, string>();
  let counter = 0;
  return {
    idFor(el: Element): string {
      const existing = ids.get(el);
      if (existing) return existing;
      const fresh = `ff-${++counter}`;
      ids.set(el, fresh);
      return fresh;
    },
  };
}
```

`scanFields` の冒頭で `const ctx = buildScanContext();` し、`fieldId: ctx.idFor(el)` に変更。

**テスト追加:**

```ts
it("returns stable ids within a single scan", async () => {
  const document = await loadFixture("basic-form.html");
  const fields = scanFields(document);
  const ids = fields.map((field) => field.fieldId);
  assert.equal(new Set(ids).size, ids.length);   // 重複なし
  assert.match(ids[0] ?? "", /^ff-\d+$/);         // 形式チェック
});
```

### Step 8: label 候補の収集

優先順位 (Section 3.4 参照):

1. `el.labels` から取れる `<label>` のテキスト
2. `aria-label`, `aria-labelledby` 経由
3. `placeholder`
4. (時間があれば) 近接テキスト

最小版:

```ts
function collectLabelCandidates(el: HTMLElement): string[] {
  const out: string[] = [];

  if ("labels" in el && el.labels) {
    for (const label of Array.from(el.labels as NodeListOf<HTMLLabelElement>)) {
      const text = label.textContent?.trim();
      if (text) out.push(text);
    }
  }

  const ariaLabel = el.getAttribute("aria-label")?.trim();
  if (ariaLabel) out.push(ariaLabel);

  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    for (const id of labelledBy.split(/\s+/)) {
      const ref = el.ownerDocument.getElementById(id);
      const text = ref?.textContent?.trim();
      if (text) out.push(text);
    }
  }

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const placeholder = el.placeholder?.trim();
    if (placeholder) out.push(placeholder);
  }

  return out;
}
```

`scanFields` 内で `labelCandidates: collectLabelCandidates(el)` に置き換え。

fixture とテストを追加し、`for` 属性, label-wrap, `aria-label`, `placeholder` の各パターンで期待ラベルが取れることを確認。

### Step 9: iframe / shadow DOM のスキップを明示する

実装はしませんが、**「やらない」と decision として明示**します。

`scanner.ts` の冒頭にコメント:

```ts
// Scope (v0.1): same-origin iframes and shadow DOM are NOT traversed.
// See docs/extension.md §3.
```

(コメントは普段書きませんが、これは「**意図的にやらない**」ことを将来の自分・他人に伝えるためなので残す価値あり。CLAUDE.md のコメントポリシーで言う「hidden constraint」相当。)

### Step 10: ドキュメント更新

`docs/extension.md` の `## 3. Content Script Responsibilities` セクションに、スキャナーの現在地と制約を追記します。

書く内容の例 (自分の言葉で):

```markdown
Current implementation status:

- `src/content/scanner.ts` exposes `scanFields(document)` for the active page;
- it returns visible `input`, `textarea`, and `select` elements with a
  scan-local `fieldId`, current value, and label candidates;
- unsupported input types (`password`, `hidden`, `submit`, `button`, `image`,
  `reset`, `file`) and disabled / readonly controls are excluded;
- same-origin iframes and shadow DOM are out of scope for v0.1.
```

それと `docs/testing.md` の §3 あたりに **jsdom を入れた理由**を 1 行追記:

```markdown
- DOM scanning unit tests use `jsdom` to construct a `Document` from HTML
  fixtures, since the project's content script logic accepts a `Document`
  argument for testability.
```

---

## 6. 最終チェック (品質ゲート)

PR を出す前に必ず:

```bash
npm run typecheck     # 型エラー 0
npm run build         # ビルド成功
npm test              # 既存 + 新規テスト全部 green
```

加えて、`docs/manual-test.md` がある場合は該当する項目を眺めて、今回の変更で影響しうるかチェックしてください。

---

## 7. PR を出す前にやること

1. `git status` で意図しないファイルが混じってないか確認
2. 不要なログ・コメントアウトを掃除
3. fixture HTML に**本物の個人情報を入れていないか**再確認
4. `git add -p` で小さい変更ずつ確認しながら add
5. コミットメッセージは `feat: add form field scanner` のように、先頭に種類 (`feat` = 新機能, `fix` = バグ修正, `docs` = 文書, など) を付ける形式で書く (このプロジェクトの慣習)
6. push して PR を作る。テンプレートに沿って Summary / Test plan を書く

---

## 8. 困った時の方針

- **型エラーで詰まった**: メッセージの「expected X, got Y」を読んで、まず「自分のコードが返してる型は何か」を `npm run typecheck` で確認。それでも不明なら Claude に「このエラーが出る、〇〇したい」と聞く
- **テストが落ちる**: assert の左辺(actual)と右辺(expected)を見比べる。actual を出力したかったら `console.log` を入れて `npm test`
- **DOM API が分からない**: MDN の `HTMLInputElement` / `HTMLLabelElement` のページが一次資料
- **「これは Issue のスコープ外かも?」と思った**: 一度手を止めて Issue 本文を読み返す。スコープ外なら別 Issue にして今回はやらない

---

## 9. 次の Issue へのつながり

Issue #9 が終わると次が見えてきます:

- **#10**: ここで返した `ScannedField[]` を、profile field と突き合わせる分類ロジック
- **#11**: 候補をユーザーに見せる suggestion UI
- **#12**: ユーザーが選んだフィールドだけを fill
- **#14**: 動的フォーム / 再スキャン

つまり今回作る `scanFields()` の戻り値の形が**この先 4 つの Issue の基礎**になります。型の設計に少しだけ時間をかける価値あり。

---

頑張ってください。詰まったら Claude にこのドキュメントを参照させると文脈が一発で揃います。
