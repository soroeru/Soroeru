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
await verifyCloudEndpoints(services);
console.log("PASS: Cloud Run privacy configuration and public endpoint checks.");
console.log(
  "Vertex AI is not called by #559 stubs. Recheck provider logging and caching before #561/#562 deploy.",
);
