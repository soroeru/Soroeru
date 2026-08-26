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
//
// Acceptance is scoped to the exact dependency path (accepted `package` +
// `consumedBy`), not just the advisory id: if the same advisory later shows
// up via a different, non-accepted consumer (e.g. a genuine runtime
// dependency instead of the build-time-only one that was accepted), the gate
// fails closed on that occurrence instead of silently exempting it.

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
const acceptedBySource = new Map(
  JSON.parse(readFileSync(acceptedPath, "utf8")).map((entry) => [entry.source, entry]),
);

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

const accepted = new Map();
const unaccepted = [];
for (const vuln of Object.values(report.vulnerabilities ?? {})) {
  const effects = vuln.effects ?? [];
  for (const via of vuln.via ?? []) {
    if (typeof via !== "object" || via === null || typeof via.source !== "number") continue;
    if (!GATE_SEVERITIES.has(via.severity)) continue;

    const entry = acceptedBySource.get(via.source);
    const pathAccepted =
      entry !== undefined &&
      entry.package === vuln.name &&
      effects.length > 0 &&
      effects.every((consumer) => entry.consumedBy.includes(consumer));

    if (pathAccepted) {
      accepted.set(via.source, via);
    } else {
      unaccepted.push({ via, vuln, entry });
    }
  }
}

if (unaccepted.length > 0) {
  console.error(
    "audit:check: new high/critical advisory(ies), or an accepted advisory reached through an " +
      "unaccepted dependency path:",
  );
  for (const { via, vuln, entry } of unaccepted) {
    const pathNote = entry
      ? ` [accepted only via ${JSON.stringify(entry.consumedBy)}, seen via ${JSON.stringify(vuln.effects ?? [])}]`
      : "";
    console.error(`  - ${vuln.name}: ${via.title} (${via.url}, source=${via.source})${pathNote}`);
  }
  console.error(
    "\nReview and either fix, or record the acceptance in scripts/accepted-advisories.json + " +
      "docs/security.md §12.0 per docs/dependency-security.md.",
  );
  process.exit(1);
}

if (accepted.size > 0) {
  console.log(
    `audit:check: ${accepted.size} advisory(ies) found, all accepted (scripts/accepted-advisories.json):`,
  );
  for (const via of accepted.values()) {
    console.log(`  - ${via.name}: ${via.title} (${via.url})`);
  }
} else {
  console.log("audit:check: no high/critical advisories in the production dependency surface.");
}
