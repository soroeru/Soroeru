# Visibility探索ベースアーキテクチャ設計

Issue: #239（§8 AIエンジン設計の追加: #272）

## 概要

Visibility機能（Slice A）において、サイトの個人情報を収集するための探索ベースアーキテクチャを設計する。

## 前提条件

1. **サイト構造は全て未知** - 探索後に判明
2. **CSVのURLは不正確な場合がある** - ログインページ探索が必要
3. **個人情報スキーマは動的** - 探索で発見したものを保存
4. **AIは構造のみ受け取り、値は受け取らない** - RFC-002準拠

---

## ルールベース vs AI の判断

各ステップで「決定論的に可能か」を分析：

| ステップ | ルールベースの可能性 | 判定 |
|----------|----------------------|------|
| ログインページ発見 | 「ログイン」「Sign in」等のリンク検出 → 基本ケースは可能 | ルール優先、失敗時AI |
| ログインフォーム検出 | `type="password"`、`autocomplete`属性 → ほぼ可能 | ルールベース |
| ログイン実行 | フィールド入力+submit → 可能 | ルールベース |
| ログイン成功判定 | URL変化、「ログアウト」リンク出現 → 基本は可能 | ルール優先、曖昧時AI |
| プロフィールページ発見 | 「マイページ」「設定」等のリンク → 可能だが網羅性に限界 | ルール優先、AI補助 |
| フィールド分類 | autocomplete、ラベルパターン → 既知フィールドは可能 | ルール優先、未知はAI |
| 新属性タイプ命名 | 規則的な命名は困難 | AI必要 |
| 探索終了判断 | 明確な終了条件なし | AI推奨 |

**結論: ハイブリッドアプローチ**
- ルールベースで可能なことはルールベースで（コスト削減、プライバシー保護）
- ルールで失敗/曖昧な場合にAIフォールバック

---

## アーキテクチャ概要

```
┌─────────────────────────────────────────────────────────────┐
│                    VisibilityOrchestrator                   │
│  (サイトごとの探索・収集フローを統括)                           │
└─────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│  LoginHandler │    │  PageExplorer │    │ FieldCollector│
│  (ログイン処理)│    │  (ページ探索) │    │ (情報収集)    │
└───────────────┘    └───────────────┘    └───────────────┘
        │                     │                     │
        └─────────────────────┼─────────────────────┘
                              ▼
                    ┌───────────────────┐
                    │  DecisionEngine   │
                    │  (判断エンジン)    │
                    │                   │
                    │  ルールベース判断  │
                    │      ↓ 失敗時     │
                    │  AIフォールバック  │
                    └───────────────────┘
```

---

## 0. 共通ユーティリティ

### ファイル: `src/automation/url-utils.ts`

`RuleEngine`と`PageExplorer`の両方がURL重複判定に使うため、正規化ロジックは共通関数として一箇所に置く（`PageExplorer`が保持する`visitedUrls`は正規化済みURLの集合なので、比較する側も同じ正規化を通す必要がある）。

```typescript
/**
 * URL正規化（重複訪問防止用）
 * - フラグメント（#...）を除去
 * - 末尾スラッシュを統一
 */
export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";  // フラグメント除去
    let normalized = parsed.toString();
    // 末尾スラッシュを削除（パスがルートでない場合）
    if (normalized.endsWith("/") && parsed.pathname !== "/") {
      normalized = normalized.slice(0, -1);
    }
    return normalized;
  } catch {
    return url;  // パース失敗時は元のURLを返す
  }
}
```

---

## 1. DecisionEngine（判断エンジン）

ルールベース判断とAIフォールバックを統一的に扱う。

### ファイル: `src/automation/decision-engine.ts`

```typescript
type DecisionKind =
  | "find-login-page"      // ログインページを探す
  | "detect-login-form"    // ログインフォームを検出
  | "judge-login-result"   // ログイン成功/失敗を判定
  | "find-profile-links"   // プロフィール関連リンクを探す
  | "classify-field"       // フィールドを分類
  | "should-continue"      // 探索を続けるべきか
  | "name-new-attribute";  // 新属性の命名

interface DecisionRequest {
  kind: DecisionKind;
  snapshot: PageSnapshot;  // 構造のみ、値なし
  context: DecisionContext;
}

interface DecisionContext {
  currentUrl?: string;
  visitedUrls?: string[];
  collectedAttributes?: string[];  // 既に収集した属性キー
  siteAccount: { domain: string; displayName: string };
  // classify-field用の追加コンテキスト
  field?: FormField;
}

// 注意（実装時）：以下は設計上の擬似コード。resultはkindに対応する型に
// ならないと型チェックが通らないため、実装ではkindをキーにしたマップ型
// （下のDecisionResultMap）とジェネリクスで結果型をDecisionKindに紐付けること。
// 本ドキュメント内の `decision.result.links` のような直接アクセスは、
// `decide<K>` がkindに応じた型を返す前提で読む。
interface DecisionResultMap {
  "find-login-page":    { links: LinkCandidate[] };
  "find-profile-links": { links: LinkCandidate[] };
  "detect-login-form":  { form: LoginFormDetection | null };
  "judge-login-result": { success: boolean; reason: string };
  "classify-field":     { classification: FieldClassification | null };
  "should-continue":    { continue: boolean };
  "name-new-attribute": { attributeKey: string; label: string };
}

interface DecisionResult<K extends DecisionKind = DecisionKind> {
  source: "rule" | "ai";
  confidence: number;
  result: DecisionResultMap[K];  // kindに対応する結果型
}

class DecisionEngine {
  constructor(
    private ruleEngine: RuleEngine,
    private aiEngine?: AiEngine  // optional（§8。ユーザーのAIプロバイダ設定がある場合のみ）
  ) {}

  async decide<K extends DecisionKind>(
    request: DecisionRequest & { kind: K }
  ): Promise<DecisionResult<K>> {
    // 1. まずルールベースで試行
    const ruleResult = this.ruleEngine.evaluate(request);

    if (ruleResult.confident && ruleResult.result !== undefined) {
      return {
        source: "rule",
        confidence: 1.0,
        result: ruleResult.result
      };
    }

    // 2. ルールで判断できない場合、AIにフォールバック（§8 AIEngine）
    if (this.aiEngine) {
      const aiResult = await this.aiEngine.consult(request);
      // AIが判断を返せなかった場合（プロバイダエラー・タイムアウト・
      // 予算超過・応答検証失敗）はnullが返り、下の安全なデフォルトに落ちる
      if (aiResult) return aiResult;
    }

    // 3. AIなし/AI失敗で判断できない場合は安全なデフォルト値を返す
    return {
      source: "rule",
      confidence: 0.3,
      result: this.getDefaultResult(request.kind, ruleResult.result)
    };
  }

  /**
   * AIなしでルールも失敗した場合の安全なデフォルト値
   *
   * 「unconfidentでも部分結果を使ってよいか」はkindごとに性質が異なる（意図的な非対称）:
   * - find-login-page / find-profile-links: 結果はナビゲーション候補にすぎず、
   *   外れても無関係な同一ドメインページを訪問するだけで害がない。
   *   低スコア候補でも試す価値があるため、unconfidentな部分結果をそのまま使う。
   * - judge-login-result: 誤って「成功」と判定すると未認証セッションから
   *   収集を始めてしまうため、RuleEngine側がambiguous時にresultを返さない
   *   （→下のswitchで失敗扱いのデフォルトが適用される）。
   * 状態の断定を伴うkindでは、RuleEngineはunconfidentな部分結果を返さないこと。
   */
  private getDefaultResult(kind: DecisionKind, ruleResult: unknown): DecisionResult["result"] {
    // ルールが部分的に結果を返した場合はそれを使用
    if (ruleResult !== undefined) {
      return ruleResult as DecisionResult["result"];
    }
    // 完全に結果がない場合は安全なデフォルト
    switch (kind) {
      case "find-login-page":
      case "find-profile-links":
        return { links: [] };  // 空のリンクリスト
      case "detect-login-form":
        return { form: null };  // フォームなし
      case "judge-login-result":
        return { success: false, reason: "no-decision" };  // 失敗扱い
      case "classify-field":
        return { classification: null };  // 分類不能
      case "should-continue":
        return { continue: false };  // 探索終了
      case "name-new-attribute":
        return { attributeKey: "unknown", label: "Unknown" };  // 仮の名前
    }
  }

  // AIへの諮問（プロンプト構築・応答検証・予算管理）はAiEngineが所有する（§8）
}
```

