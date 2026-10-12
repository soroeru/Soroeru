import { validateFormSchema, type FormSchema } from "./cloud-contract.js";
/**
 * Wire contract for the Side Panel <-> service worker <-> content script lease protocol
 * (Issue #558). A lease binds one Side Panel to one tab/origin/site scope for one epoch.
 * Strict validators reject unknown fields so untrusted senders cannot smuggle extra data.
 */

import { isObservationToken, type ObservationToken } from "../automation/collection-observation.js";
import { ChromeBridgeProtocolError, isRecord, rejectUnknownKeys, requireString } from "./chrome-bridge.js";

export const EXTENSION_MESSAGE_VERSION = 1 as const;
/** Name of the long-lived runtime port the Side Panel opens to the service worker. */
export const PANEL_PORT_NAME = "soroeru-panel";

export const LEASE_INVALID_REASONS = [
  "released",
  "panel-closed",
  "tab-closed",
  "navigated-out-of-scope",
  "permission-removed",
  "content-script-lost",
  "worker-restarted",
  "superseded",
] as const;
export type LeaseInvalidReason = (typeof LEASE_INVALID_REASONS)[number];

export const PAGE_REJECTED_REASONS = [
  "no-lease",
  "lease-mismatch",
  "stale-epoch",
  "origin-out-of-scope",
  "untrusted-sender",
  "invalid-command",
] as const;
export type PageRejectedReason = (typeof PAGE_REJECTED_REASONS)[number];

export const PAGE_EVENT_NAMES = ["navigated", "ready"] as const;
export type PageEventName = (typeof PAGE_EVENT_NAMES)[number];

export type PageCommand =
  | { command: "goto"; url: string }
  | { command: "currentUrl" }
  | { command: "snapshot" }
  | { command: "schemaFingerprint" }
  | { command: "structureSnapshot"; site: string }
  | { command: "readSchema"; schema: FormSchema }
  | { command: "captureCollectionObservation"; bindingEpoch: number }
  | { command: "checkCollectionObservation"; token: ObservationToken }
  | { command: "readValues"; fieldIds?: string[] }
  | { command: "readDisplayValues"; valueIds?: string[] }
  | { command: "fillField"; fieldId: string; value: string }
  | { command: "click"; selector: string }
  | { command: "waitForReady" }
  /**
   * Tier 3 masked region read (design #554 §5.3). Returns items from the subtree most
   * likely to contain the requested attributes, with C0 values replaced by "[SECRET]"
   * before leaving the page. The result is an input to Tier3PayloadBuilder, which
   * re-validates masking and enforces the 16 KiB limit before building the consent payload.
   */
  | { command: "readRegionMasked"; requestedKeys: string[]; resolvedIds?: string[] };
export type PageCommandName = PageCommand["command"];

interface Versioned {
  version: typeof EXTENSION_MESSAGE_VERSION;
}

export interface LeaseOpen extends Versioned {
  kind: "lease.open";
  nonce: string;
  tabId: number;
  origin: string;
  siteDomain?: string;
}
export interface LeaseRelease extends Versioned {
  kind: "lease.release";
  leaseId: string;
}
export interface LeaseOpened extends Versioned {
  kind: "lease.opened";
  nonce: string;
  leaseId: string;
  tabId: number;
  origin: string;
  siteDomain?: string;
  epoch: number;
  bootId: string;
}
export interface LeaseInvalidated extends Versioned {
  kind: "lease.invalidated";
  leaseId: string;
  reason: LeaseInvalidReason;
}
export interface PageEvent extends Versioned {
  kind: "page.event";
  leaseId: string;
  epoch: number;
  event: PageEventName;
  url: string;
}
export interface PageCommandMessage extends Versioned {
  kind: "page.command";
  requestId: string;
  leaseId: string;
  epoch: number;
  command: PageCommand;
}
export interface PageResult extends Versioned {
  kind: "page.result";
  requestId: string;
  ok: boolean;
  payload?: unknown;
  error?: string;
}
export interface PageRejected extends Versioned {
  kind: "page.rejected";
  requestId: string;
  reason: PageRejectedReason;
}
/** Internal: worker -> content script. */
export interface LeaseBind extends Versioned {
  kind: "lease.bind";
  leaseId: string;
  epoch: number;
  origin: string;
  siteDomain?: string;
}
/** Internal: worker -> content script. */
export interface LeaseRevoke extends Versioned {
  kind: "lease.revoke";
  leaseId: string;
}
export interface Keepalive extends Versioned {
  kind: "keepalive";
}

export type ExtensionMessage =
  | LeaseOpen
  | LeaseRelease
  | LeaseOpened
  | LeaseInvalidated
  | PageEvent
  | PageCommandMessage
  | PageResult
  | PageRejected
  | LeaseBind
  | LeaseRevoke
  | Keepalive;
