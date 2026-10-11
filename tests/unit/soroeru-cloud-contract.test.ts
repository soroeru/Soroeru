import test from "node:test";
import assert from "node:assert/strict";
import {
  validateCloudRequest,
  validateCloudResponse,
  validateFormSchema,
  tier3PayloadJson,
  CloudContractError,
  type CloudOperation,
} from "../../src/shared/cloud-contract.js";
import { CloudClient, CloudClientError } from "../../extension/cloud-client.js";
const hash = "a".repeat(64);
const uuid = "11111111-1111-4111-8111-111111111111";
const fixtures: Record<CloudOperation, unknown> = {
  resolve: { site: "example.com", pageFingerprint: hash, clientVersion: "0.1.0" },
  feedback: {
    schemaId: null,
    site: "example.com",
    pageFingerprint: hash,
    pagePurpose: "profile",
    mappings: [{ anchor: "f-1", attributeKey: "email" }],
    outcome: "validated",
    resolutionTier: "gemini_structure",
    siteValidatorToken: hash,
    idempotencyKey: uuid,
  },
  mapStructure: {
    site: "example.com",
    pageFingerprint: hash,
    purposeHint: "profile",
    items: [{ id: "f-1", tag: "input", nameTokens: ["email"], label: "メール" }],
  },
  tier3Ticket: { consentId: uuid, site: "example.com", payloadSha256: hash },
  readWithConsent: {
    consentId: uuid,
    site: "example.com",
    requestedKeys: ["email"],
    items: [{ id: "d-1", text: "fake@example.com" }],
    ticket: "abc.def",
  },
  outcome: {
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
    occurredAt: "2026-10-11T01:00:00.000Z",
  },
};
for (const operation of Object.keys(fixtures) as CloudOperation[]) {
  test(`${operation}: accepts bounded contract, rejects unknown keys and wrong types`, () => {
    validateCloudRequest(operation, fixtures[operation]);
    for (const bad of [null, [], "value", { ...(fixtures[operation] as object), value: "fake-secret" }])
      assert.throws(() => validateCloudRequest(operation, bad), CloudContractError);
  });
}
test("structure rejects values, checked state, nested unknown keys and personal-looking labels", () => {
  for (const item of [
    { id: "f-1", tag: "input", nameTokens: [], value: "fake-password" },
    { id: "f-1", tag: "input", nameTokens: [], checked: true },
    { id: "f-1", tag: "input", nameTokens: [], label: "fake@example.com" },
    { id: "f-1", tag: "input", nameTokens: [], valueShape: { length: 4, charClass: "digit", value: "1234" } },
  ])
    assert.throws(
      () => validateCloudRequest("mapStructure", { ...(fixtures.mapStructure as object), items: [item] }),
      CloudContractError,
    );
});
test("feedback cannot represent Tier 3 or selectors that contain values", () => {
  assert.throws(
    () =>
      validateCloudRequest("feedback", {
        ...(fixtures.feedback as object),
        resolutionTier: "gemini_pii_consent",
      }),
    CloudContractError,
  );
  assert.throws(
    () =>
      validateCloudRequest("feedback", {
        ...(fixtures.feedback as object),
        mappings: [{ anchor: '[name="fake@example.com"]', attributeKey: "email" }],
      }),
    CloudContractError,
  );
});
test("telemetry requires fixed enums, hashed identifiers, real hour-truncated timestamps", () => {
  for (const change of [
    { formId: "fake-person" },
    { result: "fake@example.com" },
    { occurredAt: "2026-10-11T01:01:00.000Z" },
    { occurredAt: "2026-99-11T01:00:00.000Z" },
    { schemaVersion: -1 },
  ])
    assert.throws(() => validateCloudRequest("outcome", { ...(fixtures.outcome as object), ...change }));
});
test("bounds and secret attribute keys fail closed", () => {
  assert.throws(
    () =>
      validateCloudRequest("mapStructure", {
        ...(fixtures.mapStructure as object),
        items: Array(201).fill({ id: "f-1", tag: "input", nameTokens: [] }),
      }),
    CloudContractError,
  );
  for (const key of ["account.password", "card.cvv", "invented"])
    assert.throws(
      () =>
        validateCloudRequest("readWithConsent", {
          ...(fixtures.readWithConsent as object),
          requestedKeys: [key],
        }),
      CloudContractError,
    );
  assert.throws(
    () =>
      validateCloudRequest("readWithConsent", {
        ...(fixtures.readWithConsent as object),
        items: [
          { id: "d-1", text: "あ".repeat(4096) },
          { id: "d-2", text: "あ".repeat(4096) },
        ],
      }),
    CloudContractError,
  );
});
test("FormSchema validates every nested anchor and attribute", () => {
  const schema = {
    schemaId: hash,
    site: "example.com",
    formKey: hash,
    version: 1,
    pageFingerprints: [hash],
    fields: [{ anchor: ":root > *:nth-child(1)", attributeKey: "email", required: true }],
    confidence: 0.9,
    status: "active",
    provenance: "official",
  };
  validateFormSchema(schema);
  assert.throws(
    () => validateFormSchema({ ...schema, fields: [{ ...schema.fields[0], rawValue: "fake@example.com" }] }),
    CloudContractError,
  );
  assert.throws(() => validateCloudResponse("resolve", { schema, status: "none" }), CloudContractError);
  assert.throws(
    () =>
      validateCloudResponse("mapStructure", {
        mappings: [{ itemId: "f-1", attributeKey: "email", confidence: Infinity }],
        pagePurpose: "profile",
      }),
    CloudContractError,
  );
});
test("ticket hash serialization ignores wire ordering and excludes the ticket", () => {
  const payload = {
    consentId: uuid,
    site: "example.com",
    requestedKeys: ["email" as const],
    items: [{ id: "d-1", text: "fake@example.com" }],
  };
  assert.equal(
    tier3PayloadJson(payload),
    tier3PayloadJson({
      items: payload.items,
      requestedKeys: payload.requestedKeys,
      site: payload.site,
      consentId: payload.consentId,
    }),
  );
});
test("CloudClient validates before egress and uses a separate fallback origin without credentials/retries", async () => {
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const transport: typeof fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return Response.json({ values: [] });
  };
  const client = new CloudClient(
    { apiBaseUrl: "https://api.example.com", fallbackBaseUrl: "https://fallback.example.com" },
    transport,
  );
  await client.call(
    "readWithConsent",
    fixtures.readWithConsent as Parameters<typeof client.call<"readWithConsent">>[1],
  );
  assert.equal(requests[0]?.url, "https://fallback.example.com/v1/agent/read-with-consent");
  assert.equal(requests[0]?.init?.credentials, "omit");
  assert.equal(requests[0]?.init?.redirect, "error");
  await assert.rejects(
    client.call("resolve", { site: "fake@example.com", pageFingerprint: hash, clientVersion: "0.1.0" }),
  );
  assert.equal(requests.length, 1);
});
test("CloudClient rejects malformed responses and never retries a failure", async () => {
  let calls = 0;
  const client = new CloudClient(
    { apiBaseUrl: "https://api.example.com", fallbackBaseUrl: "https://fallback.example.com" },
    async () => {
      calls++;
      return Response.json({ error: "budget-exhausted" }, { status: 429 });
    },
  );
  await assert.rejects(
    client.call(
      "resolve",
      fixtures.resolve as { site: string; pageFingerprint: string; clientVersion: string },
    ),
    (e: unknown) => e instanceof CloudClientError && e.category === "budget-exhausted",
  );
  assert.equal(calls, 1);
});

test("CloudClient rejects malformed/oversized response bodies and unobserved mapping IDs", async () => {
  for (const response of [
    new Response("not-json"),
    new Response("x".repeat(65537)),
    Response.json({
      mappings: [{ itemId: "f-2", attributeKey: "email", confidence: 0.9 }],
      pagePurpose: "profile",
    }),
  ]) {
    const client = new CloudClient(
      { apiBaseUrl: "https://api.example.com", fallbackBaseUrl: "https://fallback.example.com" },
      async () => response,
    );
    await assert.rejects(
      client.call("mapStructure", fixtures.mapStructure as Parameters<typeof client.call<"mapStructure">>[1]),
      (e: unknown) => e instanceof CloudClientError && e.category === "ai-invalid-response",
    );
  }
});
