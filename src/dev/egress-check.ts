// PRIV-001 (#20): static check for the network-egress allowlist
// (docs/security.md §6) — the only allowed external destinations are (a) the
// target sites the user acts on and (b) the user's configured AI provider.
//
// This scans `src/**/*.ts`, `run/**/*.ts`, and `electron/**/*.ts`
// (excluding `*.test.ts`) for lines that perform or configure a network call.
// Every match must carry a `// egress: <category>` annotation (on the same line
// or the line above) naming one of the allowed categories below; an
// unannotated match means a new, unreviewed network destination was added.
//
// `sites/` (the local 127.0.0.1-only PoC test-site server
// and its served fixtures) is out of scope: it is not external egress.
//
// Also flags any dependency in package.json whose name matches a
// telemetry/analytics denylist, per the "no telemetry, analytics, crash
// reporting, cloud sync" rule in docs/security.md §6.

import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const SCAN_DIRS = ["src", "run", "electron"];

/** Allowed `// egress: <category>` annotations for a flagged line. */
const ALLOWED_CATEGORIES = new Set([
  "target-site", // navigation / form submission / terms text on the site the user acts on
  "ai-provider", // the user's configured Anthropic / OpenAI provider
]);

/** Patterns that indicate a line performs or configures a network call. */
const NETWORK_PATTERNS: RegExp[] = [
  /\bfetch\(/,
  /\bnew Anthropic\(/,
  /\bnew WebSocket\(/,
  /\bhttps?\.request\(/,
  /\baxios\b/,
  /\bXMLHttpRequest\b/,
  /https?:\/\//,
];

/** Dependency-name substrings that indicate telemetry/analytics/crash-reporting tooling. */
const TELEMETRY_DENYLIST = [
  "sentry",
  "segment",
  "mixpanel",
  "amplitude",
  "datadog",
  "newrelic",
  "posthog",
  "bugsnag",
  "rollbar",
  "heap",
  "intercom",
  "hotjar",
  "fullstory",
  "analytics",
  "gtag",
];

export interface EgressCheckResult {
  scannedFiles: number;
  violations: string[];
}

function* walkTsFiles(dir: string): Generator<string> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkTsFiles(path);
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      yield path;
    }
  }
}

function isAnnotated(lines: string[], index: number): boolean {
  for (const line of [lines[index], lines[index - 1]]) {
    const category = line ? /\/\/\s*egress:\s*([a-z-]+)/.exec(line)?.[1] : undefined;
    if (category && ALLOWED_CATEGORIES.has(category)) return true;
  }
  return false;
}

function checkSourceFiles(repoRoot: string): EgressCheckResult {
  const violations: string[] = [];
  let scannedFiles = 0;
  for (const dir of SCAN_DIRS) {
    for (const file of walkTsFiles(join(repoRoot, dir))) {
      scannedFiles++;
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (!NETWORK_PATTERNS.some((re) => re.test(line))) return;
        if (!isAnnotated(lines, index)) {
          violations.push(
            `${relative(repoRoot, file)}:${index + 1}: network call without "// egress: target-site|ai-provider" annotation: ${line.trim()}`,
          );
        }
      });
    }
  }
  return { scannedFiles, violations };
}

function checkDependencyDenylist(repoRoot: string): string[] {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const names = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
  const violations: string[] = [];
  for (const name of names) {
    const lower = name.toLowerCase();
    const hit = TELEMETRY_DENYLIST.find((bad) => lower.includes(bad));
    if (hit) violations.push(`package.json: dependency "${name}" matches telemetry/analytics denylist entry "${hit}"`);
  }
  return violations;
}

/**
 * Run the PRIV-001 static egress check against the repository at `repoRoot`.
 * `violations` is empty when every network-call site is annotated with an
 * allowed `// egress: <category>` and no telemetry/analytics dependency is
 * present.
 */
export function checkNetworkEgress(repoRoot: string): EgressCheckResult {
  const { scannedFiles, violations } = checkSourceFiles(repoRoot);
  return { scannedFiles, violations: [...violations, ...checkDependencyDenylist(repoRoot)] };
}
