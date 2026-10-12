import test from "node:test";
import assert from "node:assert/strict";
import { VertexStructureMapper } from "../dist/cloud/src/gemini.js";
const snapshot = {
  site: "example.com",
  pageFingerprint: "a".repeat(64),
  purposeHint: "unknown",
  items: [{ id: "f-1", tag: "input", nameTokens: ["email"] }],
};
const good = {
  mappings: [{ itemId: "f-1", attributeKey: "email", confidence: 0.95 }],
  pagePurpose: "contact",
};
const config = { project: "fake-project", location: "asia-northeast1", model: "gemini-test" };
test("Vertex request is stateless, schema-constrained and contains only sanitized structure", async () => {
  const mapper = new VertexStructureMapper(
    config,
    async () => "fake-token",
    async (url, init) => {
      if (String(url).endsWith("cacheConfig")) return new Response(JSON.stringify({ disableCache: true }));
      if (String(url).endsWith("fetchPublisherModelConfig"))
        return new Response(JSON.stringify({ loggingConfig: {} }));
      assert.equal(
        url,
        "https://asia-northeast1-aiplatform.googleapis.com/v1/projects/fake-project/locations/asia-northeast1/publishers/google/models/gemini-test:generateContent",
      );
      assert.equal(init.headers.Authorization, "Bearer fake-token");
      assert.equal(init.redirect, "error");
      const body = JSON.parse(init.body);
      assert.deepEqual(JSON.parse(body.contents[0].parts[0].text), snapshot);
      assert.deepEqual(Object.keys(body).sort(), ["contents", "generationConfig", "systemInstruction"]);
      assert.deepEqual(body.generationConfig.responseSchema.properties.mappings.items.properties.itemId, {
        type: "STRING",
      });
      return new Response(
        JSON.stringify({
          candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(good) }] } }],
        }),
      );
    },
  );
  assert.deepEqual(await mapper.map(snapshot), good);
});
test("Vertex rejects injected mappings, truncation, extra instructions, oversized bodies and provider failures with closed errors", async () => {
  const cases = [
    {
      candidates: [
        {
          finishReason: "STOP",
          content: { parts: [{ text: JSON.stringify({ ...good, instruction: "fake-injection" }) }] },
        },
      ],
    },
    {
      candidates: [
        {
          finishReason: "STOP",
          content: {
            parts: [
              { text: JSON.stringify({ ...good, mappings: [{ ...good.mappings[0], itemId: "f-99" }] }) },
            ],
          },
        },
      ],
    },
    { candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: JSON.stringify(good) }] } }] },
    { candidates: [] },
    "x".repeat(65537),
  ];
  for (const body of cases) {
    const mapper = new VertexStructureMapper(
      config,
      async () => "fake-token",
      async (url) =>
        new Response(
          JSON.stringify(
            String(url).endsWith("cacheConfig")
              ? { disableCache: true }
              : String(url).endsWith("fetchPublisherModelConfig")
                ? { loggingConfig: {} }
                : body,
          ),
        ),
    );
    await assert.rejects(mapper.map(snapshot), (e) => e.message === "gemini-unavailable");
  }
  const mapper = new VertexStructureMapper(config, async () => {
    throw new Error("fake-private-token");
  });
  await assert.rejects(mapper.map(snapshot), (e) => e.message === "gemini-unavailable");
});

test("provider privacy preflight refuses enabled cache/logging and inaccessible settings before generating", async () => {
  for (const mode of ["cache-enabled", "logging-enabled", "otel-enabled", "forbidden"]) {
    let generated = 0;
    const mapper = new VertexStructureMapper(
      config,
      async () => "fake-token",
      async (url) => {
        if (String(url).endsWith("cacheConfig"))
          return new Response(JSON.stringify(mode === "cache-enabled" ? {} : { disableCache: true }));
        if (String(url).endsWith("fetchPublisherModelConfig"))
          return new Response(
            JSON.stringify({
              loggingConfig: {
                enabled: mode === "logging-enabled",
                enableOtelLogging: mode === "otel-enabled",
              },
            }),
            { status: mode === "forbidden" ? 403 : 200 },
          );
        generated++;
        throw new Error("must-not-generate");
      },
    );
    await assert.rejects(mapper.map(snapshot), (e) => e.message === "gemini-unavailable");
    assert.equal(generated, 0);
  }
});
