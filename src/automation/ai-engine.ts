// AiEngine: the optional AI fallback for the Visibility exploration
// DecisionEngine (docs/design/visibility-exploration.md §8, Issue #276).
// Consulted only when the RuleEngine returns `confident: false`; every failure
// mode (provider error, timeout, budget exhaustion, response validation
// failure) resolves to `null` so DecisionEngine falls through to its safe
// default — exploration never stops because of this engine (REQ-013:
// deterministic is the default, AI is an optional enhancement).
//
// Structure-only in, structure-only out (docs/security.md, RFC-002): no field
// value, no `visibleText`, no display-value value ever enters a prompt.
// `toAiPayload`-equivalent sanitization lives in the per-kind `prepare*`
// functions below; each one's `validate` rejects any fabricated href/fieldId/
// selector so the AI can never make the automation layer navigate or fill
// somewhere it did not actually see.

import {
  KNOWN_PROFILE_KEYS,
  PROFILE_FIELD_LABELS,
  type FormField,
  type KnownProfileKey,
  type PageSnapshot,
} from "../types.js";
import type { AiProvider, CompleteJsonOptions } from "../agent/ai/provider.js";
import type {
  AiEngine as AiConsultant,
  DecisionKind,
  DecisionRequest,
  DecisionResult,
  DecisionResultMap,
} from "./decision-engine.js";
import { isSameSite, normalizeUrl, resolveHref } from "./url-utils.js";

export interface AiEngineOptions {
  /** Per-call timeout; the call is abandoned (never awaited) after this. Default 30_000. */
  timeoutMs?: number;
  /** Call budget per site (domain). Default 20. */
  maxCallsPerSite?: number;
  /** Consecutive non-"used" outcomes before the AI is disabled for the rest of this run. Default 3. */
  maxConsecutiveFailures?: number;
}

export type AiConsultationOutcome =
  | "used"
  | "provider-error"
  | "timeout"
  | "invalid-response"
  | "budget-exceeded";

/** One AI consultation's observability record. Never carries prompt/response bodies. */
export interface AiConsultationLog {
  kind: DecisionKind;
  /** origin+path only (same sanitization as prompts); "" when context.currentUrl is unset. */
  url: string;
  providerId: string;
  latencyMs: number;
  outcome: AiConsultationOutcome;
}

/**
 * Local-only value source used to redact link/button/title text before it is
 * sent (design §8 "送信データのサニタイズ"). The caller (Orchestrator) supplies
 * this-run's collected values plus decrypted canonical values purely for local
 * substring matching; AiEngine never logs or forwards these values themselves.
 */