---

## 2. RuleEngine（ルールベース判断）

### ファイル: `src/automation/rule-engine.ts`

```typescript
import { normalizeUrl } from "./url-utils";

class RuleEngine {
  evaluate(request: DecisionRequest): RuleResult {
    switch (request.kind) {
      case "find-login-page":
        return this.findLoginPageLinks(request.snapshot);
      case "detect-login-form":
        return this.detectLoginForm(request.snapshot);
      case "judge-login-result":
        return this.judgeLoginResult(request.snapshot, request.context);
      case "find-profile-links":
        return this.findProfileLinks(request.snapshot, request.context);
      case "classify-field":
        return this.classifyField(request);
      case "should-continue":
        return this.shouldContinue(request.context);
      case "name-new-attribute":
        // 新属性の命名はルールでは困難
        return { confident: false };
    }
  }

  private findLoginPageLinks(snapshot: PageSnapshot): RuleResult {
    const keywords = [
      /ログイン/i, /サインイン/i, /sign\s*in/i, /log\s*in/i,
      /会員.*ログイン/i, /ログオン/i
    ];

    const candidates = snapshot.links
      .filter(link => keywords.some(kw => kw.test(link.text)))
      .map(link => ({
        href: link.href,
        text: link.text,
        score: this.scoreLoginLink(link)
      }))
      .sort((a, b) => b.score - a.score);

    return {
      confident: candidates.length > 0 && candidates[0].score > 0.7,
      result: { links: candidates }
    };
  }

  private detectLoginForm(snapshot: PageSnapshot): RuleResult {
    // パスワードフィールドを持つフォームを探す
    const passwordFields = snapshot.fields.filter(f =>
      f.type === "password" ||
      f.autocomplete?.includes("password")
    );

    if (passwordFields.length === 0) {
      return { confident: true, result: { form: null } };
    }

    // 対応するユーザー名フィールドを探す
    const usernameField = snapshot.fields.find(f =>
      f.type === "email" ||
      f.autocomplete?.includes("username") ||
      f.autocomplete?.includes("email") ||
      /user|email|login|id|account/i.test(f.name + f.id)
    );

    // 送信ボタンを探す
    const submitButton = snapshot.buttons.find(b =>
      /ログイン|サインイン|sign\s*in|log\s*in|submit|送信/i.test(b.text)
    ) ?? snapshot.buttons.find(b => b.selector.includes("[type='submit']"));

    // ユーザー名フィールドが見つからない場合は form: null を返す
    // （confident: false で部分的な form を返すと undefined フィールドで fillField が呼ばれる）
    if (!usernameField) {
      return {
        confident: false,
        result: { form: null }
      };
    }

    return {
      confident: true,
      result: {
        form: {
          usernameFieldId: usernameField.fieldId,
          passwordFieldId: passwordFields[0].fieldId,
          submitSelector: submitButton?.selector
        }
      }
    };
  }

  private judgeLoginResult(
    snapshot: PageSnapshot,
    context: DecisionContext
  ): RuleResult {
    // 成功の兆候
    const successIndicators = [
      // 「ログアウト」リンクの存在
      snapshot.links.some(l => /ログアウト|sign\s*out|log\s*out/i.test(l.text)),
      // 「マイページ」リンクの存在
      snapshot.links.some(l => /マイページ|my\s*page|dashboard/i.test(l.text)),
      // URL変化（ログインページから離れた）
      // 注：currentUrlがundefinedの場合は中立（カウントしない）
      context.currentUrl != null && !context.currentUrl.includes("login")
    ];

    // 失敗の兆候
    const failureIndicators = [
      // パスワードフィールドがまだある
      snapshot.fields.some(f => f.type === "password"),
      // エラーメッセージっぽいテキスト
      /エラー|error|失敗|incorrect|invalid|wrong/i.test(snapshot.visibleText)
    ];

    const successScore = successIndicators.filter(Boolean).length;
    const failureScore = failureIndicators.filter(Boolean).length;

    if (successScore >= 2 && failureScore === 0) {
      return { confident: true, result: { success: true, reason: "success-indicators" } };
    }
    if (failureScore >= 1 && successScore === 0) {
      return { confident: true, result: { success: false, reason: "failure-indicators" } };
    }

    // 判断が難しい場合はresultを返さない
    // （ヒューリスティックな多数決を「判定結果」として確定させず、
    //   DecisionEngine.getDefaultResultの安全なデフォルト＝失敗扱いに委ねる）
    return { confident: false };
  }

  private findProfileLinks(
    snapshot: PageSnapshot,
    context: DecisionContext
  ): RuleResult {
    const keywords = [
      // 一般的なプロフィール系
      { pattern: /マイページ|my\s*page/i, priority: 1 },
      { pattern: /会員情報|登録情報|プロフィール|profile/i, priority: 2 },
      { pattern: /アカウント.*設定|account.*setting/i, priority: 2 },
      { pattern: /個人情報|personal/i, priority: 3 },
      // 具体的な情報カテゴリ
      { pattern: /住所|配送先|address|delivery/i, priority: 4 },
      { pattern: /クレジットカード|お支払い|payment|card/i, priority: 4 },
      { pattern: /連絡先|contact/i, priority: 4 },
      { pattern: /セキュリティ|security|パスワード/i, priority: 4 },
    ];

    const candidates: LinkCandidate[] = [];

    for (const link of snapshot.links) {
      // 既に訪問済みはスキップ
      // （context.visitedUrlsはPageExplorerが正規化済みURLで保持しているため、
      //   比較する側のhrefも同じnormalizeUrlを通してから比較する）
      if (context.visitedUrls?.includes(normalizeUrl(link.href))) continue;
      // 外部リンクはスキップ
      if (!this.isSameDomain(link.href, context.siteAccount.domain)) continue;

      for (const kw of keywords) {
        if (kw.pattern.test(link.text)) {
          candidates.push({
            href: link.href,
            text: link.text,
            category: this.categorizeLink(link.text),
            priority: kw.priority
          });
          break;
        }
      }
    }

    // 優先度順にソート
    candidates.sort((a, b) => a.priority - b.priority);

    return {
      confident: candidates.length > 0,
      result: { links: candidates }
    };
  }
}
```

