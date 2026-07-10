/**
 * The wire contract shared by the Chrome extension, native host, and Electron.
 * Keep this module dependency-free so it can also be bundled into the extension.
 */

export const CHROME_BRIDGE_PROTOCOL_VERSION = 1 as const;
export const CHROME_BRIDGE_MESSAGE_KINDS = ["hello", "command", "result", "event", "error"] as const;
export type ChromeBridgeMessageKind = (typeof CHROME_BRIDGE_MESSAGE_KINDS)[number];

export interface ChromeBridgeHello {
  version: typeof CHROME_BRIDGE_PROTOCOL_VERSION;
  kind: "hello";
  token: string;
}

export interface ChromeBridgeCommand {
  version: typeof CHROME_BRIDGE_PROTOCOL_VERSION;
  kind: "command";
  requestId: string;
  command: string;
  payload?: unknown;
}

export interface ChromeBridgeResult {
  version: typeof CHROME_BRIDGE_PROTOCOL_VERSION;
  kind: "result";
  requestId: string;
  ok: boolean;
  payload?: unknown;
  error?: string;
}

export interface ChromeBridgeEvent {
  version: typeof CHROME_BRIDGE_PROTOCOL_VERSION;
  kind: "event";
  event: string;
  payload?: unknown;
}

export interface ChromeBridgeError {
  version: typeof CHROME_BRIDGE_PROTOCOL_VERSION;
  kind: "error";
  code: "unsupported-version" | "unknown-kind" | "invalid-message" | "unauthorized" | "host-unavailable";
  message: string;
}

export type ChromeBridgeMessage =
  | ChromeBridgeHello
  | ChromeBridgeCommand
  | ChromeBridgeResult
  | ChromeBridgeEvent
  | ChromeBridgeError;

export class ChromeBridgeProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChromeBridgeProtocolError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) throw new ChromeBridgeProtocolError(`${key} must be a non-empty string`);
  return value;
}

function rejectUnknownKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(record).find((key) => !allowed.includes(key));
  if (unknown) throw new ChromeBridgeProtocolError(`unknown field: ${unknown}`);
}

/** Validate and narrow an untrusted decoded JSON value before it crosses a boundary. */
export function parseChromeBridgeMessage(value: unknown): ChromeBridgeMessage {
  if (!isRecord(value)) throw new ChromeBridgeProtocolError("message must be an object");
  if (value.version !== CHROME_BRIDGE_PROTOCOL_VERSION) {
    throw new ChromeBridgeProtocolError(`unsupported protocol version: ${String(value.version)}`);
  }
  const kind = value.kind;
  if (typeof kind !== "string" || !CHROME_BRIDGE_MESSAGE_KINDS.includes(kind as ChromeBridgeMessageKind)) {
    throw new ChromeBridgeProtocolError(`unknown message kind: ${String(kind)}`);
  }

  switch (kind) {
    case "hello":
      rejectUnknownKeys(value, ["version", "kind", "token"]);
      return { version: CHROME_BRIDGE_PROTOCOL_VERSION, kind, token: requireString(value, "token") };
    case "command":
      rejectUnknownKeys(value, ["version", "kind", "requestId", "command", "payload"]);
      return {
        version: CHROME_BRIDGE_PROTOCOL_VERSION,
        kind,
        requestId: requireString(value, "requestId"),
        command: requireString(value, "command"),
        ...(Object.hasOwn(value, "payload") ? { payload: value.payload } : {}),
      };
    case "result":
      rejectUnknownKeys(value, ["version", "kind", "requestId", "ok", "payload", "error"]);
      if (typeof value.ok !== "boolean") throw new ChromeBridgeProtocolError("ok must be a boolean");
      if (value.error !== undefined && typeof value.error !== "string") throw new ChromeBridgeProtocolError("error must be a string");
      return {
        version: CHROME_BRIDGE_PROTOCOL_VERSION,
        kind,
        requestId: requireString(value, "requestId"),
        ok: value.ok,
        ...(Object.hasOwn(value, "payload") ? { payload: value.payload } : {}),
        ...(value.error === undefined ? {} : { error: value.error }),
      };
    case "event":
      rejectUnknownKeys(value, ["version", "kind", "event", "payload"]);
      return {
        version: CHROME_BRIDGE_PROTOCOL_VERSION,
        kind,
        event: requireString(value, "event"),
        ...(Object.hasOwn(value, "payload") ? { payload: value.payload } : {}),
      };
    case "error": {
      rejectUnknownKeys(value, ["version", "kind", "code", "message"]);
      const codes: ChromeBridgeError["code"][] = ["unsupported-version", "unknown-kind", "invalid-message", "unauthorized", "host-unavailable"];
      if (typeof value.code !== "string" || !codes.includes(value.code as ChromeBridgeError["code"])) {
        throw new ChromeBridgeProtocolError("invalid error code");
      }
      return { version: CHROME_BRIDGE_PROTOCOL_VERSION, kind, code: value.code as ChromeBridgeError["code"], message: requireString(value, "message") };
    }
  }
  throw new ChromeBridgeProtocolError("unsupported message kind");
}

export function encodeChromeBridgeMessage(message: ChromeBridgeMessage): Buffer {
  parseChromeBridgeMessage(message);
  return Buffer.from(JSON.stringify(message), "utf8");
}
