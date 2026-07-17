// Shared types for the Soroeru agent PoC (Issue #33, RFC-001 v3 §8).
// Field detection locale: Japanese only (Q7).

/** Master profile keys known to the PoC. Custom fields use "custom.<slug>". */
export const KNOWN_PROFILE_KEYS = [
  "name.full",
  "name.sei",
  "name.mei",
  "name.kana.full",
  "name.kana.sei",
  "name.kana.mei",
  "email",
  "phone.full",
  "postal.full",
  "address.full",
  "address.pref",
  "address.city",
  "address.street",
  "address.building",
  "company.name",
  "company.department",
  "birth.year",
  "birth.month",
  "birth.day",
  "gender",
  "card.number",
  "card.exp.month",
  "card.exp.year",
  "card.holder",
  "card.cvv",
  "account.id",
  "account.password",
] as const;

export type KnownProfileKey = (typeof KNOWN_PROFILE_KEYS)[number];
export type ProfileKey = KnownProfileKey | `custom.${string}`;

/** Default Japanese display labels for known profile keys, used by the local UI (UI-001 / #17). */
export const PROFILE_FIELD_LABELS = {
  "name.full": "氏名",
  "name.sei": "姓",
  "name.mei": "名",
  "name.kana.full": "フリガナ",
  "name.kana.sei": "セイ",
  "name.kana.mei": "メイ",
  email: "メールアドレス",
  "phone.full": "電話番号",
  "postal.full": "郵便番号",
  "address.full": "住所",
  "address.pref": "都道府県",
  "address.city": "市区町村",
  "address.street": "番地",
  "address.building": "建物名",
  "company.name": "会社名",
  "company.department": "部署名",
  "birth.year": "生年",
  "birth.month": "生月",
  "birth.day": "生日",
  gender: "性別",
  "card.number": "カード番号",
  "card.exp.month": "カード有効期限（月）",
  "card.exp.year": "カード有効期限（年）",
  "card.holder": "カード名義",
  "card.cvv": "セキュリティコード",
  "account.id": "ログインID",
  "account.password": "パスワード",
} satisfies Record<KnownProfileKey, string>;

/** Keys whose decrypted values must never be displayed unmasked or logged. */
export function isSensitiveKey(key: ProfileKey): boolean {
  return key.startsWith("card.") || key === "account.password";
}

/** CVV is the most sensitive field (RFC-001 v3 §9): never sent to the model, decrypted only at fill time. */
export const MOST_SENSITIVE_KEY: ProfileKey = "card.cvv";

/**
 * Local value transforms applied by the automation layer when a site splits
 * one master value across several inputs. The AI model never sees the values;
 * it only names the transform (RFC-001 v3 §6).
 */
export const TRANSFORMS = [
  "postal3", // 100-0001 -> 100
  "postal4", // 100-0001 -> 0001
  "phone1", // 03-1234-5678 -> 03
  "phone2", // 03-1234-5678 -> 1234
  "phone3", // 03-1234-5678 -> 5678
  "addressAfterPref", // address.full minus prefecture
] as const;

export type Transform = (typeof TRANSFORMS)[number];

export const TRANSFORM_DESCRIPTIONS = {
  postal3: "郵便番号の上3桁",
  postal4: "郵便番号の下4桁",
  phone1: "電話番号の市外局番",
  phone2: "電話番号の市内局番",
  phone3: "電話番号の加入者番号",
  addressAfterPref: "住所全体から都道府県を除いた部分",
} satisfies Record<Transform, string>;

/** A logical form field extracted from the page by the in-page scanner. */
export interface FormField {
  /** Synthetic id; the scanner stamps the element with data-af-id=<fieldId>. */
  fieldId: string;
  tag: "input" | "textarea" | "select";
  /** input type ("text", "email", "radio", "checkbox", ...); radios are grouped into one field. */
  type: string;
  name: string;
  id: string;
  autocomplete: string;
  required: boolean;
  placeholder: string;
  /** <label>, aria-label, aria-labelledby texts. */
  labels: string[];
  /** Nearby text for label-less layouts (same-row <th>, <dt>, preceding text). */
  nearbyText: string;
  /** For select / radio groups: available options (radio options carry their own afId). */
  options?: { value: string; label: string; afId?: string }[];
}

export interface PageButton {
  selector: string;
  text: string;
}

export interface PageLink {
  href: string;
  text: string;
}

/**
 * A read-only value shown as page text (not an editable form control), e.g. an
 * account page rendering "メールアドレス: foo@example.com" as a <dl>/<table> row
 * or a disabled/readonly <input>. Structure-only: the label is captured here for
 * classification, but the raw value is NOT — it is read separately and locally
 * (PageDriver.readDisplayValues), keyed by `valueId`, so this snapshot stays
 * safe to hand to an optional AI mapper (RFC-002 §5.1).
 */
export interface DisplayValueCandidate {
  /** Synthetic id; the scanner stamps the value element with data-af-id=<valueId> ("d-*"). */
  valueId: string;
  /** The key/label text describing this value (e.g. a <dt> or <th>). */
  labelText: string;
  /** Nearby text fallback for classification. */
  nearbyText: string;
}