---

## 3. PageExplorer（ページ探索器）

### ファイル: `src/automation/page-explorer.ts`

```typescript
import { normalizeUrl } from "./url-utils";

interface ExplorationState {
  siteAccountId: string;
  domain: string;
  // 探索対象のページ（ログイン済みセッション）。
  // Orchestratorがサイトごとに新しいpageDriverを作るため、コンストラクタ注入では
  // 2サイト目以降が古いページを参照してしまう。exploreの引数で受け取り状態に持つ。
  pageDriver: PageDriver;
  visitedUrls: Set<string>;
  pendingUrls: string[];  // 探索待ちURL
  deferredUrls: string[]; // 壁検出でスキップされ、ハンドオフ後に再訪問するURL
  collectedPages: PageCollectionResult[];
  walls: WallDetection[];
}

class PageExplorer {
  // 探索状態をインスタンス変数として保持（壁ハンドオフ後のresume用）
  private currentState: ExplorationState | null = null;

  constructor(
    private decisionEngine: DecisionEngine,
    private wallDetector: WallDetector
  ) {}

  /**
   * 壁解決後に探索を再開
   * ユーザーが同一ブラウザセッションで壁（CAPTCHA/MFA等）を解決した後に呼び出す
   */
  async *resume(): AsyncGenerator<ExplorationEvent> {
    if (!this.currentState) {
      throw new Error("No exploration state to resume");
    }
    // deferredUrlsをpendingUrlsに戻して探索再開
    this.currentState.pendingUrls.push(...this.currentState.deferredUrls);
    this.currentState.deferredUrls = [];
    yield* this.continueExploration();
  }

  async *explore(
    pageDriver: PageDriver,
    startUrl: string,
    siteAccount: SiteAccount
  ): AsyncGenerator<ExplorationEvent> {
    // 状態をインスタンス変数として保持（resume用）
    // pageDriverも状態の一部（resume時は同一セッションで続行する必要がある）
    this.currentState = {
      siteAccountId: siteAccount.id,
      domain: siteAccount.domain,
      pageDriver,
      visitedUrls: new Set(),
      pendingUrls: [startUrl],
      deferredUrls: [],
      collectedPages: [],
      walls: []
    };

    yield* this.continueExploration();
  }

  /**
   * 探索の実際のループ処理（exploreとresumeで共有）
   */
  private async *continueExploration(): AsyncGenerator<ExplorationEvent> {
    const state = this.currentState!;
    const pageDriver = state.pageDriver;

    while (state.pendingUrls.length > 0) {
      const url = state.pendingUrls.shift()!;

      // URL正規化（フラグメント除去、末尾スラッシュ統一）
      const normalizedUrl = normalizeUrl(url);
      if (state.visitedUrls.has(normalizedUrl)) continue;

      yield { kind: "navigating", url: normalizedUrl };

      await pageDriver.goto(normalizedUrl);
      await pageDriver.waitForReady();

      // 壁チェック
      const wall = await this.wallDetector.detect(await pageDriver.snapshot());
      if (wall) {
        state.walls.push(wall);
        // 壁を検出した場合、このURLをdeferredUrlsに追加してハンドオフ
        // 注：visitedUrlsには追加しない（resume時に再訪問するため）
        state.deferredUrls.push(normalizedUrl);
        yield {
          kind: "wall-detected",
          wall,
          url: normalizedUrl,
          // ハンドオフイベント：ユーザーに制御を渡す
          handoff: {
            reason: wall.kind,
            evidence: wall.evidence,
            resumable: true
          }
        };
        // 壁を解決するまで探索を一時停止
        // （呼び出し側がresumeを呼ぶまで待機）
        // 状態はthis.currentStateに保持されているのでresumeで継続可能
        return;
      }

      // 壁がなければ訪問済みとしてマーク（壁検出後はマークしない）
      state.visitedUrls.add(normalizedUrl);

      // ページ収集
      const snapshot = await pageDriver.snapshot();
      yield { kind: "page-snapshot", url, snapshot };

      // 次に訪問すべきリンクを判断
      const decision = await this.decisionEngine.decide({
        kind: "find-profile-links",
        snapshot,
        context: this.buildContext(state)
      });

      if (decision.result.links) {
        for (const link of decision.result.links) {
          // 正規化してから重複チェック（visitedUrlsは正規化済みURLを保持）
          const normalizedHref = normalizeUrl(link.href);
          if (!state.visitedUrls.has(normalizedHref) &&
              !state.pendingUrls.includes(normalizedHref)) {
            state.pendingUrls.push(normalizedHref);
          }
        }
      }

      // 探索を続けるべきか判断
      const continueDecision = await this.decisionEngine.decide({
        kind: "should-continue",
        snapshot,
        context: this.buildContext(state)
      });

      if (!continueDecision.result.continue) {
        this.currentState = null;  // 探索完了、状態クリア
        yield { kind: "exploration-complete", reason: "decision-engine" };
        return;
      }
    }

    this.currentState = null;  // 探索完了、状態クリア
    yield { kind: "exploration-complete", reason: "no-more-urls" };
  }
}
```

---

## 4. FieldCollector（フィールド収集）

### ファイル: `src/automation/field-collector.ts`

