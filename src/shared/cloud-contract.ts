import { looksLikePersonalValue } from "./personal-value.js";
import { KNOWN_PROFILE_KEYS, type KnownProfileKey } from "../types.js";

export const CLOUD_PATHS = {
  resolve: "/v1/schemas/resolve",
  feedback: "/v1/schemas/feedback",
  mapStructure: "/v1/agent/map-structure",
  tier3Ticket: "/v1/agent/tier3-ticket",
  readWithConsent: "/v1/agent/read-with-consent",
  outcome: "/v1/telemetry/outcome",
} as const;
export type CloudOperation = keyof typeof CLOUD_PATHS;
export const CLOUD_LIMITS = { bodyBytes: 65536, tier3Bytes: 16384, items: 200, text: 4096 } as const;
export const PAGE_PURPOSES = ["profile", "address", "payment", "contact", "security", "unknown"] as const;
export type PagePurpose = (typeof PAGE_PURPOSES)[number];
export const ERROR_CATEGORIES = [
  "anchor-not-found",
  "anchor-ambiguous",
  "classifier-conflict",
  "wall-detected",
  "lease-invalidated",
  "cloud-unreachable",
  "rate-limited",
  "budget-exhausted",
  "ai-invalid-response",
  "corroboration-failed",
  "payload-too-large",
  "consent-declined",
  "consent-timeout",
  "vault-write-failed",
  "unknown",
] as const;
export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];
export type AttributeKey = KnownProfileKey;
export interface FormSchema {
  schemaId: string;
  site: string;
  formKey: string;
  version: number;
  pageFingerprints: string[];
  fields: { anchor: string; attributeKey: AttributeKey; required: boolean }[];
  confidence: number;
  status: "candidate" | "active" | "retired";
  provenance: "official" | "gemini_structure" | "feedback";
}
export interface ResolveRequest {
  site: string;
  pageFingerprint: string;
  clientVersion: string;
}
export interface FeedbackRequest {
  schemaId: string | null;
  site: string;
  pageFingerprint: string;
  pagePurpose: PagePurpose;
  mappings: { anchor: string; attributeKey: AttributeKey }[];
  outcome: "validated" | "failed";
  resolutionTier: "shared_schema" | "gemini_structure";
  siteValidatorToken: string;
  idempotencyKey: string;
}
export interface StructureSnapshot {
  site: string;
  pageFingerprint: string;
  purposeHint: PagePurpose;
  items: {
    id: string;
    tag: string;
    type?: string;
    autocomplete?: string;
    nameTokens: string[];
    label?: string;
    heading?: string;
    valueShape?: { length: number; charClass: "digit" | "alpha" | "kana" | "kanji" | "mixed" };
  }[];
}
export interface Tier3TicketRequest {
  consentId: string;
  site: string;
  payloadSha256: string;
}
export interface ConsentedReadPayload {
  consentId: string;
  site: string;
  requestedKeys: AttributeKey[];
  items: { id: string; label?: string; text: string }[];
}
export interface ConsentedReadRequest extends ConsentedReadPayload {
  ticket: string;
}
export interface OutcomeEvent {
  siteId: string;
  formId: string;
  schemaVersion: number;
  operationType: "read" | "fill" | "update" | "withdraw" | "register";
  resolutionTier: "shared_schema" | "gemini_structure" | "gemini_pii_consent" | "local_only";
  result: "success" | "failure" | "handoff" | "declined";
  errorCategory: ErrorCategory;
  mappingConfidenceBucket: "low" | "medium" | "high" | "unknown";
  clientVersion: string;
  schemaFingerprint: string;
  occurredAt: string;
  /** Client-generated UUID so a retried delivery is applied at most once by BigQuery insertId. */
  idempotencyKey: string;
}
export interface CloudRequests {
  resolve: ResolveRequest;
  feedback: FeedbackRequest;
  mapStructure: StructureSnapshot;
  tier3Ticket: Tier3TicketRequest;
  readWithConsent: ConsentedReadRequest;
  outcome: OutcomeEvent;
}
export interface CloudResponses {
  resolve: { schema: FormSchema | null; status: "active" | "none" };
  feedback: { accepted: boolean };
  mapStructure: {
    mappings: { itemId: string; attributeKey: AttributeKey; confidence: number }[];
    pagePurpose: PagePurpose;
  };
  tier3Ticket: { ticket: string; expiresAt: string };
  readWithConsent: { values: { itemId: string; attributeKey: AttributeKey; value: string }[] };
  outcome: undefined;
}

