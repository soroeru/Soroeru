import {
  BASIC_PROFILE_FIELD_KINDS,
  type BasicProfileFieldKind,
  type ProfileField,
  type ProfileFieldKind,
} from "./types.js";

const RESERVED_UNSUPPORTED_KINDS = new Set([
  "password",
  "passcode",
  "otp",
  "oneTimePassword",
  "one-time-password",
  "creditCard",
  "credit-card",
  "cardNumber",
  "card-number",
  "cardSecurityCode",
  "card-security-code",
  "cardExpiration",
  "card-expiration",
  "cvv",
  "cvc",
]);

const SENSITIVE_TERM_PATTERNS = [
  /(^|[^A-Za-z0-9])password([^A-Za-z0-9]|$)/i,
  /(^|[^A-Za-z0-9])passcode([^A-Za-z0-9]|$)/i,
  /(^|[^A-Za-z0-9])one[-_\s]?time[-_\s]+password([^A-Za-z0-9]|$)/i,
  /(^|[^A-Za-z0-9])otp([^A-Za-z0-9]|$)/i,
  /(^|[^A-Za-z0-9])credit([^A-Za-z0-9]|$)/i,
  /(^|[^A-Za-z0-9])credit[-_\s]*card([^A-Za-z0-9]|$)/i,
  /(^|[^A-Za-z0-9])card[-_\s]*number([^A-Za-z0-9]|$)/i,
  /(^|[^A-Za-z0-9])card[-_\s]*expir(?:y|ation)([^A-Za-z0-9]|$)/i,
  /(^|[^A-Za-z0-9])cvv([^A-Za-z0-9]|$)/i,
  /(^|[^A-Za-z0-9])cvc([^A-Za-z0-9]|$)/i,
  /(^|[^A-Za-z0-9])security[-_\s]*code([^A-Za-z0-9]|$)/i,
  /パスワード/,
  /ワンタイム/,
  /暗証番号/,
  /クレジットカード/,
  /カード番号/,
  /セキュリティコード/,
];

export class ProfileFieldValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileFieldValidationError";
  }
}

export function isBasicProfileFieldKind(value: unknown): value is BasicProfileFieldKind {
  return typeof value === "string" && BASIC_PROFILE_FIELD_KINDS.includes(value as BasicProfileFieldKind);
}

export function isProfileFieldKind(value: unknown): value is ProfileFieldKind {
  return isBasicProfileFieldKind(value) || value === "custom";
}

export function parseProfileField(value: unknown): ProfileField {
  assertProfileField(value);
  return value;
}

export function assertProfileField(value: unknown): asserts value is ProfileField {
  if (!isRecord(value)) {
    throw new ProfileFieldValidationError("Profile field must be an object.");
  }

  const kind = value.kind;
  if (typeof kind === "string" && RESERVED_UNSUPPORTED_KINDS.has(kind)) {
    throw new ProfileFieldValidationError(`Unsupported profile field kind: ${kind}.`);
  }
  if (!isProfileFieldKind(kind)) {
    throw new ProfileFieldValidationError("Profile field kind is not supported.");
  }

  assertNonEmptyString(value.id, "id");
  assertNonEmptyString(value.label, "label");
  assertString(value.value, "value");
  assertFiniteNumber(value.order, "order");

  const searchableTerms = [value.label];

  if (kind === "custom") {
    if (!Array.isArray(value.matchTerms) || value.matchTerms.length === 0) {
      throw new ProfileFieldValidationError("Custom profile fields require at least one match term.");
    }
    for (const matchTerm of value.matchTerms) {
      assertNonEmptyString(matchTerm, "matchTerms");
      searchableTerms.push(matchTerm);
    }
  }

  if (containsSensitiveTerm(searchableTerms)) {
    throw new ProfileFieldValidationError("Passwords, one-time codes, and credit card fields are not supported.");
  }
}

export function containsSensitiveTerm(values: readonly string[]): boolean {
  return values.some((value) => SENSITIVE_TERM_PATTERNS.some((pattern) => pattern.test(value)));
}

function assertNonEmptyString(value: unknown, name: string): asserts value is string {
  assertString(value, name);
  if (value.trim().length === 0) {
    throw new ProfileFieldValidationError(`Profile field ${name} must not be empty.`);
  }
}

function assertString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string") {
    throw new ProfileFieldValidationError(`Profile field ${name} must be a string.`);
  }
}

function assertFiniteNumber(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ProfileFieldValidationError(`Profile field ${name} must be a finite number.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