```typescript
interface CollectedField {
  fieldId: string;
  attributeKey: string | null;  // 分類できた場合
  labelText: string;
  value: string;  // ローカルで読み取った値（カード情報はサニタイズ済み）
  sourcePageUrl: string;  // 収集元ページURL（Disclosure記録用）
  classificationSource: "rule" | "ai" | "unclassified";
  confidence: number;
}

class FieldCollector {
  // pageDriverはコンストラクタ注入しない（Orchestratorがサイトごとに
  // 新しいpageDriverを作るため、collectFromPageの引数で毎回受け取る）
  constructor(
    private decisionEngine: DecisionEngine,
    private domainService: DomainService
  ) {}

  /**
   * セキュリティ要件：カード情報の取り扱い
   * - card.number: 下4桁のみ保存（例: "****1234"）
   * - card.cvv: 収集・保存・表示しない（完全に除外）
   * 参照: docs/requirements.md, docs/security.md
   */
  private sanitizeCardValue(attributeKey: string, value: string): string | null {
    if (attributeKey === "card.cvv" || attributeKey === "card.security-code") {
      // CVVは絶対に収集しない
      return null;
    }
    if (attributeKey === "card.number") {
      // カード番号は下4桁のみ保存
      const digits = value.replace(/\D/g, "");
      // 実在のカード番号は13〜19桁（looksLikeCardDataと同じ範囲）。
      // 範囲外（3〜4桁のCVVや、OCR/連結で長すぎる数字列など）は
      // classify-fieldの誤分類が疑われ、slice(-4)では元の桁がそのまま
      // 残ってしまう場合もあるため、保存せず破棄する。
      if (digits.length < 13 || digits.length > 19) {
        return null;
      }
      return `****${digits.slice(-4)}`;
    }
    return value;
  }

  /**
   * 未分類フィールドの値がカード情報っぽいかを検出
   * 分類ミスによるCVV/カード番号の漏洩を防ぐ防御的ヒューリスティック
   */
  private looksLikeCardData(value: string): boolean {
    const digits = value.replace(/\D/g, "");
    // 3-4桁の数字のみ → CVV候補
    if (/^\d{3,4}$/.test(value.trim())) {
      return true;
    }
    // 13-19桁の数字 → カード番号候補（Luhnチェックは実装で追加可能）
    if (digits.length >= 13 && digits.length <= 19) {
      return true;
    }
    return false;
  }

  async collectFromPage(
    pageDriver: PageDriver,
    siteAccount: SiteAccount,
    snapshot: PageSnapshot
  ): Promise<CollectionResult> {
    const results: CollectedField[] = [];
    const dynamicCandidates: DynamicAttributeCandidate[] = [];

    // フォームフィールドを処理
    const fieldValues = await pageDriver.readValues();

    for (const field of snapshot.fields) {
      const value = fieldValues[field.fieldId];
      if (!value || value.trim() === "") continue;

      // 分類を試みる
      const classification = await this.classifyField(field, snapshot, siteAccount);

      if (classification.attributeKey) {
        // カード情報のサニタイズ（CVV除外、番号は下4桁のみ）
        const sanitizedValue = this.sanitizeCardValue(
          classification.attributeKey,
          value
        );
        // CVVの場合はnullが返るのでスキップ
        if (sanitizedValue === null) continue;

        // 分類ミス対策：card.*以外に分類されてもカード形状ならドロップ
        // （例：CVVが誤ってphone等に分類された場合の保護）
        if (!classification.attributeKey.startsWith("card.") &&
            this.looksLikeCardData(value)) {
          // カードデータっぽいのにcard.*ではない → 分類ミスの可能性、安全のためスキップ
          continue;
        }

        results.push({
          fieldId: field.fieldId,
          attributeKey: classification.attributeKey,
          labelText: field.labels.join(" ") || field.nearbyText,
          value: sanitizedValue,
          sourcePageUrl: snapshot.url,
          classificationSource: classification.source,
          confidence: classification.confidence
        });
      } else {
        // 分類できなかった場合、動的属性の候補として提案
        // ただし、カード情報っぽい値は安全のためドロップ
        if (this.looksLikeCardData(value)) {
          // CVV/カード番号の可能性があるため候補に含めない
          continue;
        }
        dynamicCandidates.push({
          fieldId: field.fieldId,
          suggestedLabel: field.labels[0] || field.nearbyText || field.name,
          sampleValue: this.maskValue(value),  // マスク済み
          sourcePageUrl: snapshot.url
        });
      }
    }

    // 表示要素を処理
    if (snapshot.displayValues) {
      const displayValues = await pageDriver.readDisplayValues();

      for (const display of snapshot.displayValues) {
        const value = displayValues[display.valueId];
        if (!value || value.trim() === "") continue;

        const classification = await this.classifyDisplayValue(
          display.labelText,
          display.nearbyText
        );

        if (classification.attributeKey) {
          // カード情報のサニタイズ（CVV除外、番号は下4桁のみ）
          const sanitizedValue = this.sanitizeCardValue(
            classification.attributeKey,
            value
          );
          // CVVの場合はnullが返るのでスキップ
          if (sanitizedValue === null) continue;

          // 分類ミス対策：card.*以外に分類されてもカード形状ならドロップ
          if (!classification.attributeKey.startsWith("card.") &&
              this.looksLikeCardData(value)) {
            continue;
          }

          results.push({
            fieldId: display.valueId,
            attributeKey: classification.attributeKey,
            labelText: display.labelText,
            value: sanitizedValue,
            sourcePageUrl: snapshot.url,
            classificationSource: classification.source,
            confidence: classification.confidence
          });
        } else {
          // カード情報っぽい値は安全のためドロップ
          if (this.looksLikeCardData(value)) {
            continue;
          }
          dynamicCandidates.push({
            fieldId: display.valueId,
            suggestedLabel: display.labelText || display.nearbyText,
            sampleValue: this.maskValue(value),
            sourcePageUrl: snapshot.url
          });
        }
      }
    }

    return { fields: results, dynamicCandidates };
  }

  private async classifyField(
    field: FormField,
    snapshot: PageSnapshot,
    siteAccount: SiteAccount
  ): Promise<FieldClassification> {
    // 1. autocomplete属性（最優先）
    if (field.autocomplete) {
      const mapped = this.mapAutocomplete(field.autocomplete);
      if (mapped) {
        return { attributeKey: mapped, source: "rule", confidence: 1.0 };
      }
    }

    // 2. 既存のルールベース分類器
    const ruleResult = classifyByRules(field);
    if (ruleResult && ruleResult.confidence > 0.7) {
      return { ...ruleResult, source: "rule" };
    }

    // 3. DecisionEngineに委ねる（RuleEngine.classifyFieldのラベル/周辺テキストに
    //    よる追加ルール判定 → 曖昧ならAIフォールバック、の順で試行される）
    const decided = await this.decisionEngine.decide({
      kind: "classify-field",
      snapshot,
      context: { field, siteAccount: { domain: siteAccount.domain, displayName: siteAccount.displayName } }
    });

    if (decided.result.classification) {
      return decided.result.classification;
    }

    // 4. 分類不能
    return { attributeKey: null, source: "unclassified", confidence: 0 };
  }
}
```

---

## 5. 動的属性スキーマ

### ファイル: `src/domain/dynamic-attribute.ts`

```typescript
/**
 * 探索で発見した未知のフィールドを動的属性として管理
 */
interface DynamicAttributeCandidate {
  id: string;
  suggestedKey: string;      // AI/ルールが提案したキー
  suggestedLabel: string;    // UI表示用ラベル
  sampleValue: string;       // マスク済みサンプル値
  sourcePageUrl: string;
  siteAccountId: string;
  status: "pending" | "confirmed" | "rejected";
  createdAt: number;
}

/**
 * ユーザー確認後の再利用可能な属性定義
 */
interface ConfirmedDynamicAttribute {
  key: string;          // e.g., "rakuten.point_number"
  label: string;        // e.g., "楽天ポイント番号"
  valueType: "text" | "number" | "date" | "masked";
  scope: "site" | "global";  // このサイト固有か、全サイト共通か
  createdFrom: string;  // 元のcandidateId
}

// DomainServiceに追加
class DomainService {
  // 動的属性候補を記録（探索時に呼ばれる）
  async recordDynamicCandidate(
    candidate: Omit<DynamicAttributeCandidate, "id" | "status" | "createdAt">
  ): Promise<string>;

  // ユーザーが候補を確認して属性として採用
  async confirmDynamicAttribute(
    candidateId: string,
    confirmedKey: string,
    confirmedLabel: string,
    scope: "site" | "global"
  ): Promise<ConfirmedDynamicAttribute>;

  // 確認済みの動的属性を取得
  async getConfirmedDynamicAttributes(): Promise<ConfirmedDynamicAttribute[]>;
}
```

---

## 6. VisibilityOrchestrator（全体統括）

