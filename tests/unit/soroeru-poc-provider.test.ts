// REQ-012 (#41): the AI provider abstraction. Anthropic and OpenAI behind one
// contract, stateless calls only, fail-stop on refusal / invalid JSON / network
// failure. Offline tests with a stub transport — no API key, no network.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AiProviderError,
  AnthropicProvider,
  createProvider,
  OpenAiProvider,
  type FetchLike,
} from "../../src/agent/ai/provider.js";

function okResponse(payload: unknown): Awaited<ReturnType<FetchLike>> {
  return { ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(payload)) };
}

function openAiContent(content: string): unknown {
  return { choices: [{ message: { content } }] };
}

test("createProvider selects the provider the user configured", () => {
  assert.ok(createProvider({ provider: "anthropic", model: "claude-test", apiKey: "k" }) instanceof AnthropicProvider);
  assert.ok(createProvider({ provider: "openai", model: "gpt-test", apiKey: "k" }) instanceof OpenAiProvider);
  assert.equal(createProvider({ provider: "openai", model: "gpt-test", apiKey: "k" }).id, "openai:gpt-test");
});

test("OpenAI provider returns parsed JSON and sends a stateless request", async () => {
  const calls: { url: string; body: string }[] = [];
  const fetchImpl: FetchLike = (url, init) => {
    calls.push({ url, body: init.body });
    return Promise.resolve(okResponse(openAiContent(JSON.stringify({ entries: [], checkboxes: [], unmappedRequired: [] }))));
  };
  const provider = new OpenAiProvider({ apiKey: "sk-fake", model: "gpt-test", fetchImpl });
  const result = await provider.completeJson({ system: "s", user: "u", schema: { type: "object" } });
  assert.deepEqual(result, { entries: [], checkboxes: [], unmappedRequired: [] });

  const body = JSON.parse(calls[0]!.body) as Record<string, unknown>;
  // Stateless: must not opt into server-side retention/threading.
  assert.equal(body["store"], undefined);
  assert.equal(body["previous_response_id"], undefined);
  assert.equal(body["metadata"], undefined);
});

test("OpenAI provider maps refusal, invalid JSON, HTTP error, and network failure to AiProviderError", async () => {
  const refuse = new OpenAiProvider({
    apiKey: "k",
    fetchImpl: () => Promise.resolve(okResponse({ choices: [{ message: { refusal: "I can't help with that" } }] })),
  });
  await assert.rejects(
    () => refuse.completeJson({ system: "", user: "", schema: {} }),
    (e: unknown) => e instanceof AiProviderError && e.code === "refusal",
  );

  const badJson = new OpenAiProvider({
    apiKey: "k",
    fetchImpl: () => Promise.resolve(okResponse(openAiContent("not json"))),
  });
  await assert.rejects(
    () => badJson.completeJson({ system: "", user: "", schema: {} }),
    (e: unknown) => e instanceof AiProviderError && e.code === "invalid-json",
  );

  const httpErr = new OpenAiProvider({
    apiKey: "k",
    fetchImpl: () => Promise.resolve({ ok: false, status: 429, text: () => Promise.resolve("rate limited") }),
  });
  await assert.rejects(
    () => httpErr.completeJson({ system: "", user: "", schema: {} }),
    (e: unknown) => e instanceof AiProviderError && e.code === "request-failed",
  );

  const netErr = new OpenAiProvider({ apiKey: "k", fetchImpl: () => Promise.reject(new Error("offline")) });
  await assert.rejects(
    () => netErr.completeJson({ system: "", user: "", schema: {} }),
    (e: unknown) => e instanceof AiProviderError && e.code === "request-failed",
  );
});

test("OpenAI provider requests a JSON-schema response derived from the passed schema", async () => {
  let sentBody = "";
  const fetchImpl: FetchLike = (_url, init) => {
    sentBody = init.body;
    return Promise.resolve(okResponse(openAiContent("{}")));
  };
  const schema = { type: "object", properties: { x: { type: "string" } } };
  await new OpenAiProvider({ apiKey: "k", fetchImpl }).completeJson({ system: "", user: "", schema });
  const body = JSON.parse(sentBody) as { response_format?: { type?: string; json_schema?: { schema?: unknown } } };
  assert.equal(body.response_format?.type, "json_schema");
  assert.deepEqual(body.response_format?.json_schema?.schema, schema);
});
