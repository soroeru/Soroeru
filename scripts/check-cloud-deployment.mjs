import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
const project = process.argv[2];
if (!project || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project)) throw new Error("project-id-required");
const gcloud = (...args) =>
  JSON.parse(
    execFileSync("gcloud", [...args, "--project", project, "--format=json"], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    }),
  );
const exclusion = gcloud("logging", "sinks", "describe", "_Default").exclusions?.find(
  (e) => e.name === "soroeru-cloud-no-request-logs",
);
assert.ok(exclusion, "request-log-exclusion-required");
assert.equal(exclusion.disabled ?? false, false);
for (const token of ["soroeru-api", "soroeru-pii-fallback", "run.googleapis.com/requests"])
  assert.ok(exclusion.filter.includes(token));
const iam = gcloud("projects", "get-iam-policy", project);
const fallbackAccount = `serviceAccount:soroeru-pii-fallback@${project}.iam.gserviceaccount.com`;
assert.deepEqual(
  iam.bindings
    .filter((b) => b.members.includes(fallbackAccount))
    .map((b) => b.role)
    .sort(),
  ["roles/aiplatform.user"],
);
const services = {};
for (const name of ["api", "pii-fallback"]) {
  const service = gcloud("run", "services", "describe", `soroeru-${name}`, "--region", "asia-northeast1");
  const template = service.spec.template;
  assert.equal(template.spec.serviceAccountName, `soroeru-${name}@${project}.iam.gserviceaccount.com`);
  const max = Number(template.metadata.annotations["autoscaling.knative.dev/maxScale"]);
  assert.ok(max > 0 && max <= (name === "pii-fallback" ? 1 : 2));
  assert.equal(template.spec.containerConcurrency, name === "pii-fallback" ? 1 : 20);
  const env = template.spec.containers[0].env;
  assert.ok(env.some((e) => e.name === "TIER3_TICKET_KEY" && e.valueFrom?.secretKeyRef));
  assert.ok(
    !env.some(
      (e) => /TRACE|OTEL|REQUEST_LOG|RESPONSE_LOG|CACHE/i.test(e.name) && e.value && e.value !== "false",
    ),
  );
  services[name] = service.status.url;
}
const post = async (service, path, body, expected) => {
  const response = await fetch(services[service] + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(response.status, expected, `stub-status:${path}`);
  return expected === 200 ? response.json() : undefined;
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
  200,
);
const payload = {
  consentId: randomUUID(),
  site: "example.com",
  requestedKeys: ["email"],
  items: [{ id: "d-1", text: "fake@example.com" }],
};
const { ticket } = await post(
  "api",
  "/v1/agent/tier3-ticket",
  {
    consentId: payload.consentId,
    site: payload.site,
    payloadSha256: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
  },
  200,
);
await post(
  "pii-fallback",
  "/v1/agent/read-with-consent",
  { ...payload, items: [{ id: "d-1", text: "changed" }], ticket },
  403,
);
await post("pii-fallback", "/v1/agent/read-with-consent", { ...payload, ticket }, 200);
await post("pii-fallback", "/v1/agent/read-with-consent", { ...payload, ticket }, 403);
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
  },
  503,
);
console.log(
  "PASS: Cloud Run privacy configuration, six public endpoints, payload binding and replay rejection (fake data only).",
);
console.log(
  "Vertex AI is not called by #559 stubs. Recheck provider request/response logging and caching before #561/#562 deploy.",
);