/** Structure-only snapshot of the current page. Contains no profile values. */
export interface PageSnapshot {
  url: string;
  title: string;
  /** General service/brand name from `og:site_name`, when the page declares one. */
  siteName?: string;
  fields: FormField[];
  buttons: PageButton[];
  links: PageLink[];
  /** Visible page text (trimmed) for terms / wording analysis. */
  visibleText: string;
  /** iframe src URLs (CAPTCHA widgets live in iframes). */
  iframeSrcs: string[];
  /** Known wall-widget DOM markers found on the page (e.g. "g-recaptcha"). */
  wallMarkers: string[];
  /**
   * Read-only display values (label + id only; raw value read separately). Optional
   * so legacy snapshot constructions stay valid; the real scanner always sets it.
   */
  displayValues?: DisplayValueCandidate[];
}

/** How a checkbox should be treated by the agent. */
export type CheckboxRole =
  | "terms-consent" // ordinary terms consent: agent may check it after gate approval
  | "attestation" // eligibility/identity statement: NEVER auto-checked (guard 3)
  | "optional-optin"; // marketing etc.: left unchecked by default

export const CHECKBOX_ROLES = ["terms-consent", "attestation", "optional-optin"] as const satisfies readonly CheckboxRole[];

export interface MappingEntry {
  fieldId: string;
  profileKey: ProfileKey;
  transform?: Transform;
}

export interface CheckboxClassification {
  fieldId: string;
  role: CheckboxRole;
  label: string;
}

/** The plan produced by either the deterministic classifier or the AI mapper. */
export interface MappingPlan {
  entries: MappingEntry[];
  checkboxes: CheckboxClassification[];
  /** fieldIds of required fields that could not be mapped (missing-data prompt). */
  unmappedRequired: string[];
}

export const HIGH_RISK_FLAGS = [
  "auto-renewal",
  "third-party-sharing",
  "arbitration",
  "content-license",
  "trial-subscription",
  "no-auto-creation",
] as const;

export type HighRiskFlag = (typeof HIGH_RISK_FLAGS)[number];

export const HIGH_RISK_FLAG_DESCRIPTIONS = {
  "auto-renewal": "自動更新・自動課金",
  "third-party-sharing": "第三者提供・販売",
  arbitration: "強制仲裁",
  "content-license": "コンテンツの利用許諾",
  "trial-subscription": "無料トライアル後にサブスク課金が始まる",
  "no-auto-creation": "自動化された手段によるアカウント作成の禁止",
} satisfies Record<HighRiskFlag, string>;

/** Result of analyzing terms / page wording (guards 1-2 and Q2c). */
export interface TermsAnalysis {
  highRiskFlags: HighRiskFlag[];
  /** Quoted evidence snippets per flag (for the gate display). */
  evidence: Partial<Record<HighRiskFlag, string>>;
  /** Set when card/payment fields are present. */
  payment?: PaymentClassification;
  /** Site prohibits automated account creation (Q2c -> assisted fill). */
  prohibitsAutoCreation: boolean;
}

export type PaymentClassification =
  | "trial-subscription" // free trial that later converts to a paid subscription (guard 2 exception)
  | "immediate-payment" // checkout / instant charge: out of scope, always stop
  | "unknown"; // ambiguous: stop on the safe side

/** What the user reviews at the single review-and-confirm gate (RFC-001 v3 §4). */
export interface GateRequest {
  origin: string;
  serviceName: string;
  /** Submitted fields; sensitive values are masked before display. */
  fields: { label: string; profileKey: ProfileKey; maskedValue: string }[];
  termsLinks: PageLink[];
  analysis: TermsAnalysis;
  /** Attestation checkboxes the user must decide individually (guard 3). */
  attestations: { fieldId: string; label: string }[];
}

export interface GateDecision {
  approved: boolean;
  /** Per-attestation user decisions; missing/false = leave unchecked. */
  attestationApprovals: Record<string, boolean>;
  /** Required before any card value is filled (guard 2 exception). */
  cardApproved: boolean;
}

export type RegistrationStatus =
  | "registered"
  | "assistedFill" // filled but final submit left to the user (auto-creation prohibited)
  | "declined" // gate denied
  | "manualHandoff" // wall detected (CAPTCHA / MFA / verification)
  | "failed";

export type AccountState =
  | "unknown"
  | "notRegistered"
  | "registrationPending"
  | "registered"
  | "imported"
  | "updateNeeded"
  | "updateFailed"
  | "withdrawalCandidate";

export type AccountNextAction =
  | "startRegistration"
  | "resumeRegistration"
  | "reviewInventory"
  | "runUpdate"
  | "retryUpdate"
  | "prepareWithdrawal";

export interface FilledFieldRecord {
  profileKey: ProfileKey;
  transform?: Transform;
  /** SHA-256 of the filled value (diff detection; raw value is not duplicated). */
  filledValueHash: string;
  fieldName: string;
  filledAt: number;
}

