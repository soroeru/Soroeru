// Shared types for the autofill agent PoC (Issue #33, RFC-001 v3 §8).
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

/** Structure-only snapshot of the current page. Contains no profile values. */
export interface PageSnapshot {
  url: string;
  title: string;
  fields: FormField[];
  buttons: PageButton[];
  links: PageLink[];
  /** Visible page text (trimmed) for terms / wording analysis. */
  visibleText: string;
  /** iframe src URLs (CAPTCHA widgets live in iframes). */
  iframeSrcs: string[];
  /** Known wall-widget DOM markers found on the page (e.g. "g-recaptcha"). */
  wallMarkers: string[];
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
  status: RegistrationStatus | "needsUpdate" | "updated";
  lastUpdatedAt?: number;
}

export interface RegistrationMandate {
  origin: string;
  authorizedAt: number;
  submittedFieldKeys: ProfileKey[];
  termsUrl?: string;
  termsVersionHash?: string;
  highRiskFlags: HighRiskFlag[];
  attestationsApproved: string[];
  result: RegistrationStatus;
}

/** Wall detection result (RFC-001 v3 §10b). Detect only; never solve or bypass. */
export interface WallDetection {
  kind: "captcha" | "mfa" | "email-verification" | "identity-verification";
  evidence: string;
}