### ファイル: `src/automation/visibility-orchestrator.ts`

```typescript
class VisibilityOrchestrator {
  // 壁ハンドオフ時の中断状態を保持
  private currentSiteAccount: SiteAccount | null = null;
  private currentPageDriver: PageDriver | null = null;
  private pendingCollectedFields: CollectedField[] = [];
  private pendingDynamicCandidates: DynamicAttributeCandidate[] = [];

  constructor(
    private browserEngine: BrowserEngine,
    private loginHandler: LoginHandler,
    private pageExplorer: PageExplorer,
    private fieldCollector: FieldCollector,
    private domainService: DomainService,
    private decisionEngine: DecisionEngine
  ) {}

  /**
   * 壁解決後に探索を再開
   * ユーザーが同一ブラウザセッションで壁を解決した後に呼び出す
   */
  async *resumeForSite(): AsyncGenerator<VisibilityEvent> {
    if (!this.currentSiteAccount || !this.currentPageDriver) {
      throw new Error("No exploration state to resume");
    }

    const siteAccount = this.currentSiteAccount;
    const allCollectedFields = this.pendingCollectedFields;
    const allDynamicCandidates = this.pendingDynamicCandidates;
    let wallDetectedDuringExplore = false;

    // PageExplorerのresumeを呼んで探索を続行
    for await (const event of this.pageExplorer.resume()) {
      yield { phase: "explore", ...event };

      if (event.kind === "wall-detected") {
        wallDetectedDuringExplore = true;
        break;
      }

      if (event.kind === "page-snapshot") {
        const collectionResult = await this.fieldCollector.collectFromPage(
          this.currentPageDriver!,
          siteAccount,
          event.snapshot
        );

        allCollectedFields.push(...collectionResult.fields);
        allDynamicCandidates.push(...collectionResult.dynamicCandidates);

        yield {
          phase: "collect",
          url: event.url,
          fieldsCollected: collectionResult.fields.length,
          candidatesFound: collectionResult.dynamicCandidates.length
        };
      }
    }

    if (wallDetectedDuringExplore) {
      this.pendingCollectedFields = allCollectedFields;
      this.pendingDynamicCandidates = allDynamicCandidates;
      return;
    }

    // 探索完了、保存処理へ
    yield* this.saveAndComplete(siteAccount, allCollectedFields, allDynamicCandidates);
  }

  async *runForSite(
    siteAccount: SiteAccount,
    credential: Credential
  ): AsyncGenerator<VisibilityEvent> {
    const page = await this.browserEngine.newPage();
    const pageDriver = new PlaywrightPageDriver(page);

    // 状態を保存（resume用）
    this.currentSiteAccount = siteAccount;
    this.currentPageDriver = pageDriver;
    this.pendingCollectedFields = [];
    this.pendingDynamicCandidates = [];

    try {
      // Phase 1: ログイン
      yield { phase: "login", status: "starting" };

      const loginResult = await this.loginHandler.login(
        pageDriver,
        credential,
        siteAccount
      );

      if (!loginResult.success) {
        if (loginResult.wall) {
          yield {
            phase: "login",
            status: "wall",
            wall: loginResult.wall,
            // ハンドオフイベント：ユーザーに制御を渡す
            handoff: {
              reason: loginResult.wall.kind,
              evidence: loginResult.wall.evidence,
              resumable: true
            }
          };
          // ハンドオフ待ち - 呼び出し側が壁解決後にresumeを呼ぶ
          // ここでは一旦終了し、resumeForSiteで再開
          return;
        } else {
          yield { phase: "login", status: "failed", error: loginResult.error };
          return;
        }
      }

      yield { phase: "login", status: "success" };

      // Phase 2: ページ探索
      yield { phase: "explore", status: "starting" };

      const allCollectedFields: CollectedField[] = [];
      const allDynamicCandidates: DynamicAttributeCandidate[] = [];
      let wallDetectedDuringExplore = false;

      for await (const event of this.pageExplorer.explore(
        pageDriver,
        pageDriver.currentUrl(),
        siteAccount
      )) {
        yield { phase: "explore", ...event };

        // 壁検出時は探索を中断してハンドオフ
        if (event.kind === "wall-detected") {
          wallDetectedDuringExplore = true;
          // 壁イベントは既にyieldされている
          // 呼び出し側がresumeForSiteを呼ぶまで待機
          // 部分的に収集したデータは保持（resume時に続きから）
          break;
        }

        if (event.kind === "page-snapshot") {
          // Phase 3: 各ページで情報収集
          const collectionResult = await this.fieldCollector.collectFromPage(
            pageDriver,
            siteAccount,
            event.snapshot
          );

          allCollectedFields.push(...collectionResult.fields);
          allDynamicCandidates.push(...collectionResult.dynamicCandidates);

          yield {
            phase: "collect",
            url: event.url,
            fieldsCollected: collectionResult.fields.length,
            candidatesFound: collectionResult.dynamicCandidates.length
          };
        }
      }

      // 壁検出時は保存せずに中断（resume時に続きを行う）
      if (wallDetectedDuringExplore) {
        // 部分結果をインスタンス変数に保存（resume用）
        this.pendingCollectedFields = allCollectedFields;
        this.pendingDynamicCandidates = allDynamicCandidates;
        return;
      }

      // 探索完了、保存処理へ
      yield* this.saveAndComplete(siteAccount, allCollectedFields, allDynamicCandidates);

    } finally {
      // 完了後は状態をクリア（ただしページは開いたまま）
      // page.close()は呼び出し側の責任（複数サイト処理時の制御のため）
    }
  }

  /**
   * Phase 4: 収集データの保存と完了処理
   */
  private async *saveAndComplete(
    siteAccount: SiteAccount,
    allCollectedFields: CollectedField[],
    allDynamicCandidates: DynamicAttributeCandidate[]
  ): AsyncGenerator<VisibilityEvent> {
    yield { phase: "save", status: "starting" };

    const visitedPages = new Set<string>();
    for (const field of allCollectedFields) {
      visitedPages.add(field.sourcePageUrl);
      await this.domainService.addDisclosure(
        siteAccount.id,
        field.attributeKey!,
        field.value,
        {
          sourcePageUrl: field.sourcePageUrl,
          confidence: field.confidence,
          classificationSource: field.classificationSource
        }
      );
    }

    // 動的属性候補を記録
    for (const candidate of allDynamicCandidates) {
      await this.domainService.recordDynamicCandidate(candidate);
    }

    // 状態をクリア
    this.currentSiteAccount = null;
    this.currentPageDriver = null;
    this.pendingCollectedFields = [];
    this.pendingDynamicCandidates = [];

    yield {
      phase: "complete",
      summary: {
        pagesVisited: visitedPages.size,
        disclosuresCollected: allCollectedFields.length,
        dynamicCandidates: allDynamicCandidates.length
      }
    };
  }
}
```

---

## 7. LoginHandler（ログイン処理）

### ファイル: `src/automation/login-handler.ts`

