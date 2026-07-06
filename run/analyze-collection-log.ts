// CLI for the collection-run failure analysis (Issue #317): read a
// downloaded / on-disk diagnostics log (soroeru.log, JSONL) and print the
// failure causes ranked by count, so the Product Owner can see what to fix
// first. Local-only tooling: reads one local file, no network egress.
//
// Usage:
//   node dist/compiled/run/analyze-collection-log.js <path/to/soroeru.log> [--json] [--no-sites]
//
// The log carries structural facts only (domains, reason codes); still, the
// domain list identifies which services the user has accounts on, so treat
// the output as local working data — do not paste domain lists into commits,
// Issues, or docs (docs get categories and counts only).

import { readFile } from "node:fs/promises";
import {
  parseLogEntries,
  rankFailureCauses,
  siteOutcomes,
} from "../src/logging/collection-log-analysis.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const showSites = !args.includes("--no-sites");
  const logPath = args.find((arg) => !arg.startsWith("--"));
  if (logPath === undefined) {
    console.error(
      "usage: analyze-collection-log <path/to/soroeru.log> [--json] [--no-sites]",
    );
    process.exitCode = 2;
    return;
  }

  const text = await readFile(logPath, "utf8");
  const outcomes = siteOutcomes(parseLogEntries(text));
  const causes = rankFailureCauses(outcomes);
  const collected = outcomes.filter((outcome) => outcome.category === "collected").length;
  const canceled = outcomes.filter((outcome) => outcome.category === "canceled").length;
  const failedTotal = causes.reduce((sum, cause) => sum + cause.count, 0);

  if (json) {
    console.log(
      JSON.stringify(
        {
          sites: outcomes.length,
          collected,
          canceled,
          failed: failedTotal,
          causes: showSites ? causes : causes.map(({ sites: _sites, ...rest }) => rest),
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`sites analyzed: ${outcomes.length}`);
  console.log(`collected: ${collected}  failed: ${failedTotal}  canceled: ${canceled}`);
  console.log("");
  if (causes.length === 0) {
    console.log("no failure causes found in this log.");
    return;
  }
  console.log("failure causes (most frequent first):");
  for (const [index, cause] of causes.entries()) {
    const share = (cause.share * 100).toFixed(1);
    console.log(`${index + 1}. ${cause.category} — ${cause.count} site(s), ${share}% of all sites`);
    if (showSites) {
      for (const site of cause.sites) console.log(`     - ${site}`);
    }
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