export interface RedactionValueSource {
  currentValues(): readonly string[];
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CALLS_PER_SITE = 20;
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;

/** Marks a call abandoned by `withTimeout`; the late response (if any) is discarded, not double-counted. */
class AiTimeoutError extends Error {
  constructor() {
    super("AI consultation timed out");
    this.name = "AiTimeoutError";
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AiTimeoutError()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** origin+path only: strips query/fragment so session tokens etc. never reach a prompt or a log. */
function sanitizeUrl(url: string | undefined): string {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "";
  }
}

/** Local-only substring redaction against collected/canonical values (never sent, only matched against). */
function redact(text: string, values: readonly string[]): string {
  let out = text;
  for (const raw of values) {
    const value = raw.trim();
    if (value.length < 2) continue;
    if (!out.includes(value)) continue;
    out = out.split(value).join("[REDACTED]");
  }
  return out;
}

function clampConfidence(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(1, Math.max(0, value));
}

const CONFIDENCE_SCHEMA = { type: "number", minimum: 0, maximum: 1 } as const;

// --- Link sanitization (find-login-page / find-profile-links / judge-login-result) -------

interface SanitizedLink {
  href: string;
  text: string;
}

/**
 * Maps the sanitized (origin+path) href the AI is shown back to the original
 * snapshot link (real href with query, real text) so a validated response can
 * be resolved to real data. Only links that resolve to an absolute URL are
 * included, so a fabricated href never has an entry to match against
 * ("実在検証"): the AI can only ever select a link it was actually shown.
 */
function linkLookup(snapshot: PageSnapshot): Map<string, { href: string; text: string }> {
  const map = new Map<string, { href: string; text: string }>();
  for (const link of snapshot.links) {
    const resolved = resolveHref(link.href, snapshot.url);
    if (!resolved) continue;
    const sanitized = sanitizeUrl(resolved);
    if (!sanitized || map.has(sanitized)) continue;
    map.set(sanitized, { href: resolved, text: link.text });
  }
  return map;
}

function sanitizedLinksForPrompt(
  lookup: Map<string, { href: string; text: string }>,
  values: readonly string[],
): SanitizedLink[] {
  return Array.from(lookup.entries()).map(([href, entry]) => ({ href, text: redact(entry.text, values) }));
}

interface SanitizedButton {
  selector: string;
  text: string;
}

function sanitizedButtonsForPrompt(
  buttons: PageSnapshot["buttons"],
  values: readonly string[],
): SanitizedButton[] {
  return buttons.map((button) => ({ selector: button.selector, text: redact(button.text, values) }));
}

// --- Field sanitization (structure only, no values — same basis as ai-mapper.ts) ----------

interface SanitizedField {
  fieldId: string;
  tag: string;
  type: string;
  name: string;
  id: string;
  autocomplete: string;
  required: boolean;
  placeholder: string;
  labels: string[];
  nearbyText: string;
  options?: { value: string; label: string }[];
}

function sanitizeField(field: FormField): SanitizedField {
  const sanitized: SanitizedField = {
    fieldId: field.fieldId,
    tag: field.tag,
    type: field.type,
    name: field.name,
    id: field.id,
    autocomplete: field.autocomplete,
    required: field.required,
    placeholder: field.placeholder,
    labels: field.labels,
    nearbyText: field.nearbyText,
  };
  if (field.options)
    sanitized.options = field.options.map((option) => ({ value: option.value, label: option.label }));
  return sanitized;
}

const CLASSIFY_KEY_GUIDE = `既知のプロフィールキー一覧（値の意味）:\n${KNOWN_PROFILE_KEYS.map(
  (key) => `- ${key}（${PROFILE_FIELD_LABELS[key]}）`,
).join("\n")}`;

const DYNAMIC_KEY_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

/**
 * Normalizes an AI-proposed attribute key to this codebase's dynamic-attribute
 * convention (`custom.<slug>`, see disclosure-collector.ts / domain-service.ts)
 * or an exact known key. Returns undefined when the key cannot be normalized
 * or (for the dynamic-candidate branch only) starts with the reserved `card.`
 * namespace — card fields must resolve to a real known `card.*` key, never a
 * fabricated new one (design §8: "card.プレフィックスは提案禁止").
 */
function normalizeAttributeKey(raw: string): string | undefined {
  const trimmedLower = raw.trim().toLowerCase();
  if ((KNOWN_PROFILE_KEYS as readonly string[]).includes(trimmedLower)) return trimmedLower;
  const key = trimmedLower.startsWith("custom.") ? trimmedLower.slice("custom.".length) : trimmedLower;
  if (!DYNAMIC_KEY_PATTERN.test(key)) return undefined;
  if (/^card([._-]|$)/.test(key)) return undefined;
  return `custom.${key}`;
}

// --- Per-kind prompt + schema + validation ------------------------------------------------

interface Prepared<K extends DecisionKind> {
  request: CompleteJsonOptions;
  validate(raw: unknown, confidence: number): DecisionResultMap[K] | undefined;
}

function prepareAny(request: DecisionRequest, values: readonly string[]): Prepared<DecisionKind> {
  switch (request.kind) {
    case "find-login-page":
      return prepareFindLinks(
        request,
        values,
        "あなたはWebサイトのページ構造からログインページへのリンクを見つけるアシスタントです。リンク一覧・タイトル・URLをもとに、ログインページに最も該当するリンクを返してください。該当がなければ空配列にしてください。",
      );
    case "find-profile-links":
      return prepareFindLinks(
        request,
        values,
        "あなたはログイン後のページから、会員情報・住所・お支払い方法など登録済みの個人情報が閲覧できそうなリンクを見つけるアシスタントです。リンク一覧・タイトル・URLをもとに、該当するリンクを返してください。該当がなければ空配列にしてください。",
      );
    case "detect-login-form":
      return prepareDetectLoginForm(request, values);
    case "judge-login-result":
      return prepareJudgeLoginResult(request, values);
    case "classify-field":
      return prepareClassifyField(request);
    case "should-continue":
      return prepareShouldContinue(request);
    case "name-new-attribute":
      return prepareNameNewAttribute(request);
  }
}

function prepareFindLinks(
  request: DecisionRequest,
  values: readonly string[],
  system: string,
): Prepared<DecisionKind> {
  const { snapshot } = request;
  const lookup = linkLookup(snapshot);
  const payload = {
    links: sanitizedLinksForPrompt(lookup, values),
    title: redact(snapshot.title, values),
    url: sanitizeUrl(snapshot.url),
  };
  return {
    request: {
      system,
      user: JSON.stringify(payload),
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["links", "confidence"],
        properties: {
          links: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["href", "text"],
              properties: { href: { type: "string" }, text: { type: "string" } },
            },
          },
          confidence: CONFIDENCE_SCHEMA,
        },
      },
    },
    validate(raw) {
      const links = (raw as { links?: unknown }).links;
      if (!Array.isArray(links)) return undefined;
      const result: { href: string; text: string }[] = [];
      for (const item of links) {
        if (typeof item !== "object" || item === null) return undefined;
        const href = (item as { href?: unknown }).href;
        if (typeof href !== "string") return undefined;
        // Existence validation: the AI may only select a link it was actually
        // shown; a fabricated href has no entry and invalidates the response.
        const original = lookup.get(href);
        if (!original) return undefined;
        result.push({ href: original.href, text: original.text });
      }
      return { links: result };
    },
  };
}

