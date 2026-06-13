// AI provider abstraction (RFC-001 v3 §6). The user's own API key, stateless
// completions only: no prompt caching, no stored threads, no provider memory.
// Requests carry form STRUCTURE and terms text — never profile values.
//
// Initial providers per RFC-001 v3 §6 are Anthropic and OpenAI; the PoC ships
// the Anthropic implementation (official SDK) and keeps the interface ready
// for an OpenAI implementation behind the same contract.

import Anthropic from "@anthropic-ai/sdk";

export interface CompleteJsonOptions {
  system: string;
  user: string;
  /** JSON schema the response must conform to (structured outputs). */
  schema: Record<string, unknown>;
  maxTokens?: number;
}

export interface AiProvider {
  readonly id: string;
  completeJson(options: CompleteJsonOptions): Promise<unknown>;
}

export class AiProviderError extends Error {
  constructor(
    message: string,
    readonly code: "request-failed" | "refusal" | "empty-response" | "invalid-json",
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "AiProviderError";
  }
}

export class AnthropicProvider implements AiProvider {
  readonly id: string;
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(options?: { apiKey?: string; model?: string }) {
    // In the real app the key comes from the encrypted settings store; the PoC
    // reads the environment (never logged, never persisted by the PoC).
    this.client = options?.apiKey ? new Anthropic({ apiKey: options.apiKey }) : new Anthropic();
    this.model = options?.model ?? process.env["AF_POC_AI_MODEL"] ?? "claude-opus-4-8";
    this.id = `anthropic:${this.model}`;
  }

  async completeJson(options: CompleteJsonOptions): Promise<unknown> {
    let response: Awaited<ReturnType<Anthropic["messages"]["create"]>>;
    try {
      response = await this.client.messages.create({
        model: this.model,
        max_tokens: options.maxTokens ?? 4096,
        thinking: { type: "adaptive" },
        system: options.system,
        output_config: {
          format: { type: "json_schema", schema: options.schema },
        },
        messages: [{ role: "user", content: options.user }],
      });
    } catch (err) {
      throw new AiProviderError("AI provider request failed; default policy is to stop without fallback", "request-failed", {
        cause: err,
      });
    }
    if (response.stop_reason === "refusal") {
      throw new AiProviderError("AI provider refused the request; default policy is to stop without fallback", "refusal");
    }
    const text = response.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") {
      throw new AiProviderError("AI provider returned no text content; default policy is to stop without fallback", "empty-response");
    }
    try {
      return JSON.parse(text.text);
    } catch (err) {
      throw new AiProviderError("AI provider returned invalid JSON; default policy is to stop without fallback", "invalid-json", {
        cause: err,
      });
    }
  }
}

// --- OpenAI provider (same contract) ----------------------------------------
// Implemented over fetch (Chat Completions + JSON-schema response format) to
// avoid adding an SDK dependency. Stateless only: no `store`, no
// `previous_response_id`, no server-side threads — the same disclosure policy
// as the Anthropic path. The transport is injectable for offline tests.

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export class OpenAiProvider implements AiProvider {
  readonly id: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(options?: { apiKey?: string; model?: string; baseUrl?: string; fetchImpl?: FetchLike }) {
    this.apiKey = options?.apiKey ?? process.env["OPENAI_API_KEY"] ?? "";
    this.model = options?.model ?? process.env["AF_POC_OPENAI_MODEL"] ?? "gpt-5.4";
    this.baseUrl = options?.baseUrl ?? "https://api.openai.com/v1";
    this.fetchImpl = options?.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.id = `openai:${this.model}`;
  }

  async completeJson(options: CompleteJsonOptions): Promise<unknown> {
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          max_completion_tokens: options.maxTokens ?? 4096,
          // Stateless: no `store`, no `previous_response_id`, no `metadata`.
          response_format: { type: "json_schema", json_schema: { name: "plan", schema: options.schema, strict: false } },
          messages: [
            { role: "system", content: options.system },
            { role: "user", content: options.user },
          ],
        }),
      });
    } catch (err) {
      throw new AiProviderError("AI provider request failed; default policy is to stop without fallback", "request-failed", {
        cause: err,
      });
    }
    if (!res.ok) {
      throw new AiProviderError(`AI provider request failed (HTTP ${res.status}); default policy is to stop without fallback`, "request-failed");
    }
    let body: {
      choices?: { message?: { content?: string | null; refusal?: string | null } }[];
    };
    try {
      body = JSON.parse(await res.text());
    } catch (err) {
      throw new AiProviderError("AI provider returned invalid JSON; default policy is to stop without fallback", "invalid-json", { cause: err });
    }
    const choice = body.choices?.[0]?.message;
    if (choice?.refusal) {
      throw new AiProviderError("AI provider refused the request; default policy is to stop without fallback", "refusal");
    }
    if (!choice?.content) {
      throw new AiProviderError("AI provider returned no text content; default policy is to stop without fallback", "empty-response");
    }
    try {
      return JSON.parse(choice.content);
    } catch (err) {
      throw new AiProviderError("AI provider returned invalid JSON; default policy is to stop without fallback", "invalid-json", { cause: err });
    }
  }
}

/** The user's configured provider settings (mirrors the encrypted store shape). */
export interface ProviderConfig {
  provider: "anthropic" | "openai";
  model: string;
  apiKey: string;
}

/** Build the provider the user configured. New providers are intentionally not added here. */
export function createProvider(config: ProviderConfig): AiProvider {
  switch (config.provider) {
    case "anthropic":
      return new AnthropicProvider({ apiKey: config.apiKey, model: config.model });
    case "openai":
      return new OpenAiProvider({ apiKey: config.apiKey, model: config.model });
  }
}

export function aiProviderFromEnv(): AiProvider | undefined {
  if (process.env["ANTHROPIC_API_KEY"]) return new AnthropicProvider();
  if (process.env["OPENAI_API_KEY"]) return new OpenAiProvider();
  return undefined;
}
