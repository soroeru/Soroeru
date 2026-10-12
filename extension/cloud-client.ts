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
    readonly category: "cloud-unreachable" | "rate-limited" | "budget-exhausted" | "ai-invalid-response",
  ) {
    super(category);
    this.name = "CloudClientError";
  }
}
/** Only the Side Panel may instantiate this client. No credentials, redirects or automatic retries. */
export class CloudClient {
  private readonly api: string;
  private readonly fallback: string;
  constructor(
    config: { apiBaseUrl: string; fallbackBaseUrl: string },
    private readonly request: typeof fetch = fetch,
  ) {
    const base = (raw: string): string => {
      const u = new URL(raw);
      if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash || u.pathname !== "/")
        throw new Error("invalid-cloud-base-url");
      return u.origin;
    };
    this.api = base(config.apiBaseUrl);
    this.fallback = base(config.fallbackBaseUrl);
  }
  async call<K extends CloudOperation>(
    operation: K,
    payload: CloudRequests[K],
    signal?: AbortSignal,
  ): Promise<CloudResponses[K]> {
    validateCloudRequest(operation, payload);
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
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
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
      if (!response.ok) throw new CloudClientError("cloud-unreachable");
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
