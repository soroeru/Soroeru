# Visibility探索ベースアーキテクチャ設計

Issue: #239

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

interface DecisionResult {
  source: "rule" | "ai";
  confidence: number;
  // kind別の結果
  result:
    | { links: LinkCandidate[] }           // find-login-page, find-profile-links
    | { form: LoginFormDetection | null }  // detect-login-form
    | { success: boolean; reason: string } // judge-login-result
    | { classification: FieldClassification | null } // classify-field
    | { continue: boolean } // should-continue
    | { attributeKey: string; label: string };  // name-new-attribute
}

class DecisionEngine {
  constructor(
    private ruleEngine: RuleEngine,
    private aiProvider?: AIProvider  // optional
  ) {}

  async decide(request: DecisionRequest): Promise<DecisionResult> {
    // 1. まずルールベースで試行
    const ruleResult = this.ruleEngine.evaluate(request);

    if (ruleResult.confident && ruleResult.result !== undefined) {
      return {
        source: "rule",
        confidence: 1.0,
        result: ruleResult.result
      };
    }

    // 2. ルールで判断できない場合、AIにフォールバック
    if (this.aiProvider) {
      // consultAIは完全なDecisionResultを返すのでそのまま返す
      return await this.consultAI(request);
    }

    // 3. AIなしで判断できない場合は安全なデフォルト値を返す
    return {
      source: "rule",
      confidence: 0.3,
      result: this.getDefaultResult(request.kind, ruleResult.result)
    };
  }

  /**
   * AIなしでルールも失敗した場合の安全なデフォルト値
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

  private async consultAI(request: DecisionRequest): Promise<DecisionResult> {
    // 構造情報のみをAIに送信（値は絶対に送らない）
    const prompt = this.buildPrompt(request);
    const response = await this.aiProvider.complete(prompt);
    return this.parseAIResponse(request.kind, response);
  }
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
    private pageDriver: PageDriver,
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
    startUrl: string,
    siteAccount: SiteAccount
  ): AsyncGenerator<ExplorationEvent> {
    // 状態をインスタンス変数として保持（resume用）
    this.currentState = {
      siteAccountId: siteAccount.id,
      domain: siteAccount.domain,
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

    while (state.pendingUrls.length > 0) {
      const url = state.pendingUrls.shift()!;

      // URL正規化（フラグメント除去、末尾スラッシュ統一）
      const normalizedUrl = normalizeUrl(url);
      if (state.visitedUrls.has(normalizedUrl)) continue;

      yield { kind: "navigating", url: normalizedUrl };

      await this.pageDriver.goto(normalizedUrl);
      await this.pageDriver.waitForReady();

      // 壁チェック
      const wall = await this.wallDetector.detect(await this.pageDriver.snapshot());
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
      const snapshot = await this.pageDriver.snapshot();
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
  constructor(
    private pageDriver: PageDriver,
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
      // 実在のカード番号は13〜19桁。それ未満（3〜4桁など）は
      // classify-fieldがCVVフィールドをcard.numberに誤分類した疑いがあり、
      // slice(-4)では全桁がそのまま残ってしまうため、保存せず破棄する。
      if (digits.length < 13) {
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
    siteAccountId: string,
    snapshot: PageSnapshot
  ): Promise<CollectionResult> {
    const results: CollectedField[] = [];
    const dynamicCandidates: DynamicAttributeCandidate[] = [];

    // フォームフィールドを処理
    const fieldValues = await this.pageDriver.readValues();

    for (const field of snapshot.fields) {
      const value = fieldValues[field.fieldId];
      if (!value || value.trim() === "") continue;

      // 分類を試みる
      const classification = await this.classifyField(field, snapshot);

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
      const displayValues = await this.pageDriver.readDisplayValues();

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
    snapshot: PageSnapshot
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

    // 3. AIフォールバック
    const aiResult = await this.decisionEngine.decide({
      kind: "classify-field",
      snapshot,
      context: { field }
    });

    if (aiResult.source === "ai" && aiResult.result.classification) {
      return { ...aiResult.result.classification, source: "ai" };
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
          siteAccount.id,
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
            siteAccount.id,
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

4. **ヘルパー関数の未定義**: `isSameDomain`, `maskValue`, `scoreLoginLink`, `mapAutocomplete`, `classifyByRules`, `buildContext`, `PageSnapshot`型などは設計段階では未定義。実装時に定義が必要。

5. **resume時の壁再発リスク**: `resume()`は`continueExploration()`を経由して同じURLに`goto()`し直す。サイトの壁（CAPTCHA/認証確認等）がセッションではなくリクエスト単位で発生する場合、ユーザーが一度解決しても再訪問時に同じ壁が再度現れうる。現状は壁検出・ハンドオフの仕組みが再度そのまま働くため機能面での破綻はないが、ユーザー体験としてのループは実装時に監視が必要。
