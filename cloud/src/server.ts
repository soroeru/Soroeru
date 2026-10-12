import type { StructureMapper, PiiReader } from "./gemini.js";
import type { SchemaRegistry } from "./schema-registry.js";
import type { SchemaFeedbackHandler } from "./schema-feedback.js";
import type { TelemetryWriter } from "./telemetry.js";
import { isIP } from "node:net";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  CLOUD_PATHS,
  CLOUD_LIMITS,
  validateCloudRequest,
  validateCloudResponse,
  validateStructureMappings,
  type CloudOperation,
  type CloudRequests,
} from "../../src/shared/cloud-contract.js";
import type { DailyBudget } from "./budget.js";
import { TicketAuthority } from "./tickets.js";
export type ServiceKind = "api" | "pii-fallback";
export interface SafeLog {
  errorCategory:
    | "none"
    | "invalid-request"
    | "payload-too-large"
    | "rate-limited"
    | "budget-exhausted"
    | "invalid-ticket"
    | "unavailable";
  latencyMs: number;
}
export interface ServerOptions {
  service: ServiceKind;
  schemas?: SchemaRegistry;
  feedback?: SchemaFeedbackHandler;
  mapper?: StructureMapper;
  /** PII fallback reader; required when service === "pii-fallback". */
  reader?: PiiReader;
  telemetry?: TelemetryWriter;
  budget: DailyBudget;
  tickets: TicketAuthority;
  log: (entry: SafeLog) => void;
  now?: () => number;
  rateLimit?: number;
  /** Enable only for the direct run.app frontend, which appends one trusted hop. */
  cloudRunProxy?: boolean;
}
class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly category: SafeLog["errorCategory"],
  ) {
    super(category);
  }
}
/** Direct Cloud Run ingress trusts only the rightmost appended address, never caller prefixes.
 * Local/direct HTTP ignores forwarding headers. Missing/malformed trusted suffix fails closed.
 */
function clientAddress(req: IncomingMessage, cloudRunProxy: boolean): string {
  if (!cloudRunProxy) return req.socket.remoteAddress ?? "unknown";
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded !== "string") throw new HttpError(400, "invalid-request");
  const addresses = forwarded.split(",");
  const address = addresses.at(-1)?.trim();
  if (addresses.length > 32 || !address || !isIP(address)) throw new HttpError(400, "invalid-request");
  // URL parsing canonicalizes IPv6 spellings so one address cannot acquire multiple buckets.
  // egress: soroeru-cloud — local URL construction for IPv6 normalization; no request is sent.
  return isIP(address) === 6 ? new URL(`http://[${address}]`).hostname : address;
}
/** Bounded in-memory per-client IP buckets; addresses never enter logs or persistence. */
class IpLimiter {
  private readonly entries = new Map<string, { tokens: number; last: number }>();
  constructor(
    private readonly capacity: number,
    private readonly now: () => number,
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error("invalid-rate-limit");
  }
  allow(ip: string): boolean {
    const now = this.now();
    for (const [key, entry] of this.entries) if (now - entry.last > 120000) this.entries.delete(key);
    let entry = this.entries.get(ip);
    if (!entry) {
      if (this.entries.size >= 10000) return false;
      entry = { tokens: this.capacity, last: now };
      this.entries.set(ip, entry);
    }
    entry.tokens = Math.min(this.capacity, entry.tokens + ((now - entry.last) * this.capacity) / 60000);
    entry.last = now;
    if (entry.tokens < 1) return false;
    entry.tokens--;
    return true;
  }
}
async function jsonBody(req: IncomingMessage, max: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += bytes.length;
    if (size > max) throw new HttpError(413, "payload-too-large");
    chunks.push(bytes);
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new HttpError(400, "invalid-request");
  }
}
function send(res: ServerResponse, status: number, body?: unknown): void {
  res.statusCode = status;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (body === undefined) res.end();
  else {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
  }
}
export function createCloudServer(options: ServerOptions) {
  const now = options.now ?? Date.now;
  const limiter = new IpLimiter(options.rateLimit ?? 30, now);
  const paths = Object.entries(CLOUD_PATHS) as [CloudOperation, string][];
  const server = createServer(async (req, res) => {
    const started = now();
    let category: SafeLog["errorCategory"] = "none";
    try {
      const origin = req.headers.origin;
      if (typeof origin === "string" && /^chrome-extension:\/\/[a-p]{32}$/.test(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
        res.setHeader("Access-Control-Allow-Methods", "POST");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      }
      if (!limiter.allow(clientAddress(req, options.cloudRunProxy ?? false)))
        throw new HttpError(429, "rate-limited");
      const operation = paths.find(([, path]) => path === req.url)?.[0];
      if (!operation || (options.service === "pii-fallback") !== (operation === "readWithConsent"))
        throw new HttpError(404, "invalid-request");
      if (req.method === "OPTIONS") {
        send(res, 204);
        return;
      }
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        throw new HttpError(405, "invalid-request");
      }
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers["content-type"] ?? ""))
        throw new HttpError(415, "invalid-request");
      const max = operation === "readWithConsent" ? CLOUD_LIMITS.tier3Bytes : CLOUD_LIMITS.bodyBytes;
      const contentLength = req.headers["content-length"];
      if (contentLength && Number(contentLength) > max) throw new HttpError(413, "payload-too-large");
      const body = await jsonBody(req, max);
      try {
        validateCloudRequest(operation, body);
      } catch {
        throw new HttpError(400, "invalid-request");
      }
      switch (operation) {
        case "resolve":
          {
            const schema = (await options.schemas?.resolve(body as CloudRequests["resolve"])) ?? null;
            const response = { schema, status: schema ? "active" : "none" };
            validateCloudResponse("resolve", response);
            send(res, 200, response);
          }
          break;
        case "feedback": {
          if (!options.feedback) throw new HttpError(503, "unavailable");
          const result = await options.feedback.process(body as CloudRequests["feedback"]);
          send(res, 200, result);
          break;
        }
        case "outcome":
          if (!options.telemetry) throw new HttpError(503, "unavailable");
          await options.telemetry.insert(body as CloudRequests["outcome"]);
          send(res, 204);
          break;
        case "mapStructure": {
          if (!(await options.budget.consume())) throw new HttpError(429, "budget-exhausted");
          if (!options.mapper) throw new HttpError(503, "unavailable");
          const request = body as CloudRequests["mapStructure"];
          const response = await options.mapper.map(request);
          validateStructureMappings(request, response);
          send(res, 200, response);
          break;
        }
        case "tier3Ticket": {
          if (!(await options.budget.consume())) throw new HttpError(429, "budget-exhausted");
          send(res, 200, options.tickets.issue(body as CloudRequests["tier3Ticket"]));
          break;
        }
        case "readWithConsent": {
          if (!options.tickets.consume(body as CloudRequests["readWithConsent"]))
            throw new HttpError(403, "invalid-ticket");
          if (!options.reader) throw new HttpError(503, "unavailable");
          const readResult = await options.reader.read(body as CloudRequests["readWithConsent"]);
          validateCloudResponse("readWithConsent", readResult);
          send(res, 200, readResult);
          break;
        }
      }
    } catch (error) {
      const failure = error instanceof HttpError ? error : new HttpError(503, "unavailable");
      category = failure.category;
      send(res, failure.status, { error: failure.category });
    } finally {
      options.log({ errorCategory: category, latencyMs: Math.max(0, Math.round(now() - started)) });
      // Drain rejected bodies without retaining their contents; keep connection/resource use bounded.
      if (!req.readableEnded) req.resume();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 32;
  return server;
}