```typescript
class LoginHandler {
  constructor(
    private decisionEngine: DecisionEngine,
    private wallDetector: WallDetector
  ) {}

  async login(
    pageDriver: PageDriver,
    credential: Credential,
    siteAccount: SiteAccount
  ): Promise<LoginResult> {
    // Step 1: 起点URLにアクセス
    await pageDriver.goto(credential.loginUrl);
    await pageDriver.waitForReady();

    let snapshot = await pageDriver.snapshot();

    // Step 2: ログインフォームを検出
    let formDetection = await this.decisionEngine.decide({
      kind: "detect-login-form",
      snapshot,
      context: { siteAccount }
    });

    // フォームが見つからない場合、ログインページを探す
    if (!formDetection.result.form) {
      const loginPageResult = await this.findLoginPage(pageDriver, siteAccount);
      if (!loginPageResult.success) {
        return { success: false, error: "login-page-not-found" };
      }
      snapshot = await pageDriver.snapshot();
      formDetection = await this.decisionEngine.decide({
        kind: "detect-login-form",
        snapshot,
        context: { siteAccount }
      });
    }

    if (!formDetection.result.form) {
      return { success: false, error: "login-form-not-found" };
    }

    // Step 3: 壁チェック
    const wall = await this.wallDetector.detect(snapshot);
    if (wall) {
      return { success: false, wall };
    }

    // Step 4: ログイン実行
    const form = formDetection.result.form;

    await pageDriver.fillField(form.usernameFieldId, credential.username);
    await pageDriver.fillField(form.passwordFieldId, credential.password);

    if (form.submitSelector) {
      await pageDriver.click(form.submitSelector);
    }

    await pageDriver.waitForReady();

    // Step 5: 結果判定
    snapshot = await pageDriver.snapshot();

    // 壁チェック（ログイン後にMFA等が出る場合）
    const postLoginWall = await this.wallDetector.detect(snapshot);
    if (postLoginWall) {
      return { success: false, wall: postLoginWall };
    }

    const judgeResult = await this.decisionEngine.decide({
      kind: "judge-login-result",
      snapshot,
      context: { currentUrl: pageDriver.currentUrl(), siteAccount }
    });

    return {
      success: judgeResult.result.success,
      error: judgeResult.result.success ? undefined : "login-failed"
    };
  }

  private async findLoginPage(
    pageDriver: PageDriver,
    siteAccount: SiteAccount
  ): Promise<{ success: boolean }> {
    // ドメインのトップページにアクセス
    await pageDriver.goto(`https://${siteAccount.domain}/`);
    await pageDriver.waitForReady();

    const snapshot = await pageDriver.snapshot();

    const result = await this.decisionEngine.decide({
      kind: "find-login-page",
      snapshot,
      context: { siteAccount }
    });

    if (result.result.links && result.result.links.length > 0) {
      // 最も有望なリンクに遷移
      await pageDriver.goto(result.result.links[0].href);
      await pageDriver.waitForReady();
      return { success: true };
    }

    return { success: false };
  }
}
```

---

## 8. AIEngine（AIフォールバックエンジン）

Issue: #272。`DecisionEngine`のルールベース判断が`confident: false`を返したときに
使うAIフォールバックの実体を設計する（AIエンジンの実装自体は#272の非スコープ。
実装は別Issueで行う）。

### 位置づけと原則

- **決定論が既定、AIはオプション強化**（REQ-013）。AIプロバイダ未設定でも全フローは
  動作し、ルール失敗時は`getDefaultResult`の安全なデフォルトに落ちる。AIの有無で
  変わるのは収集の網羅性だけで、安全性の性質は変わらない。
- **構造のみ送信、値は送らない**（docs/requirements.md §8、docs/security.md）。
  何を送ってよいかは下の「送信データのサニタイズ」が唯一の基準。
- **プロバイダ層は新設しない**。既存の`src/agent/ai/provider.ts`
  （`AiProvider.completeJson({ system, user, schema })`、`AnthropicProvider` /
  `OpenAiProvider`、stateless（キャッシュ・スレッド・保存なし）、`AiProviderError`）
  をそのまま再利用する。
- **APIキーの供給**: PoC/探索フェーズは`.env`の`OPENAI_API_KEY`
  （`npm run poc`が`node --env-file-if-exists=.env`で読み込む。既存の
  `aiProviderFromEnv()`はOPENAI優先・`ANTHROPIC_API_KEY`代替）。アプリ本体では
  暗号化設定ストアの`ProviderConfig` → `createProvider()`。キーはログ・Evidence・
  保存物に決して書かない。

### ファイル: `src/automation/ai-engine.ts`

```typescript
import type { AiProvider } from "../agent/ai/provider";  // 既存契約を再利用

interface AiEngineOptions {
  timeoutMs?: number;              // 1呼び出しの上限。既定 30_000
  maxCallsPerSite?: number;        // サイトごとの呼び出し予算。既定 20
  maxConsecutiveFailures?: number; // 連続失敗でこのrunの残りをAI無効化。既定 3
}

/** AI諮問1回分の観測ログ（本文は含めない） */
interface AiConsultationLog {
  kind: DecisionKind;
  // AI送信時と同じ規則でクエリ/フラグメントを除去したorigin+pathのみ
  // （セッショントークン等を進捗表示にも出さない）。context.currentUrl
  // 由来で、未設定のkindでは空文字。
  url: string;
  providerId: string;   // 例 "openai:gpt-5.4"
  latencyMs: number;
  outcome: "used" | "provider-error" | "timeout" | "invalid-response" | "budget-exceeded";
}

/**
 * レダクション用のローカル値ソース（下の「送信データのサニタイズ」）。
 * このrunで収集済みの値と、正準Personal Attributesの復号値を、送信前の
 * ローカル照合のためだけにメモリ上で提供する。復号値は照合にのみ使い、
 * ログ・プロンプト・保存物には決して出さない。組み立て（Orchestratorの
 * pendingCollectedFieldsとDomainService/vaultからの供給）は、onLogと同じく
 * Orchestratorを組み立てる側の責務。
 */
interface RedactionValueSource {
  /** 照合対象の値一覧（復号済み、メモリ上のみ）。呼び出し時点の最新を返す。 */
  currentValues(): readonly string[];
}

class AiEngine {
  constructor(
    private provider: AiProvider,
    private redactionSource: RedactionValueSource,
    private options?: AiEngineOptions,
    private onLog?: (entry: AiConsultationLog) => void
  ) {}

