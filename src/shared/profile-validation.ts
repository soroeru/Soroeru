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
  "cardExpiration",
]);

const SENSITIVE_TERM_PATTERNS = [
  /\bpassword\b/i,
  /\bpasscode\b/i,
  /\bone[-\s]?time\s+password\b/i,
  /\botp\b/i,
  /\bcredit\s*card\b/i,
  /\bcard\s*number\b/i,
  /\bcvv\b/i,
  /\bcvc\b/i,
  /\bsecurity\s*code\b/i,
  /\bexpir(?:y|ation)\b/i,
  /パスワード/,
  /ワンタイム/,
  /暗証番号/,
  /クレジットカード/,
  /カード番号/,
  /セキュリティコード/,
  /有効期限/,
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

  if (containsSensitiveTerm(searchableTerms) || containsCreditCardLikeNumber(value.value)) {
    throw new ProfileFieldValidationError("Passwords, one-time codes, and credit card fields are not supported.");
  }
}

export function containsSensitiveTerm(values: readonly string[]): boolean {
  return values.some((value) => SENSITIVE_TERM_PATTERNS.some((pattern) => pattern.test(value)));
}

export function containsCreditCardLikeNumber(value: string): boolean {
  const digits = value.replace(/[^\d]/g, "");
  return digits.length >= 13 && digits.length <= 19 && passesLuhnCheck(digits);
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

function passesLuhnCheck(digits: string): boolean {
  let sum = 0;
  let shouldDouble = false;

  for (let index = digits.length - 1; index >= 0; index -= 1) {
    const digit = Number(digits[index]);
    if (!Number.isInteger(digit)) {
      return false;
    }

    let addend = digit;
    if (shouldDouble) {
      addend *= 2;
      if (addend > 9) {
        addend -= 9;
      }
    }

    sum += addend;
    shouldDouble = !shouldDouble;
  }

  return sum % 10 === 0;
}