// Validators return closed reason codes only, never the rejected content.
export class CloudContractError extends Error {
  constructor() {
    super("invalid-cloud-payload");
    this.name = "CloudContractError";
  }
}
type Obj = Record<string, unknown>;
function check(ok: unknown): asserts ok {
  if (!ok) throw new CloudContractError();
}
function object(v: unknown, required: string[], optional: string[] = []): Obj {
  check(v !== null && typeof v === "object" && !Array.isArray(v));
  const o = v as Obj;
  check(
    required.every((k) => Object.hasOwn(o, k)) &&
      Object.keys(o).every((k) => [...required, ...optional].includes(k)),
  );
  return o;
}
function str(v: unknown, max = 128): asserts v is string {
  check(typeof v === "string" && v.length > 0 && v.length <= max);
}
function pattern(v: unknown, re: RegExp, max = 128): void {
  str(v, max);
  check(re.test(v));
}
function oneOf(v: unknown, values: readonly string[]): void {
  check(typeof v === "string" && values.includes(v));
}
function integer(v: unknown, max = 1000000, min = 0): void {
  check(typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max);
}
function confidence(v: unknown): void {
  check(typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1);
}
function array(v: unknown, fn: (v: unknown) => void, min = 0): void {
  check(Array.isArray(v) && v.length >= min && v.length <= CLOUD_LIMITS.items);
  v.forEach(fn);
}
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function hash(v: unknown): void {
  pattern(v, HASH);
}
function uuid(v: unknown): void {
  pattern(v, UUID);
}
function site(v: unknown): void {
  // Registrable-domain normalization is the caller's responsibility; paths, ports, userinfo and IPs are rejected.
  pattern(v, /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, 253);
}
function version(v: unknown): void {
  pattern(v, /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[a-z0-9.-]{1,32})?$/);
}
function id(v: unknown): void {
  pattern(v, /^[fd]-[1-9][0-9]{0,5}$/);
}
export function validateSchemaAnchor(v: unknown): asserts v is string {
  str(v, 2048);
  check(/^[fd]-[1-9][0-9]{0,5}$/.test(v) || /^:root(?: > \*:nth-child\([1-9][0-9]{0,4}\)){0,32}$/.test(v));
}
function key(v: unknown): void {
  oneOf(v, KNOWN_PROFILE_KEYS);
}
function identifier(v: unknown): void {
  hash(v);
}
function safeStructure(v: unknown, max = 64): void {
  str(v, max);
  // Defense in depth. StructureSanitizer (#561) must also remove semantic personal values.
  check(!/[@\r\n]|\d{3}|(?:https?:|bearer\s|-----BEGIN)/i.test(v));
}
export function validateFormSchema(v: unknown): asserts v is FormSchema {
  const o = object(v, [
    "schemaId",
    "site",
    "formKey",
    "version",
    "pageFingerprints",
    "fields",
    "confidence",
    "status",
    "provenance",
  ]);
  identifier(o.schemaId);
  site(o.site);
  identifier(o.formKey);
  integer(o.version, 1000000, 1);
  array(o.pageFingerprints, hash, 1);
  array(
    o.fields,
    (v) => {
      const f = object(v, ["anchor", "attributeKey", "required"]);
      validateSchemaAnchor(f.anchor);
      key(f.attributeKey);
      check(typeof f.required === "boolean");
    },
    1,
  );
  confidence(o.confidence);
  oneOf(o.status, ["candidate", "active", "retired"]);
  oneOf(o.provenance, ["official", "gemini_structure", "feedback"]);
  // Basic identity and card mappings require maintainer-reviewed official provenance (§15.5).
  check(
    o.status !== "active" ||
      o.provenance === "official" ||
      !(o.fields as Obj[]).some((f) =>
        /^(?:name\.|address\.|postal\.|birth\.|card\.)/.test(String(f.attributeKey)),
      ),
  );
  // Scan every string, including nested fields, using the shared #80 privacy heuristic.
  const scan = (value: unknown): void => {
    if (typeof value === "string") check(!looksLikePersonalValue(value));
    else if (Array.isArray(value)) value.forEach(scan);
    else if (value && typeof value === "object") Object.values(value).forEach(scan);
  };
  scan(o);
  check(new TextEncoder().encode(JSON.stringify(o)).byteLength <= CLOUD_LIMITS.bodyBytes - 64);
  check(new Set((o.fields as Obj[]).map((f) => f.anchor)).size === (o.fields as Obj[]).length);
}
function readPayload(o: Obj): void {
  uuid(o.consentId);
  site(o.site);
  array(
    o.requestedKeys,
    (v) => {
      key(v);
      check(v !== "card.cvv" && v !== "account.password");
    },
    1,
  );
  check(new Set(o.requestedKeys as string[]).size === (o.requestedKeys as string[]).length);
  array(
    o.items,
    (v) => {
      const i = object(v, ["id", "text"], ["label"]);
      id(i.id);
      str(i.text, CLOUD_LIMITS.text);
      if (i.label !== undefined) str(i.label, 64);
    },
    1,
  );
  check(new Set((o.items as Obj[]).map((i) => i.id)).size === (o.items as Obj[]).length);
}
/** Stable serialization of precisely the consented content (ticket excluded). */
export function tier3PayloadJson(v: ConsentedReadPayload): string {
  const o = object(v, ["consentId", "site", "requestedKeys", "items"], ["ticket"]);
  readPayload(o);
  return JSON.stringify({
    consentId: v.consentId,
    site: v.site,
    requestedKeys: v.requestedKeys,
    items: v.items.map((i) => ({
      id: i.id,
      ...(i.label === undefined ? {} : { label: i.label }),
      text: i.text,
    })),
  });
}
export function validateCloudRequest<K extends CloudOperation>(
  operation: K,
  v: unknown,
): asserts v is CloudRequests[K] {
  check(
    new TextEncoder().encode(JSON.stringify(v)).byteLength <=
      (operation === "readWithConsent" ? CLOUD_LIMITS.tier3Bytes : CLOUD_LIMITS.bodyBytes),
  );
  switch (operation) {
    case "resolve": {
      const o = object(v, ["site", "pageFingerprint", "clientVersion"]);
      site(o.site);
      hash(o.pageFingerprint);
      version(o.clientVersion);
      break;
    }
    case "feedback": {
      const o = object(v, [
        "schemaId",
        "site",
        "pageFingerprint",
        "pagePurpose",
        "mappings",
        "outcome",
        "resolutionTier",
        "siteValidatorToken",
        "idempotencyKey",
      ]);
      if (o.schemaId !== null) identifier(o.schemaId);
      site(o.site);
      hash(o.pageFingerprint);
      oneOf(o.pagePurpose, PAGE_PURPOSES);
      array(
        o.mappings,
        (v) => {
          const m = object(v, ["anchor", "attributeKey"]);
          validateSchemaAnchor(m.anchor);
          key(m.attributeKey);
        },
        1,
      );
      oneOf(o.outcome, ["validated", "failed"]);
      oneOf(o.resolutionTier, ["shared_schema", "gemini_structure"]);
      hash(o.siteValidatorToken);
      uuid(o.idempotencyKey);
      break;
    }
    case "mapStructure": {
      const o = object(v, ["site", "pageFingerprint", "purposeHint", "items"]);
      site(o.site);
      hash(o.pageFingerprint);
      oneOf(o.purposeHint, PAGE_PURPOSES);
      array(
        o.items,
        (v) => {
          const i = object(
            v,
            ["id", "tag", "nameTokens"],
            ["type", "autocomplete", "label", "heading", "valueShape"],
          );
          id(i.id);
          oneOf(i.tag, ["input", "select", "textarea", "dd", "td", "span", "div", "p", "output"]);
          if (i.type !== undefined)
            oneOf(i.type, [
              "text",
              "email",
              "tel",
              "number",
              "date",
              "password",
              "checkbox",
              "radio",
              "hidden",
              "search",
              "url",
            ]);
          if (i.autocomplete !== undefined) pattern(i.autocomplete, /^[a-z-]{1,40}$/);
          array(i.nameTokens, (v) => safeStructure(v, 32));
          if (i.label !== undefined) safeStructure(i.label);
          if (i.heading !== undefined) safeStructure(i.heading);
          if (i.valueShape !== undefined) {
            const s = object(i.valueShape, ["length", "charClass"]);
            integer(s.length, 65536);
            oneOf(s.charClass, ["digit", "alpha", "kana", "kanji", "mixed"]);
          }
        },
        1,
      );
      check(new Set((o.items as Obj[]).map((i) => i.id)).size === (o.items as Obj[]).length);
      break;
    }
    case "tier3Ticket": {
      const o = object(v, ["consentId", "site", "payloadSha256"]);
      uuid(o.consentId);
      site(o.site);
      hash(o.payloadSha256);
      break;
    }
    case "readWithConsent": {
      const o = object(v, ["consentId", "site", "requestedKeys", "items", "ticket"]);
      readPayload(o);
      pattern(o.ticket, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, 2048);
      break;
    }
    case "outcome": {
      const o = object(v, [
        "siteId",
        "formId",
        "schemaVersion",
        "operationType",
        "resolutionTier",
        "result",
        "errorCategory",
        "mappingConfidenceBucket",
        "clientVersion",
        "schemaFingerprint",
        "occurredAt",
        "idempotencyKey",
      ]);
      site(o.siteId);
      identifier(o.formId);
      integer(o.schemaVersion);
      oneOf(o.operationType, ["read", "fill", "update", "withdraw", "register"]);
      oneOf(o.resolutionTier, ["shared_schema", "gemini_structure", "gemini_pii_consent", "local_only"]);
      oneOf(o.result, ["success", "failure", "handoff", "declined"]);
      oneOf(o.errorCategory, ERROR_CATEGORIES);
      oneOf(o.mappingConfidenceBucket, ["low", "medium", "high", "unknown"]);
      version(o.clientVersion);
      hash(o.schemaFingerprint);
      pattern(o.occurredAt, /^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/);
      check(new Date(o.occurredAt as string).toISOString() === o.occurredAt);
      uuid(o.idempotencyKey);
      break;
    }
    default:
      throw new CloudContractError();
  }
}
export function validateCloudResponse<K extends CloudOperation>(
  operation: K,
  v: unknown,
): asserts v is CloudResponses[K] {
  switch (operation) {
    case "resolve": {
      const o = object(v, ["schema", "status"]);
      oneOf(o.status, ["active", "none"]);
      if (o.status === "none") check(o.schema === null);
      else {
        validateFormSchema(o.schema);
        check(o.schema.status === "active");
      }
      break;
    }
    case "feedback": {
      const o = object(v, ["accepted"]);
      check(typeof o.accepted === "boolean");
      break;
    }
    case "mapStructure": {
      const o = object(v, ["mappings", "pagePurpose"]);
      oneOf(o.pagePurpose, PAGE_PURPOSES);
      array(o.mappings, (v) => {
        const m = object(v, ["itemId", "attributeKey", "confidence"]);
        id(m.itemId);
        key(m.attributeKey);
        confidence(m.confidence);
      });
      break;
    }
    case "tier3Ticket": {
      const o = object(v, ["ticket", "expiresAt"]);
      pattern(o.ticket, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, 2048);
      str(o.expiresAt);
      check(Number.isFinite(Date.parse(o.expiresAt)));
      break;
    }
    case "readWithConsent": {
      const o = object(v, ["values"]);
      array(o.values, (v) => {
        const r = object(v, ["itemId", "attributeKey", "value"]);
        id(r.itemId);
        key(r.attributeKey);
        check(r.attributeKey !== "card.cvv" && r.attributeKey !== "account.password");
        str(r.value, CLOUD_LIMITS.text);
      });
      break;
    }
    case "outcome":
      check(v === undefined);
      break;
    default:
      throw new CloudContractError();
  }
}

/** Cross-request validation: PII reader cannot invent item IDs or return unrequested attribute keys. */
export function validateConsentedReadValues(
  request: ConsentedReadPayload,
  response: unknown,
): asserts response is CloudResponses["readWithConsent"] {
  validateCloudResponse("readWithConsent", response);
  const allowedItemIds = new Set(request.items.map((i) => i.id));
  const allowedKeys = new Set(request.requestedKeys as string[]);
  for (const r of response.values) {
    if (!allowedItemIds.has(r.itemId) || !allowedKeys.has(r.attributeKey)) throw new CloudContractError();
  }
}

/** Cross-request validation: Gemini cannot invent IDs or duplicate item/key assignments. */
export function validateStructureMappings(
  request: StructureSnapshot,
  response: unknown,
): asserts response is CloudResponses["mapStructure"] {
  validateCloudRequest("mapStructure", request);
  validateCloudResponse("mapStructure", response);
  const ids = new Set<string>();
  const keys = new Set<AttributeKey>();
  for (const m of response.mappings) {
    if (!request.items.some((i) => i.id === m.itemId) || ids.has(m.itemId) || keys.has(m.attributeKey))
      throw new CloudContractError();
    ids.add(m.itemId);
    keys.add(m.attributeKey);
  }
}
