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

export function aiProviderFromEnv(): AiProvider | undefined {
  if (!process.env["ANTHROPIC_API_KEY"]) return undefined;
  return new AnthropicProvider();
}
