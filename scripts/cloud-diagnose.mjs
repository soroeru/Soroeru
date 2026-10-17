// Read-only Cloud diagnosis for a failed deploy or routine monitoring. Inspect the
// live resources, logs and metrics directly instead of trusting the Actions log alone.
// Run with the impersonated observer identity (docs/development.md); it never reads
// secret values, Firestore documents, BigQuery rows or Terraform state.
// Usage: node scripts/cloud-diagnose.mjs <project-id> [--since-minutes 60]
import { execFileSync } from "node:child_process";

const project = process.argv[2];
if (!project || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project)) throw new Error("project-id-required");
const sinceIndex = process.argv.indexOf("--since-minutes");
const sinceMinutes = sinceIndex > 0 ? Number(process.argv[sinceIndex + 1]) : 60;
if (!Number.isSafeInteger(sinceMinutes) || sinceMinutes < 1 || sinceMinutes > 10080)
  throw new Error("invalid-since-minutes");
const region = "asia-northeast1";
const services = ["soroeru-api", "soroeru-pii-fallback"];
const since = new Date(Date.now() - sinceMinutes * 60000).toISOString();

const gcloud = (...args) =>
  execFileSync("gcloud", [...args, "--project", project], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
const gcloudJson = (...args) => JSON.parse(gcloud(...args, "--format=json"));
// Tokens stay in memory and never reach stdout, errors or repository files.
const token = execFileSync("gcloud", ["auth", "print-access-token"], { encoding: "utf8" }).trim();
const api = async (url, init = {}) => {
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(20000),
  });
  const body = await response.json().catch(() => ({}));
  return response.ok ? body : { error: `${response.status} ${body.error?.status ?? ""}`.trim() };
};
const last = (name) => name?.split("/").pop();
const clip = (text, max = 300) =>
  String(text ?? "")
    .replace(/\s+/g, " ")
    .slice(0, max);
const section = (title) => console.log(`\n## ${title}`);

section("Identity");
const impersonated = gcloud("config", "get", "auth/impersonate_service_account").trim();
console.log(impersonated ? `impersonating ${impersonated}` : "WARNING: not impersonating the observer");

section("Cloud Run");
for (const name of services) {
  const base = `https://run.googleapis.com/v2/projects/${project}/locations/${region}/services/${name}`;
  const service = await api(base);
  if (service.error) {
    console.log(`${name}: ${service.error}`);
    continue;
  }
  const terminal = service.terminalCondition ?? {};
  console.log(
    `${name}: ${terminal.state} ${terminal.reason ?? terminal.revisionReason ?? ""} ` +
      `ready=${last(service.latestReadyRevision)} created=${last(service.latestCreatedRevision)}`,
  );
  if (terminal.message) console.log(`  message: ${clip(terminal.message)}`);
  for (const status of service.trafficStatuses ?? [])
    console.log(`  traffic: ${status.percent}% ${status.type} -> ${status.revision}`);
  const { revisions = [] } = await api(`${base}/revisions?pageSize=5`);
  for (const revision of revisions) {
    const ready = revision.terminalCondition ?? {};
    console.log(
      `  ${last(revision.name)} ${revision.createTime} ready=${ready.state ?? "?"} ${ready.reason ?? ""} ` +
        `${clip(ready.message, 160)}`,
    );
  }
}

section(`Cloud Run logs >= WARNING since ${since}`);
const runFilter =
  `resource.type="cloud_run_revision" AND resource.labels.service_name=("${services.join('" OR "')}") ` +
  `AND severity>=WARNING AND timestamp>="${since}"`;
for (const entry of gcloudJson("logging", "read", runFilter, "--limit=30", "--order=desc"))
  console.log(
    `${entry.timestamp} ${entry.resource?.labels?.revision_name} ${entry.severity} ` +
      clip(
        entry.textPayload ??
          entry.jsonPayload?.message ??
          entry.protoPayload?.status?.message ??
          JSON.stringify(entry.jsonPayload ?? {}),
      ),
  );

section(`Admin activity with errors since ${since}`);
const auditFilter =
  `logName="projects/${project}/logs/cloudaudit.googleapis.com%2Factivity" ` +
  `AND protoPayload.status.code!=0 AND timestamp>="${since}"`;
for (const entry of gcloudJson("logging", "read", auditFilter, "--limit=20", "--order=desc"))
  console.log(
    `${entry.timestamp} ${entry.protoPayload?.methodName} ${clip(entry.protoPayload?.resourceName, 120)} ` +
      `code=${entry.protoPayload?.status?.code} ${clip(entry.protoPayload?.status?.message, 200)}`,
  );

section(`Request count by response class since ${since}`);
const metrics = await api(
  `https://monitoring.googleapis.com/v3/projects/${project}/timeSeries?` +
    new URLSearchParams([
      ["filter", 'metric.type="run.googleapis.com/request_count" AND resource.type="cloud_run_revision"'],
      ["interval.startTime", since],
      ["interval.endTime", new Date().toISOString()],
      ["aggregation.alignmentPeriod", `${sinceMinutes * 60}s`],
      ["aggregation.perSeriesAligner", "ALIGN_SUM"],
      ["aggregation.crossSeriesReducer", "REDUCE_SUM"],
      ["aggregation.groupByFields", "resource.label.service_name"],
      ["aggregation.groupByFields", "metric.label.response_code_class"],
    ]),
);
if (metrics.error) console.log(metrics.error);
for (const series of metrics.timeSeries ?? [])
  console.log(
    `${series.resource?.labels?.service_name ?? "all"} ${series.metric?.labels?.response_code_class}: ` +
      (series.points ?? []).reduce((sum, p) => sum + Number(p.value?.int64Value ?? 0), 0),
  );

section("Foundation");
const cache = await api(`https://${region}-aiplatform.googleapis.com/v1/projects/${project}/cacheConfig`);
console.log(`vertex cacheConfig: ${cache.error ?? `disableCache=${cache.disableCache === true}`}`);
for (const secret of ["tier3-ticket-key", "feedback-validator-key"]) {
  try {
    const versions = gcloudJson("secrets", "versions", "list", secret, "--filter=state:ENABLED");
    console.log(`secret ${secret}: ${versions.length} enabled version(s)`);
  } catch {
    console.log(`secret ${secret}: unreadable or missing`);
  }
}
