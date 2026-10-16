import {
  CLOUD_PATHS,
  CLOUD_LIMITS,
  validateCloudRequest,
  validateStructureMappings,
  validateCloudResponse,
  type CloudOperation,
  type CloudRequests,
  type CloudResponses,
} from "../src/shared/cloud-contract.js";

export class CloudClientError extends Error {
  constructor(
    readonly category:
      | "cloud-unreachable"
      | "server-error"
      | "client-error"
      | "rate-limited"
      | "budget-exhausted"
      | "ai-invalid-response",
  ) {
    super(category);
    this.name = "CloudClientError";
  }
}
/** Only the Side Panel may instantiate this client. No credentials, redirects or automatic retries. */
export class CloudClient {
  private readonly api: string;
  private readonly fallback: string;
  private readonly requests = new Set<AbortController>();
  private readonly sharingRequests = new Set<AbortController>();
  private policy: (() => { cloudAssistEnabled: boolean; telemetryEnabled: boolean }) | undefined;
  constructor(
    config: { apiBaseUrl: string; fallbackBaseUrl: string },
    // A bare `fetch` stored on the instance would be invoked with `this` = CloudClient, which
    // browsers reject as "Illegal invocation"; the wrapper keeps the global receiver.
    // egress: soroeru-cloud
    private readonly request: typeof fetch = (input, init) => fetch(input, init),
  ) {
    const base = (raw: string): string => {
      const u = new URL(raw);
      const isLocalhostHttp =
        u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1") && u.port !== "";
      if (
        (!isLocalhostHttp && u.protocol !== "https:") ||
        u.username ||
        u.password ||
        u.search ||
        u.hash ||
        u.pathname !== "/"
      )
        throw new Error("invalid-cloud-base-url");
      return u.origin;
    };
    this.api = base(config.apiBaseUrl);
    this.fallback = base(config.fallbackBaseUrl);
  }
  setPolicy(policy: (() => { cloudAssistEnabled: boolean; telemetryEnabled: boolean }) | undefined): void {
    this.policy = policy;
  }
  revoke(kind: "cloud" | "sharing"): void {
    if (kind === "cloud") for (const request of this.requests) request.abort();
    if (kind === "sharing") for (const request of this.sharingRequests) request.abort();
  }
  async call<K extends CloudOperation>(
    operation: K,
    payload: CloudRequests[K],
    signal?: AbortSignal,
  ): Promise<CloudResponses[K]> {
    validateCloudRequest(operation, payload);
    const settings = this.policy?.();
    if (
      settings &&
      (!settings.cloudAssistEnabled ||
        ((operation === "feedback" || operation === "outcome") && !settings.telemetryEnabled))
    ) {
      throw new CloudClientError("cloud-unreachable");
    }
    const controller = new AbortController();
    this.requests.add(controller);
    const isSharing = operation === "feedback" || operation === "outcome";
    if (isSharing) this.sharingRequests.add(controller);
    try {
      // egress: soroeru-cloud
      const response = await this.request(
        (operation === "readWithConsent" ? this.fallback : this.api) + CLOUD_PATHS[operation],
        {
          method: "POST",
          credentials: "omit",
          redirect: "error",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.any([
            controller.signal,
            ...(signal ? [signal] : []),
            AbortSignal.timeout(30000),
          ]),
        },
      );
      if (response.status === 429) {
        const body: unknown = await this.readResponse(response);
        throw new CloudClientError(
          body && typeof body === "object" && "error" in body && body.error === "budget-exhausted"
            ? "budget-exhausted"
            : "rate-limited",
        );
      }
      if (!response.ok) throw new CloudClientError(response.status >= 500 ? "server-error" : "client-error");
      const body: unknown =
        operation === "outcome" && response.status === 204 ? undefined : await this.readResponse(response);
      validateCloudResponse(operation, body);
      if (operation === "mapStructure") {
        validateStructureMappings(payload as CloudRequests["mapStructure"], body);
      }
      if (operation === "readWithConsent") {
        const sent = payload as CloudRequests["readWithConsent"];
        if (
          (body as CloudResponses["readWithConsent"]).values.some(
            (v) => !sent.items.some((i) => i.id === v.itemId) || !sent.requestedKeys.includes(v.attributeKey),
          )
        )
          throw new CloudClientError("ai-invalid-response");
      }
      return body;
    } catch (error) {
      if (error instanceof CloudClientError) throw error;
      throw new CloudClientError(
        error instanceof Error && error.name === "CloudContractError"
          ? "ai-invalid-response"
          : "cloud-unreachable",
      );
    } finally {
      this.requests.delete(controller);
      this.sharingRequests.delete(controller);
    }
  }
  private async readResponse(response: Response): Promise<unknown> {
    if (!response.body) throw new CloudClientError("ai-invalid-response");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > CLOUD_LIMITS.bodyBytes) throw new CloudClientError("ai-invalid-response");
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      try {
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch {
        throw new CloudClientError("ai-invalid-response");
      }
    } finally {
      await reader.cancel();
    }
  }
}