export type ExtensionMessageKind = ExtensionMessage["kind"];
export const EXTENSION_MESSAGE_KINDS = [
  "lease.open",
  "lease.release",
  "lease.opened",
  "lease.invalidated",
  "page.event",
  "page.command",
  "page.result",
  "page.rejected",
  "lease.bind",
  "lease.revoke",
  "keepalive",
] as const satisfies readonly ExtensionMessageKind[];

const fail = (message: string): never => {
  throw new ChromeBridgeProtocolError(message);
};

function requireTabId(record: Record<string, unknown>): number {
  const value = record.tabId;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1)
    return fail("tabId must be a positive integer");
  return value;
}

function requireEpoch(record: Record<string, unknown>, key = "epoch"): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    return fail(`${key} must be a non-negative integer`);
  return value;
}

function requireOrigin(record: Record<string, unknown>): string {
  const origin = requireString(record, "origin");
  if (!isHttpsOrigin(origin)) return fail("origin must be an HTTPS origin");
  return origin;
}

function optionalSiteDomain(record: Record<string, unknown>): { siteDomain?: string } {
  if (!Object.hasOwn(record, "siteDomain") || record.siteDomain === undefined) return {};
  return { siteDomain: requireString(record, "siteDomain") };
}

export function isHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value;
  } catch {
    return false;
  }
}

function optionalStringArray(record: Record<string, unknown>, key: string): { [k: string]: string[] } {
  if (!Object.hasOwn(record, key) || record[key] === undefined) return {};
  const value = record[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))
    return fail(`${key} must be a string array`);
  return { [key]: value as string[] };
}

/** Validate an untrusted page command payload (no tabId: the lease supplies the tab). */
export function parsePageCommand(value: unknown): PageCommand {
  if (!isRecord(value)) return fail("command must be an object");
  const name = requireString(value, "command");
  switch (name) {
    case "goto": {
      rejectUnknownKeys(value, ["command", "url"]);
      const url = requireString(value, "url");
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return fail("goto URL is invalid");
      }
      if (parsed.protocol !== "https:") return fail("goto URL must be HTTPS");
      return { command: "goto", url };
    }
    case "currentUrl":
    case "snapshot":
    case "schemaFingerprint":
    case "waitForReady":
      rejectUnknownKeys(value, ["command"]);
      return { command: name };
    case "structureSnapshot": {
      rejectUnknownKeys(value, ["command", "site"]);
      return { command: name, site: requireString(value, "site") };
    }
    case "readSchema": {
      rejectUnknownKeys(value, ["command", "schema"]);
      validateFormSchema(value.schema);
      return { command: name, schema: value.schema };
    }
    case "captureCollectionObservation": {
      rejectUnknownKeys(value, ["command", "bindingEpoch"]);
      return { command: name, bindingEpoch: requireEpoch(value, "bindingEpoch") };
    }
    case "checkCollectionObservation":
      rejectUnknownKeys(value, ["command", "token"]);
      if (!isObservationToken(value.token)) return fail("invalid observation token");
      return { command: name, token: value.token };
    case "readValues":
      rejectUnknownKeys(value, ["command", "fieldIds"]);
      return { command: name, ...optionalStringArray(value, "fieldIds") };
    case "readDisplayValues":
      rejectUnknownKeys(value, ["command", "valueIds"]);
      return { command: name, ...optionalStringArray(value, "valueIds") };
    case "fillField": {
      rejectUnknownKeys(value, ["command", "fieldId", "value"]);
      if (typeof value.value !== "string") return fail("value must be a string");
      return { command: name, fieldId: requireString(value, "fieldId"), value: value.value };
    }
    case "click":
      rejectUnknownKeys(value, ["command", "selector"]);
      return { command: name, selector: requireString(value, "selector") };
    case "readRegionMasked": {
      rejectUnknownKeys(value, ["command", "requestedKeys", "resolvedIds"]);
      const keys = value.requestedKeys;
      if (!Array.isArray(keys) || keys.length === 0 || keys.length > 50 || keys.some((k) => typeof k !== "string"))
        return fail("requestedKeys must be a non-empty string array");
      const resolvedIds = value.resolvedIds;
      if (resolvedIds !== undefined) {
        if (!Array.isArray(resolvedIds) || resolvedIds.length > 500 || resolvedIds.some((k) => typeof k !== "string"))
          return fail("resolvedIds must be a string array");
      }
      return {
        command: name,
        requestedKeys: keys as string[],
        ...(resolvedIds !== undefined ? { resolvedIds: resolvedIds as string[] } : {}),
      };
    }
  }
  return fail(`unknown page command: ${name}`);
}

