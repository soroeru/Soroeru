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
  currentUrl: string;
  visitedUrls: string[];
  collectedAttributes: string[];  // 既に収集した属性キー
  siteAccount: { domain: string; displayName: string };
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
    | { continue: boolean; nextLinks: LinkCandidate[] } // should-continue
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

    if (ruleResult.confident) {
      return { source: "rule", ...ruleResult };
    }

    // 2. ルールで判断できない場合、AIにフォールバック
    if (this.aiProvider) {
      const aiResult = await this.consultAI(request);
      return { source: "ai", ...aiResult };
    }

    // 3. AIなしで判断できない場合は低信頼度で返す
    return { source: "rule", confidence: 0.3, ...ruleResult };
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

    return {
      confident: usernameField != null,
      result: {
        form: {
          usernameFieldId: usernameField?.fieldId,
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
      !context.currentUrl.includes("login")
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

    // 判断が難しい
    return { confident: false, result: { success: successScore > failureScore, reason: "ambiguous" } };
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
      if (context.visitedUrls.includes(link.href)) continue;
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
interface ExplorationState {
  siteAccountId: string;
  domain: string;
  visitedUrls: Set<string>;
  pendingUrls: string[];  // 探索待ちURL
  collectedPages: PageCollectionResult[];
  walls: WallDetection[];
}

class PageExplorer {
  constructor(
    private pageDriver: PageDriver,
    private decisionEngine: DecisionEngine,
    private wallDetector: WallDetector
  ) {}

  async explore(
    startUrl: string,
    siteAccount: SiteAccount
  ): AsyncGenerator<ExplorationEvent> {
    const state: ExplorationState = {
      siteAccountId: siteAccount.id,
      domain: siteAccount.domain,
      visitedUrls: new Set(),
      pendingUrls: [startUrl],
      collectedPages: [],
      walls: []
    };

    while (state.pendingUrls.length > 0) {
      const url = state.pendingUrls.shift()!;

      if (state.visitedUrls.has(url)) continue;
      state.visitedUrls.add(url);

      yield { kind: "navigating", url };

      await this.pageDriver.goto(url);
      await this.pageDriver.waitForReady();

      // 壁チェック
      const wall = await this.wallDetector.detect(await this.pageDriver.snapshot());
      if (wall) {
        state.walls.push(wall);
        yield { kind: "wall-detected", wall, url };
        // ハンドオフ待ち（この設計では一旦スキップして続行）
        continue;
      }

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
          if (!state.visitedUrls.has(link.href)) {
            state.pendingUrls.push(link.href);
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
        yield { kind: "exploration-complete", reason: "decision-engine" };
        break;
      }
    }

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
  value: string;  // ローカルで読み取った値
  classificationSource: "rule" | "ai" | "unclassified";
  confidence: number;
}

class FieldCollector {
  constructor(
    private pageDriver: PageDriver,
    private decisionEngine: DecisionEngine,
    private domainService: DomainService
  ) {}

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
        results.push({
          fieldId: field.fieldId,
          attributeKey: classification.attributeKey,
          labelText: field.labels.join(" ") || field.nearbyText,
          value,
          classificationSource: classification.source,
          confidence: classification.confidence
        });
      } else {
        // 分類できなかった場合、動的属性の候補として提案
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
          results.push({
            fieldId: display.valueId,
            attributeKey: classification.attributeKey,
            labelText: display.labelText,
            value,
            classificationSource: classification.source,
            confidence: classification.confidence
          });
        } else {
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
  constructor(
    private browserEngine: BrowserEngine,
    private loginHandler: LoginHandler,
    private pageExplorer: PageExplorer,
    private fieldCollector: FieldCollector,
    private domainService: DomainService,
    private decisionEngine: DecisionEngine
  ) {}

  async runForSite(
    siteAccount: SiteAccount,
    credential: Credential
  ): AsyncGenerator<VisibilityEvent> {
    const page = await this.browserEngine.newPage();
    const pageDriver = new PlaywrightPageDriver(page);

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
          yield { phase: "login", status: "wall", wall: loginResult.wall };
          // ハンドオフ待ち...
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

      for await (const event of this.pageExplorer.explore(
        pageDriver.currentUrl(),
        siteAccount
      )) {
        yield { phase: "explore", ...event };

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

      // Phase 4: Disclosureとして記録
      yield { phase: "save", status: "starting" };

      for (const field of allCollectedFields) {
        await this.domainService.addDisclosure(
          siteAccount.id,
          field.attributeKey!,
          field.value,
          {
            sourcePageUrl: /* from context */,
            confidence: field.confidence,
            classificationSource: field.classificationSource
          }
        );
      }

      // 動的属性候補を記録
      for (const candidate of allDynamicCandidates) {
        await this.domainService.recordDynamicCandidate(candidate);
      }

      yield {
        phase: "complete",
        summary: {
          pagesVisited: /* count */,
          disclosuresCollected: allCollectedFields.length,
          dynamicCandidates: allDynamicCandidates.length
        }
      };

    } finally {
      await page.close();
    }
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
| **壁検出・ハンドオフ** | CAPTCHA/MFA検出時は同一セッションでユーザーに引き継ぎ |