  /**
   * ルールが判断できなかったDecisionRequestをAIに諮る。
   * 判断を返せない場合（プロバイダエラー・タイムアウト・応答検証失敗・
   * 予算超過）はnullを返し、DecisionEngineが安全なデフォルトに落とす。
   * リトライはしない（同一入力は同一失敗になりやすく、探索全体を遅くするだけ）。
   */
  async consult<K extends DecisionKind>(
    request: DecisionRequest & { kind: K }
  ): Promise<DecisionResult<K> | null>;
}
```

`DecisionEngine`との関係: コンストラクタに`aiEngine?: AiEngine`を受け取り（§1）、
ルール失敗時に`consult`へ委譲する。`consult`がnullを返したら`getDefaultResult`。

インスタンスと予算のライフサイクル: `AiEngine`は**1 run（`VisibilityOrchestrator`
による一連の複数サイト処理）につき1インスタンス**を、Orchestratorを組み立てる側
（CLI/アプリ）が生成して注入する。`maxCallsPerSite`のカウンタは
`request.context.siteAccount.domain`をキーにインスタンス内に保持し、
`maxConsecutiveFailures`のブレーカはrun全体（インスタンス）スコープ。
いずれもインスタンス破棄（=次のrun）でリセットされる。

### プロンプト契約（kind別）

`completeJson`のJSONスキーマは§1の`DecisionResultMap`と同形の応答を要求する
（`confidence: number`を各応答に追加。スキーマで`minimum: 0, maximum: 1`を
制約し、エンジン側でも[0, 1]にクランプする — ルール経路の固定値1.0 / 0.3と
台帳側で比較可能に保つ。`source`は常に`"ai"`をエンジン側で付与）。

| kind | AIに送る構造 | 応答（DecisionResultMap準拠） | 応答の追加検証 |
|------|--------------|------------------------------|----------------|
| find-login-page / find-profile-links | `links`（text + サニタイズ済みhref）、title、URL | `{ links: LinkCandidate[] }` | hrefがスナップショットに**実在するリンクのみ**採用（AIが捏造したURLへは遷移しない） |
| detect-login-form | `fields`（fieldId / name / id / type / autocomplete / labels / placeholder / nearbyText）、`buttons` | `{ form: LoginFormDetection \| null }` | fieldId / submitSelectorの実在検証 |
| judge-login-result | `fields`の型情報、`links`、`buttons`、title、URL（**visibleTextは送らない** — 下記） | `{ success: boolean; reason: string }` | なし |
| classify-field | 対象フィールドの構造（既存`ai-mapper.ts`と同じ基準: labels / nearbyText / placeholder / name / id / type / autocomplete）+ 既知属性キー一覧のガイド | `{ classification: FieldClassification \| null }` | attributeKeyは既知キーまたは動的候補フォーマット（name-new-attributeと同じ`[a-z0-9._-]`規則）に限定 |
| should-continue | 訪問済み/未訪問リンクのカテゴリ要約、`collectedAttributes`（属性**キー**のみ） | `{ continue: boolean }` | なし |
| name-new-attribute | フォームフィールド由来の候補: labels / placeholder / nearbyText。表示要素（displayValues）由来の候補: **labelTextのみ**（§4の`suggestedLabel`は`display.nearbyText`へのフォールバックを含むため、display由来ではsuggestedLabelをそのまま送らず`labelText`に差し替える）。いずれも**sampleValueはマスク済みでも送らない** | `{ attributeKey: string; label: string }` | キーは`[a-z0-9._-]`に正規化（§5の例`rakuten.point_number`と同形式）。`card.`プレフィックスは提案禁止（カード系は既知キーのみ） |

### 送信データのサニタイズ（`toAiPayload`）

`PageSnapshot`をそのままAIに渡してはならない。送信前に必ず`toAiPayload`を通す:

- **常に除外**: フィールド値（`snapshot()`は構造のみだが、`readValues()` /
  `readDisplayValues()`の結果を混ぜない）、`visibleText`（ログイン後ページでは
  氏名・住所等の個人情報の値そのものを含むため）、`displayValues`の値
  （labelTextのみ可）、credential、`iframeSrcs`のクエリ部分。
- **URL / hrefはクエリ文字列とフラグメントを除去**（セッショントークンや
  メールアドレス入りクエリの漏洩防止）。オリジン+パスのみ送る。
- **フォームフィールドのlabels / nearbyText / placeholderは送信可**
  （既存`ai-mapper.ts`と同じ基準: フォーム構造の一部でありユーザーの値ではない）。
  ただし**表示要素（displayValues）のnearbyTextは送らない**（`<dt>氏名</dt>
  <dd>山田太郎</dd>`のように値が混ざるため。labelTextのみ）。
- **リンクテキスト・ボタンテキスト・titleはローカル照合でレダクションしてから
  送る**: ログイン後ページでは「ようこそ 山田太郎 様」のようにユーザーの値が
  リンク/見出し/タイトルに埋まる。`toAiPayload`は、`RedactionValueSource`
  （上記。このrunで収集済みの値+正準Personal Attributesの復号値を照合専用に
  供給する注入契約）の値に部分一致するテキスト片を送信前にローカルで
  伏せ字化する（照合はメモリ上でローカルに完結するため追加開示は生じない）。
  未収集の値が埋まっているケースは残余リスクとして制約6に記録する。
- 検証はテストで担保する: 番兵値（実在しないダミーの個人情報値）を
  スナップショット・readValues結果・**displayValues由来のname-new-attribute
  経路・リンク/ボタンテキスト・title**に仕込み、生成されたsystem / user
  プロンプト文字列に含まれないことをユニットテストで保証する。

judge-login-resultでvisibleTextを送らない結果、AIはエラーメッセージ本文を
読めず判定精度が下がるが、これは意図したトレードオフ（値の漏洩防止が優先。
エラーメッセージ検出自体は§2のルール側キーワードが担う）。

### 失敗処理と予算

- 1呼び出しに`timeoutMs`。`AiProviderError`（request-failed / refusal /
  empty-response / invalid-json）・タイムアウト・スキーマ/実在検証失敗 →
  `null`を返し安全なデフォルトへ。**探索は止めない**。
- `AiProvider.completeJson`には中断機構がない（既存契約を変更しない方針）ため、
  タイムアウトは進行中の呼び出しを**放棄**する方式で実装する: 遅れて届いた
  応答は破棄し、outcomeは`"timeout"`のまま（二重計上しない）、
  `maxConsecutiveFailures`に1回として数える。
- 既存`ai-mapper.ts`の「stop without fallback」既定との違いは意図的な非対称:
  登録フロー（Slice D）は誤ったプランで**世界に作用する**ため停止が安全側だが、
  Visibility探索は読み取り専用で、フォールバック先が「収集しない/探索を終える」
  という安全なデフォルトであるため**継続が安全側**。
- `maxCallsPerSite`超過: 以後の`consult`は即`null`（outcome:
  "budget-exceeded"）。`maxConsecutiveFailures`連続失敗: このrunの残りは
  AI無効（プロバイダ障害時に全サイトでタイムアウト待ちが連鎖するのを防ぐ）。
  カウンタの規則: `provider-error` / `timeout` / `invalid-response`が加算、
  `used`でリセット、**`budget-exceeded`は数えない**（1サイトの予算消化で
  run全体のブレーカが落ちると、サイト単位の封じ込めという予算の目的に反する）。
- 応答検証（上の表の右列）に失敗したものはinvalid-response扱い → `null`。
  特にhref / fieldIdの実在検証は、AIの捏造したセレクタ/URLで操作・遷移する
  事故を構造的に防ぐ。

### 可観測性

- `AiConsultationLog`を`onLog`コールバックで`ExplorationEvent`系に流す
  （UI/CLIの進捗と、runサマリの`aiCalls` / `aiFallbackUsed` / `aiFailures`）。
  `onLog`の接続はAiEngineを生成するOrchestrator組み立て側の責務。§6の
  `complete`イベントのsummary型へのこれらのフィールド追加は、本設計では
  要求のみ規定し、型の拡張は実装Issueで行う。
- プロンプト・応答の本文は保存しない（構造のみとはいえ開示最小化）。
  `DecisionResult.source: "ai"`と`confidence`はCollectedFieldに既に伝搬する
  設計（§4）なので、どの収集がAI由来かは台帳側で追跡できる。

### テスト戦略

- 単体（AIモックで決定論的に）: `AiProvider`はインターフェースなのでFake実装を
  注入。`OpenAiProvider`自体も`fetchImpl`注入でオフラインテスト可能（既存設計）。
  1. ルール`confident: false` → `consult`が呼ばれ、応答が`source: "ai"`で採用される
  2. `AiProviderError`各種 / タイムアウト → `null` → `getDefaultResult`に落ちる
  3. `maxCallsPerSite` / `maxConsecutiveFailures`のブレーカ動作
  4. サニタイズ番兵テスト（値・visibleText・クエリ付きURLがプロンプトに出ない）
  5. 実在検証（捏造fieldId / hrefを含む応答の拒否）
- E2E: 既定の決定論構成は現行のまま（AIなし）。FakeAiProviderを結線した
  AIフォールバック経路のE2Eを1本追加。
- 実プロバイダの手動確認: `.env`に`OPENAI_API_KEY`を設定し、ローカルテスト
  サイトの未知ラベルフィールドでAIフォールバックが発火することを確認
  （docs/manual-test.mdへの追記は実装Issueで行う）。

### 検討した代替案

- **常時AI（ルールベース廃止）**: コスト・レイテンシ・プライバシー・決定論既定
  （REQ-013）に反する → 不採用。
- **RuleEngine内の各判断に個別にAI呼び出しを埋め込む**: egress箇所が分散し
  「構造のみ送信」不変条件の監査が難しくなる → `AiEngine`に集約し、
  サニタイズと検証を一箇所で持つ。
- **新しいプロバイダ抽象の新設**: `src/agent/ai/provider.ts`が既にstateless・
  構造化出力・エラー分類を備える → 再利用。
- **AI失敗時に探索を停止（ai-mapperと同じ既定）**: 上記「失敗処理と予算」の
  とおりVisibilityでは継続が安全側 → 不採用。

---

## 実装フェーズ

| Phase | 内容 | 依存関係 |
|-------|------|----------|
| 1 | 基盤設計ドキュメント作成 | なし |
| 2 | DecisionEngine / RuleEngine実装 | Phase 1 |
| 3 | LoginHandler実装 | Phase 2 |
| 4 | PageExplorer実装 | Phase 2 |
| 5 | FieldCollector実装 | Phase 2, 既存classifier |
| 6 | VisibilityOrchestrator統合 | Phase 3, 4, 5 |
| 7 | 動的属性スキーマ実装 | Phase 5, 6 |
| 8 | E2Eテスト | Phase 6, 7 |
| 9 | AIEngine実装（§8。ルール失敗時のAIフォールバック、Fakeプロバイダ単体テスト含む） | Phase 2（DecisionEngineへの結線。Phase 3–8はAIなしで先行可） |

---

## まとめ：設計の特徴

| 特徴 | 説明 |
|------|------|
| **探索ベース** | サイト定義なし、アクセス後に動的に構造を把握 |
| **ハイブリッド判断** | ルールベース優先、失敗時にAIフォールバック |
| **動的スキーマ** | 未知フィールドを候補として記録、ユーザー確認後に採用 |
| **構造のみAI送信** | 値はローカルで読み取り、AIには構造情報のみ |
| **壁検出・ハンドオフ** | CAPTCHA/MFA検出時は同一セッションでユーザーに引き継ぎ、解決後にresume |
| **カード情報保護** | card.numberは下4桁のみ保存、CVVは収集・保存・表示しない |
| **シーケンシャル処理** | 1サイトずつ順次処理（並列処理は非対応、resume状態が上書きされるため） |

---

## 制約と既知のトレードオフ

1. **シーケンシャル処理制約**: `VisibilityOrchestrator`と`PageExplorer`はシングルスロットのresume状態を持つため、1サイトずつ順次処理する必要がある。壁ハンドオフ中に別サイトの処理を開始すると状態が上書きされる。

2. **カード検出の偽陽性**: `looksLikeCardData()`は13-19桁の数字列をカード番号候補としてドロップする。正当な会員番号や注文番号も誤検出される可能性があるが、セキュリティ優先の保守的な判断。

3. **URL正規化の限界**: フラグメントと末尾スラッシュのみ正規化。クエリパラメータの順序やエンコーディングの違いは考慮しない。

4. **ヘルパー関数の未定義**: `isSameDomain`, `maskValue`, `scoreLoginLink`, `mapAutocomplete`, `classifyByRules`, `buildContext`, `PageSnapshot`型, `FieldCollector.classifyDisplayValue`（`classifyField`と同様のautocomplete/ルール/DecisionEngine委譲の構造を持つ想定）などは設計段階では未定義。実装時に定義が必要。

   以下の2つは他の未定義ヘルパーより設計上の比重が大きいため、意図する契約を明記しておく:
   - `RuleEngine.classifyField(request)`: `FieldCollector.classifyField`が試みた`mapAutocomplete`/`classifyByRules`で分類できなかったフィールドに対し、ラベルテキストや周辺テキストのパターンマッチ等、追加のルールベース判断を試みる。確信が持てなければ`{ confident: false }`を返し、`DecisionEngine`がAIフォールバックまたは安全なデフォルト（分類不能）に委ねる。
   - `RuleEngine.shouldContinue(context)`: `PageExplorer`の探索ループが際限なく続かないようにする終了条件（訪問ページ数の上限、`pendingUrls`が尽きた、既知の全カテゴリを収集済み等）を判断する。`PageExplorer`にとって唯一のループ終端安全弁となるため、実装時は明示的な上限（最大ページ数など）を必ず持たせる。

5. **resume時の壁再発リスク**: `resume()`は`continueExploration()`を経由して同じURLに`goto()`し直す。サイトの壁（CAPTCHA/認証確認等）がセッションではなくリクエスト単位で発生する場合、ユーザーが一度解決しても再訪問時に同じ壁が再度現れうる。現状は壁検出・ハンドオフの仕組みが再度そのまま働くため機能面での破綻はないが、ユーザー体験としてのループは実装時に監視が必要。

6. **AIフォールバックの精度上限と残余リスク**（§8）: AIには`visibleText`もフィールド値も送らないため、judge-login-resultのAI判定はエラーメッセージ本文を読めず、構造シグナルだけで判断する。精度より値の非開示を優先する意図的なトレードオフ。また`maxCallsPerSite`予算を使い切ったサイトでは以後ルールのみで進むため、サイト内で収集網羅性が不均一になりうる（`classificationSource`と`AiConsultationLog`で追跡可能）。リンク/ボタンテキスト・titleのレダクションは「収集済みの値・正準値との照合」ベースであるため、**未収集かつ正準にもない値**（例: サイト側だけが持つ旧姓・ニックネーム）がリンクテキストに埋まっている場合は伏せ字化できず送信されうる。これが許容できない場合の代替はリンクテキストを一切送らないことだが、find-login-page / find-profile-links のAIフォールバックがほぼ機能しなくなるため採らない（残余リスクとして受容）。