/** Validate and narrow an untrusted decoded value before it crosses a lease boundary. */
export function parseExtensionMessage(value: unknown): ExtensionMessage {
  if (!isRecord(value)) return fail("message must be an object");
  if (value.version !== EXTENSION_MESSAGE_VERSION)
    return fail(`unsupported protocol version: ${String(value.version)}`);
  const kind = value.kind;
  if (typeof kind !== "string" || !EXTENSION_MESSAGE_KINDS.includes(kind as ExtensionMessageKind))
    return fail(`unknown message kind: ${String(kind)}`);
  const version = EXTENSION_MESSAGE_VERSION;

  switch (kind as ExtensionMessageKind) {
    case "lease.open":
      rejectUnknownKeys(value, ["version", "kind", "nonce", "tabId", "origin", "siteDomain"]);
      return {
        version,
        kind: "lease.open",
        nonce: requireString(value, "nonce"),
        tabId: requireTabId(value),
        origin: requireOrigin(value),
        ...optionalSiteDomain(value),
      };
    case "lease.release":
      rejectUnknownKeys(value, ["version", "kind", "leaseId"]);
      return { version, kind: "lease.release", leaseId: requireString(value, "leaseId") };
    case "lease.opened":
      rejectUnknownKeys(value, [
        "version",
        "kind",
        "nonce",
        "leaseId",
        "tabId",
        "origin",
        "siteDomain",
        "epoch",
        "bootId",
      ]);
      return {
        version,
        kind: "lease.opened",
        nonce: requireString(value, "nonce"),
        leaseId: requireString(value, "leaseId"),
        tabId: requireTabId(value),
        origin: requireOrigin(value),
        ...optionalSiteDomain(value),
        epoch: requireEpoch(value),
        bootId: requireString(value, "bootId"),
      };
    case "lease.invalidated": {
      rejectUnknownKeys(value, ["version", "kind", "leaseId", "reason"]);
      const reason = requireString(value, "reason");
      if (!LEASE_INVALID_REASONS.includes(reason as LeaseInvalidReason)) return fail("invalid reason");
      return {
        version,
        kind: "lease.invalidated",
        leaseId: requireString(value, "leaseId"),
        reason: reason as LeaseInvalidReason,
      };
    }
    case "page.event": {
      rejectUnknownKeys(value, ["version", "kind", "leaseId", "epoch", "event", "url"]);
      const event = requireString(value, "event");
      if (!PAGE_EVENT_NAMES.includes(event as PageEventName)) return fail("invalid event");
      if (typeof value.url !== "string") return fail("url must be a string");
      return {
        version,
        kind: "page.event",
        leaseId: requireString(value, "leaseId"),
        epoch: requireEpoch(value),
        event: event as PageEventName,
        url: value.url,
      };
    }
    case "page.command":
      rejectUnknownKeys(value, ["version", "kind", "requestId", "leaseId", "epoch", "command"]);
      return {
        version,
        kind: "page.command",
        requestId: requireString(value, "requestId"),
        leaseId: requireString(value, "leaseId"),
        epoch: requireEpoch(value),
        command: parsePageCommand(value.command),
      };
    case "page.result":
      rejectUnknownKeys(value, ["version", "kind", "requestId", "ok", "payload", "error"]);
      if (typeof value.ok !== "boolean") return fail("ok must be a boolean");
      if (value.error !== undefined && typeof value.error !== "string") return fail("error must be a string");
      return {
        version,
        kind: "page.result",
        requestId: requireString(value, "requestId"),
        ok: value.ok,
        ...(Object.hasOwn(value, "payload") ? { payload: value.payload } : {}),
        ...(value.error === undefined ? {} : { error: value.error }),
      };
    case "page.rejected": {
      rejectUnknownKeys(value, ["version", "kind", "requestId", "reason"]);
      const reason = requireString(value, "reason");
      if (!PAGE_REJECTED_REASONS.includes(reason as PageRejectedReason)) return fail("invalid reason");
      return {
        version,
        kind: "page.rejected",
        requestId: requireString(value, "requestId"),
        reason: reason as PageRejectedReason,
      };
    }
    case "lease.bind":
      rejectUnknownKeys(value, ["version", "kind", "leaseId", "epoch", "origin", "siteDomain"]);
      return {
        version,
        kind: "lease.bind",
        leaseId: requireString(value, "leaseId"),
        epoch: requireEpoch(value),
        origin: requireOrigin(value),
        ...optionalSiteDomain(value),
      };
    case "lease.revoke":
      rejectUnknownKeys(value, ["version", "kind", "leaseId"]);
      return { version, kind: "lease.revoke", leaseId: requireString(value, "leaseId") };
    case "keepalive":
      rejectUnknownKeys(value, ["version", "kind"]);
      return { version, kind: "keepalive" };
  }
}

/** Same-site boundary: a domain and its subdomains, never a sibling domain. */
export function isSameSiteOrigin(origin: string, siteDomain: string): boolean {
  try {
    const host = new URL(origin).hostname.toLowerCase().replace(/^www\./, "");
    return host === siteDomain || host.endsWith(`.${siteDomain}`);
  } catch {
    return false;
  }
}

/** Whether a page origin stays inside a lease's origin / site scope. Non-HTTPS is never in scope. */
export function isOriginInLeaseScope(
  pageOrigin: string,
  scope: { origin: string; siteDomain?: string | undefined },
): boolean {
  if (!isHttpsOrigin(pageOrigin)) return false;
  if (scope.siteDomain !== undefined) return isSameSiteOrigin(pageOrigin, scope.siteDomain);
  return pageOrigin === scope.origin;
}
