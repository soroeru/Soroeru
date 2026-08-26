// SEC-003 production dependency audit gate.
//
// Wraps `npm audit --omit=dev`, filtered to high/critical severity, so the
// gate fails closed on any NEW high/critical advisory while not going
// permanently red on advisories that are reviewed and accepted (no patched
// release exists upstream) and recorded in accepted-advisories.json +
// docs/security.md §12.0. See docs/dependency-security.md, "When the gate
// legitimately must ignore a production advisory" for the acceptance process.
//
// npm has no native audit allowlist, so this is the documented thin-wrapper
// option: run the same audit npm audit runs, parse its JSON, and only fail on
// advisory sources not present in the accepted list.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// `npm audit --json` always reports every severity regardless of
// `--audit-level`; that flag only changes npm's own exit code, which this
// wrapper ignores in favor of its own severity filter below. Keep the two in
// sync with the gate's documented policy ("fail on high and critical; let
// moderate and below through to Dependabot").
const GATE_SEVERITIES = new Set(["high", "critical"]);

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const acceptedPath = path.join(scriptDir, "accepted-advisories.json");
const acceptedSources = new Set(JSON.parse(readFileSync(acceptedPath, "utf8")).map((entry) => entry.source));

const result = spawnSync("npm", ["audit", "--omit=dev", "--json"], {
  encoding: "utf8",
});

if (result.error) {
  console.error("audit:check: failed to run npm audit:", result.error.message);
  process.exit(1);
}

let report;
try {
  report = JSON.parse(result.stdout);
} catch {
  console.error("audit:check: could not parse npm audit output as JSON");
  console.error(result.stdout || result.stderr);
  process.exit(1);
}

if (report.error) {
  console.error("audit:check: npm audit reported an error:", JSON.stringify(report.error));
  process.exit(1);
}

const advisories = new Map();
for (const vuln of Object.values(report.vulnerabilities ?? {})) {
  for (const via of vuln.via ?? []) {
    if (
      typeof via === "object" &&
      via !== null &&
      typeof via.source === "number" &&
      GATE_SEVERITIES.has(via.severity)
    ) {
      advisories.set(via.source, via);
    }
  }
}

const unaccepted = [...advisories.values()].filter((via) => !acceptedSources.has(via.source));

if (unaccepted.length > 0) {
  console.error("audit:check: new high/critical advisory(ies) not in the accepted list:");
  for (const via of unaccepted) {
    console.error(`  - ${via.name}: ${via.title} (${via.url}, source=${via.source})`);
  }
  console.error(
    "\nReview and either fix, or record the acceptance in scripts/accepted-advisories.json + " +
      "docs/security.md §12.0 per docs/dependency-security.md.",
  );
  process.exit(1);
}

if (advisories.size > 0) {
  console.log(
    `audit:check: ${advisories.size} advisory(ies) found, all accepted (scripts/accepted-advisories.json):`,
  );
  for (const via of advisories.values()) {
    console.log(`  - ${via.name}: ${via.title} (${via.url})`);
  }
} else {
  console.log("audit:check: no high/critical advisories in the production dependency surface.");
}