function prepareDetectLoginForm(request: DecisionRequest, values: readonly string[]): Prepared<DecisionKind> {
  const { snapshot } = request;
  const payload = {
    fields: snapshot.fields.map(sanitizeField),
    buttons: sanitizedButtonsForPrompt(snapshot.buttons, values),
  };
  const fieldIds = new Set(snapshot.fields.map((field) => field.fieldId));
  const selectors = new Set(snapshot.buttons.map((button) => button.selector));
  return {
    request: {
      system:
        "あなたはWebページのログインフォームを検出するアシスタントです。フィールド一覧とボタン一覧から、ユーザー名（またはメールアドレス/ID）欄とパスワード欄、送信ボタンを特定してください。ログインフォームが存在しなければ form は null にしてください。",
      user: JSON.stringify(payload),
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["form", "confidence"],
        properties: {
          form: {
            anyOf: [
              { type: "null" },
              {
                type: "object",
                additionalProperties: false,
                required: ["usernameFieldId", "passwordFieldId"],
                properties: {
                  usernameFieldId: { type: "string" },
                  passwordFieldId: { type: "string" },
                  submitSelector: { anyOf: [{ type: "string" }, { type: "null" }] },
                },
              },
            ],
          },
          confidence: CONFIDENCE_SCHEMA,
        },
      },
    },
    validate(raw) {
      const form = (raw as { form?: unknown }).form;
      if (form === null || form === undefined) return { form: null };
      if (typeof form !== "object") return undefined;
      const usernameFieldId = (form as { usernameFieldId?: unknown }).usernameFieldId;
      const passwordFieldId = (form as { passwordFieldId?: unknown }).passwordFieldId;
      const submitSelectorRaw = (form as { submitSelector?: unknown }).submitSelector;
      if (typeof usernameFieldId !== "string" || typeof passwordFieldId !== "string") return undefined;
      // Existence validation: a fieldId the automation layer would fill/click
      // must be one the page actually has, never an AI-fabricated selector.
      if (!fieldIds.has(usernameFieldId) || !fieldIds.has(passwordFieldId)) return undefined;
      if (submitSelectorRaw === undefined || submitSelectorRaw === null) {
        return { form: { usernameFieldId, passwordFieldId } };
      }
      if (typeof submitSelectorRaw !== "string" || !selectors.has(submitSelectorRaw)) return undefined;
      return { form: { usernameFieldId, passwordFieldId, submitSelector: submitSelectorRaw } };
    },
  };
}

function prepareJudgeLoginResult(
  request: DecisionRequest,
  values: readonly string[],
): Prepared<DecisionKind> {
  const { snapshot } = request;
  // visibleText is intentionally never sent (design §8): the model judges
  // success/failure from structural signals only, never page wording that may
  // embed personal values (e.g. "ようこそ 山田太郎 様").
  const payload = {
    fields: snapshot.fields.map((field) => ({ type: field.type, autocomplete: field.autocomplete })),
    links: sanitizedLinksForPrompt(linkLookup(snapshot), values),
    buttons: sanitizedButtonsForPrompt(snapshot.buttons, values),
    title: redact(snapshot.title, values),
    url: sanitizeUrl(snapshot.url),
  };
  return {
    request: {
      system:
        "あなたはログイン試行後のページがログイン成功か失敗かを判定するアシスタントです。フィールドの型・リンク・ボタン・タイトル・URLだけを根拠に判断してください（本文テキストは渡されません）。ログアウトリンクの有無、パスワード欄が残っているか等の構造的なシグナルで判断してください。",
      user: JSON.stringify(payload),
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["success", "reason", "confidence"],
        properties: {
          success: { type: "boolean" },
          reason: { type: "string" },
          confidence: CONFIDENCE_SCHEMA,
        },
      },
    },
    validate(raw) {
      const success = (raw as { success?: unknown }).success;
      const reason = (raw as { reason?: unknown }).reason;
      if (typeof success !== "boolean" || typeof reason !== "string") return undefined;
      return { success, reason };
    },
  };
}