export interface SiteRecord {
  origin: string;
  siteId: string;
  serviceName: string;
  registeredAt: number;
  filledFields: FilledFieldRecord[];
  accountState: AccountState;
  status: RegistrationStatus | "needsUpdate" | "updated";
  lastCheckedAt?: number;
  lastUpdatedAt?: number;
  nextAction?: AccountNextAction;
  withdrawalCandidateAt?: number;
  withdrawalPreparedAt?: number;
  withdrawalFinalConfirmationRequired?: boolean;
}

export interface RegistrationMandate {
  origin: string;
  authorizedAt: number;
  submittedFieldKeys: ProfileKey[];
  termsUrl?: string;
  termsVersionHash?: string;
  highRiskFlags: HighRiskFlag[];
  attestationsApproved: string[];
  result: RegistrationStatus | "updated";
  /** Payment-guard audit (REQ-010): classification when card fields were present. */
  payment?: PaymentClassification;
  /** Guard 2 stopped the run for payment and handed off to the user. */
  paymentStopped?: boolean;
  /** A card value was auto-filled (only on an approved trial→subscription). */
  cardFilled?: boolean;
}

/** Wall detection result (RFC-001 v3 §10b). Detect only; never solve or bypass. */
export interface WallDetection {
  kind:
    | "captcha"
    | "mfa"
    | "email-verification"
    | "identity-verification"
    | "password-reset"
    | "ambiguous";
  evidence: string;
}

/**
 * Shared site/form/field/wall/withdrawal definition model (#80, RFC-001 v3
 * §8, architecture.md §7.1). The same shape backs checked-in "official"
 * definitions (`src/agent/official-definitions.ts`) and per-vault "local
 * candidate" definitions. Matching, field-rule application, and candidate
 * validation live in `src/agent/definitions.ts`; this file only defines the
 * shape so the store layer can persist candidates without depending on the
 * agent layer's logic.
 */

/** Identifies which pages a definition applies to. At least one of `domains` / `urlPatterns` must match for the definition to be considered. */
export interface SiteMatchRule {
  /** Hostnames or hostname suffixes (e.g. "example.test" also matches "www.example.test"), case-insensitive. */
  domains?: string[];
  /** Regex source strings matched against the full page URL. */
  urlPatterns?: string[];
}

/** Structural fingerprint of the registration (or other target) page, used to score a match. */
export interface FormSignature {
  /** Regex source strings matched against the URL pathname. */
  pathPatterns?: string[];
  /** Substrings (case-insensitive) expected in some field's name/id/autocomplete. */
  fieldTokens?: string[];
  /** Regex source strings matched against the page's visible text. */
  headingPatterns?: string[];
  /** Regex source strings matched against button labels. */
  buttonPatterns?: string[];
}

/** A field-mapping rule scoped to one site definition, in the same style as the deterministic classifier's rules. */
export interface DefinitionFieldRule {
  id: string;
  profileKey: ProfileKey;
  transform?: Transform;
  /** Regex source matched against label-ish text (labels + placeholder + nearbyText). */
  labelPattern?: string;
  /** Regex source matched against `name`/`id` attributes. */
  attrPattern?: string;
}

/** A known wall signal for this site, beyond the generic detectors in `src/agent/walls.ts`. */
export interface WallSignalDefinition {
  kind: WallDetection["kind"];
  /** Regex source matched against visible text or DOM wall markers. */
  pattern: string;
}

/**
 * A planning-only step in a withdrawal flow. Never auto-executes irreversible
 * actions; the agent uses this to locate the entry point and explain the flow
 * to the user (#91).
 */
export interface WithdrawalStepDefinition {
  description: string;
  /** Regex source matched against link text to locate this step. */
  linkPattern?: string;
}

/** A site/form/field/wall/withdrawal definition shared by deterministic mode and AI mode. */
export interface SiteDefinition {
  id: string;
  serviceName: string;
  match: SiteMatchRule;
  registrationSignature?: FormSignature;
  fieldRules?: DefinitionFieldRule[];
  wallSignals?: WallSignalDefinition[];
  withdrawalSteps?: WithdrawalStepDefinition[];
  /** Free-text notes (e.g. known high-risk clauses); informational only — the gate re-analyzes terms each run. */
  notes?: string;
}

/** Provenance of a local candidate definition (#80, security.md §9). */
export type CandidateSource = "ai" | "user" | "observation";

/** Lifecycle status of a local candidate definition (architecture.md §7.1). */
export type CandidateStatus = "candidate" | "validated" | "rejected" | "submitted";

/**
 * A local, unreviewed definition private to this vault (PRIV-003). Same shape
 * as `SiteDefinition` plus provenance/lifecycle fields. Never treated as
 * official; promotion to a shared definition is a future, explicit, opt-in
 * step (out of scope for #80).
 */
export interface LocalCandidateDefinition extends SiteDefinition {
  source: CandidateSource;
  status: CandidateStatus;
  createdAt: number;
  updatedAt: number;
}
