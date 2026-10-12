import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { verifyCloudEndpoints } from "./cloud-smoke.mjs";
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
// Tokens stay in memory and never reach stdout, errors or repository files.
const token = execFileSync("gcloud", ["auth", "print-access-token"], { encoding: "utf8" }).trim();
const vertexGet = async (url) => {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: "error",
    signal: AbortSignal.timeout(10000),
  });
  const body = await response.json();
  return { response, body };
};
const cache = await vertexGet(
  `https://us-central1-aiplatform.googleapis.com/v1/projects/${project}/cacheConfig`,
);
assert.ok(cache.response.ok && cache.body.disableCache === true, "vertex-cache-enabled");
const apiEnv = gcloud("run", "services", "describe", "soroeru-api", "--region", "asia-northeast1").spec
  .template.spec.containers[0].env;
const model = apiEnv.find((e) => e.name === "GEMINI_MODEL_ID")?.value;
if (model) {
  assert.ok(/^gemini-[a-z0-9.-]{1,80}$/.test(model), "invalid-gemini-model");
  const location = apiEnv.find((e) => e.name === "GEMINI_LOCATION")?.value ?? "asia-northeast1";
  assert.ok(/^[a-z]+(?:-[a-z0-9]+)*$/.test(location), "invalid-gemini-location");
  const host = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
  const log = await vertexGet(
    `https://${host}/v1beta1/projects/${project}/locations/${location}/publishers/google/models/${model}:fetchPublisherModelConfig`,
  );
  assert.ok(
    (log.response.status === 404 && log.body.error?.status === "NOT_FOUND") ||
      (log.response.ok &&
        log.body.loggingConfig?.enabled !== true &&
        log.body.loggingConfig?.enableOtelLogging !== true),
    "vertex-logging-enabled",
  );
}
await verifyCloudEndpoints(services);
console.log("PASS: Cloud Run privacy configuration and public endpoint checks.");
console.log("PASS: Vertex implicit caching disabled and configured-model logging checked.");