function prepareClassifyField(request: DecisionRequest): Prepared<DecisionKind> {
  const field = request.context.field;
  return {
    request: {
      system: `あなたは日本語のWebフォーム欄を1つ、プロフィールキーに分類するアシスタントです。
${CLASSIFY_KEY_GUIDE}
値そのものは渡されません。ラベル・name・id・type・autocomplete・placeholder・周辺テキストだけで判断してください。どの既知キーにも該当しなければ classification は null にしてください（confidence は低い値で構いません）。新しい動的キーを思いつく場合は "custom." で始まる小文字の英数字・ドット・ハイフン・アンダースコアだけのキーにしてください。`,
      user: JSON.stringify({ field: field ? sanitizeField(field) : null }),
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["classification", "confidence"],
        properties: {
          classification: {
            anyOf: [
              { type: "null" },
              {
                type: "object",
                additionalProperties: false,
                required: ["attributeKey"],
                properties: { attributeKey: { type: "string" } },
              },
            ],
          },
          confidence: CONFIDENCE_SCHEMA,
        },
      },
    },
    validate(raw, confidence) {
      if (!field) return undefined;
      const classification = (raw as { classification?: unknown }).classification;
      if (classification === null || classification === undefined) return { classification: null };
      if (typeof classification !== "object") return undefined;
      const rawKey = (classification as { attributeKey?: unknown }).attributeKey;
      if (typeof rawKey !== "string") return undefined;
      const attributeKey = normalizeAttributeKey(rawKey);
      if (attributeKey === undefined) return undefined;
      return { classification: { attributeKey, source: "ai", confidence } };
    },
  };
}

function prepareShouldContinue(request: DecisionRequest): Prepared<DecisionKind> {
  const { snapshot, context } = request;
  const visited = new Set(context.visitedUrls ?? []);
  let pendingSameSiteLinkCount = 0;
  for (const link of snapshot.links) {
    const resolved = resolveHref(link.href, snapshot.url);
    if (!resolved || !isSameSite(resolved, context.siteAccount.domain)) continue;
    if (!visited.has(normalizeUrl(resolved))) pendingSameSiteLinkCount++;
  }
  const payload = {
    visitedCount: context.visitedUrls?.length ?? 0,
    pendingSameSiteLinkCount,
    collectedAttributes: context.collectedAttributes ?? [],
  };
  return {
    request: {
      system:
        "あなたはWebサイトの探索を続けるべきか判断するアシスタントです。訪問済みページ数・同一サイト内の未訪問リンク数・収集済み属性キー一覧（キーのみ）から、これ以上探索する価値があるかを判断してください。",
      user: JSON.stringify(payload),
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["continue", "confidence"],
        properties: { continue: { type: "boolean" }, confidence: CONFIDENCE_SCHEMA },
      },
    },
    validate(raw) {
      const shouldContinue = (raw as { continue?: unknown }).continue;
      if (typeof shouldContinue !== "boolean") return undefined;
      return { continue: shouldContinue };
    },
  };
}

function prepareNameNewAttribute(request: DecisionRequest): Prepared<DecisionKind> {
  const { context } = request;
  // Two disjoint sources (design §8): a form field (labels/placeholder/
  // nearbyText are structural, safe) or a display-value candidate (only
  // labelText — never nearbyText, which for display values can carry the
  // rendered value itself, e.g. "<dt>氏名</dt><dd>山田太郎</dd>").
  const payload = context.displayValue
    ? { source: "display-value" as const, labelText: context.displayValue.labelText }
    : {
        source: "form-field" as const,
        labels: context.field?.labels ?? [],
        placeholder: context.field?.placeholder ?? "",
        nearbyText: context.field?.nearbyText ?? "",
      };
  return {
    request: {
      system:
        'あなたはWebフォームの中で既知のプロフィールキーに当てはまらない未知の欄に、新しい属性キーを提案するアシスタントです。値そのものは渡されません。キーは小文字の英数字・ドット・ハイフン・アンダースコアのみで構成し（例: "rakuten.point_number"）、人間が識別しやすい短い日本語ラベルも提案してください。カード情報を示すキー（"card." で始まるもの）は提案しないでください — カード関連の欄は既知のキーのみが対象です。',
      user: JSON.stringify(payload),
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["attributeKey", "label", "confidence"],
        properties: {
          attributeKey: { type: "string" },
          label: { type: "string" },
          confidence: CONFIDENCE_SCHEMA,
        },
      },
    },
    validate(raw) {
      const rawKey = (raw as { attributeKey?: unknown }).attributeKey;
      const label = (raw as { label?: unknown }).label;
      if (typeof rawKey !== "string" || typeof label !== "string" || label.trim().length === 0)
        return undefined;
      const attributeKey = normalizeAttributeKey(rawKey);
      if (attributeKey === undefined) return undefined;
      // A "new" attribute must never resolve to an already-known key —
      // that is classify-field's job, not this kind's.
      if ((KNOWN_PROFILE_KEYS as readonly KnownProfileKey[]).includes(attributeKey as KnownProfileKey))
        return undefined;
      return { attributeKey, label };
    },
  };
}

