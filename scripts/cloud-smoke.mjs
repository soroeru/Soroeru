import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
// Handlers whose backend (Gemini model, BigQuery table) is optional per deployment.
const optionalBackends = new Set([
  "/v1/agent/map-structure",
  "/v1/agent/read-with-consent",
  "/v1/telemetry/outcome",
]);
export async function verifyCloudEndpoints(services) {
  const post = async (service, path, body, expected) => {
    const response = await fetch(services[service] + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
    // Rejections (403) must never degrade to unavailability.
    if (response.status === 503 && optionalBackends.has(path) && expected !== 403) {
      assert.deepEqual(await response.json(), { error: "unavailable" }, `unavailable-body:${path}`);
      return undefined; // Backend not configured or provider unavailable: fail closed.
    }
    if (response.status === 429 && expected === "budgeted") {
      assert.deepEqual(await response.json(), { error: "budget-exhausted" }, `budget-status:${path}`);
      return undefined;
    }
    assert.equal(response.status, expected === "budgeted" ? 200 : expected, `stub-status:${path}`);
    return expected === 200 || expected === "budgeted" ? response.json() : undefined;
  };
  const hash = "a".repeat(64);
  await post(
    "api",
    "/v1/schemas/resolve",
    { site: "example.com", pageFingerprint: hash, clientVersion: "0.1.0" },
    200,
  );
  await post(
    "api",
    "/v1/schemas/feedback",
    {
      schemaId: null,
      site: "example.com",
      pageFingerprint: hash,
      pagePurpose: "profile",
      mappings: [{ anchor: "f-1", attributeKey: "email" }],
      outcome: "validated",
      resolutionTier: "gemini_structure",
      siteValidatorToken: hash,
      idempotencyKey: randomUUID(),
    },
    200,
  );
  await post(
    "api",
    "/v1/agent/map-structure",
    {
      site: "example.com",
      pageFingerprint: hash,
      purposeHint: "profile",
      items: [{ id: "f-1", tag: "input", nameTokens: [] }],
    },
    "budgeted",
  );
  const payload = {
    consentId: randomUUID(),
    site: "example.com",
    requestedKeys: ["email"],
    items: [{ id: "d-1", text: "fake@example.com" }],
  };
  const issued = await post(
    "api",
    "/v1/agent/tier3-ticket",
    {
      consentId: payload.consentId,
      site: payload.site,
      payloadSha256: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
    },
    "budgeted",
  );
  if (issued) {
    const { ticket } = issued;
    await post(
      "pii-fallback",
      "/v1/agent/read-with-consent",
      { ...payload, items: [{ id: "d-1", text: "changed" }], ticket },
      403,
    );
    await post("pii-fallback", "/v1/agent/read-with-consent", { ...payload, ticket }, 200);
    await post("pii-fallback", "/v1/agent/read-with-consent", { ...payload, ticket }, 403);
  } else {
    // Exhausted production budget is healthy. Complete ticket tests use an isolated local budget.
    await post("pii-fallback", "/v1/agent/read-with-consent", { ...payload, ticket: "abc.def" }, 403);
  }
  await post(
    "api",
    "/v1/telemetry/outcome",
    {
      siteId: "example.com",
      formId: hash,
      schemaVersion: 1,
      operationType: "read",
      resolutionTier: "local_only",
      result: "handoff",
      errorCategory: "unknown",
      mappingConfidenceBucket: "unknown",
      clientVersion: "0.1.0",
      schemaFingerprint: hash,
      occurredAt: new Date(Math.floor(Date.now() / 3600000) * 3600000).toISOString(),
      idempotencyKey: randomUUID(),
    },
    204,
  );
}