/**
 * The optional AI fallback for DecisionEngine (design §8). One instance per
 * Visibility run: `maxCallsPerSite` is keyed by domain on the instance, and
 * `maxConsecutiveFailures` is a run-wide breaker — both reset only when a new
 * instance is created for the next run.
 */
export class AiEngine implements AiConsultant {
  private readonly timeoutMs: number;
  private readonly maxCallsPerSite: number;
  private readonly maxConsecutiveFailures: number;
  private readonly callsPerSite = new Map<string, number>();
  private consecutiveFailures = 0;
  private disabledForRun = false;

  constructor(
    private readonly provider: AiProvider,
    private readonly redactionSource: RedactionValueSource,
    options?: AiEngineOptions,
    private readonly onLog?: (entry: AiConsultationLog) => void,
  ) {
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxCallsPerSite = options?.maxCallsPerSite ?? DEFAULT_MAX_CALLS_PER_SITE;
    this.maxConsecutiveFailures = options?.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;
  }

  async consult<K extends DecisionKind>(
    request: DecisionRequest & { kind: K },
  ): Promise<DecisionResult<K> | null> {
    const domain = request.context.siteAccount.domain;
    const loggedUrl = sanitizeUrl(request.context.currentUrl);

    // A tripped run-wide breaker or an exhausted per-site budget both mean
    // "do not call the provider"; there is no separate outcome value for the
    // breaker, so it is logged the same way as budget-exceeded (design §8:
    // neither case is counted against maxConsecutiveFailures).
    if (this.disabledForRun) {
      this.log(request.kind, loggedUrl, "budget-exceeded", 0);
      return null;
    }
    const used = this.callsPerSite.get(domain) ?? 0;
    if (used >= this.maxCallsPerSite) {
      this.log(request.kind, loggedUrl, "budget-exceeded", 0);
      return null;
    }
    this.callsPerSite.set(domain, used + 1);

    const values = this.redactionSource.currentValues();
    // The switch inside prepareAny cannot prove to the compiler that its
    // return type matches K, so (like DecisionEngine/RuleEngine) the cast to
    // the caller's K happens once, at this single boundary.
    const prepared = prepareAny(request, values) as Prepared<K>;

    const startedAt = Date.now();
    let raw: unknown;
    try {
      raw = await withTimeout(this.provider.completeJson(prepared.request), this.timeoutMs);
    } catch (err) {
      const outcome: AiConsultationOutcome = err instanceof AiTimeoutError ? "timeout" : "provider-error";
      this.recordFailure();
      this.log(request.kind, loggedUrl, outcome, Date.now() - startedAt);
      return null;
    }

    if (typeof raw !== "object" || raw === null) {
      this.recordFailure();
      this.log(request.kind, loggedUrl, "invalid-response", Date.now() - startedAt);
      return null;
    }
    const confidence = clampConfidence((raw as { confidence?: unknown }).confidence);
    const result = confidence === undefined ? undefined : prepared.validate(raw, confidence);
    if (result === undefined || confidence === undefined) {
      this.recordFailure();
      this.log(request.kind, loggedUrl, "invalid-response", Date.now() - startedAt);
      return null;
    }

    this.consecutiveFailures = 0;
    this.log(request.kind, loggedUrl, "used", Date.now() - startedAt);
    return { source: "ai", confidence, result };
  }

  private recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.maxConsecutiveFailures) this.disabledForRun = true;
  }

  private log(kind: DecisionKind, url: string, outcome: AiConsultationOutcome, latencyMs: number): void {
    this.onLog?.({ kind, url, providerId: this.provider.id, latencyMs, outcome });
  }
}
