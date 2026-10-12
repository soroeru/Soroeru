// PRIV-001 (#20) + Issue #564: static check for the network-egress allowlist
// (docs/security.md §6) — the only allowed external destinations are (a) the
// target sites the user acts on, (b) the user's configured AI provider
// (non-extension code only), and (c) Soroeru Cloud (typed Cloud Run API).
//
// This scans `src/**/*.ts`, `run/**/*.ts`, `electron/**/*.ts`,
// `extension/**/*.ts`, `cloud/**/*.ts`, and `native-host/**/*.ts`
// (excluding `*.test.ts`) for lines that perform or configure a network call.
// Every match must carry a `// egress: <category>` annotation (on the same line
// or the line above) naming one of the allowed categories below; an
// unannotated match means a new, unreviewed network destination was added.
//
// Additional restrictions (Issue #564):
// - Files under `extension/` must not use `// egress: ai-provider`; the
//   extension routes AI calls via Soroeru Cloud only.
// - Root `package.json` must not contain Google Cloud SDK packages; they
//   belong exclusively in `cloud/package.json` (docs/security.md §15.6).
// - Extension source files must not contain GCP credential-like strings
//   (service-account JSON fields, API key format `AIza…`).
//
// `sites/` (the local 127.0.0.1-only PoC test-site server
// and its served fixtures) is out of scope: it is not external egress.
//
// Also flags any dependency in package.json whose name matches a
// telemetry/analytics denylist, per the "no telemetry, analytics, crash
// reporting, cloud sync" rule in docs/security.md §6.

import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

export const SCAN_DIRS = ["src", "run", "electron", "extension", "cloud", "native-host"];

/** Allowed `// egress: <category>` annotations for a flagged line. */
const ALLOWED_CATEGORIES = new Set([
  "soroeru-cloud", // Issue #554: typed Cloud Run API from the Side Panel / cloud service
  "target-site", // navigation / form submission / terms text on the site the user acts on
  "ai-provider", // the user's configured Anthropic / OpenAI provider (non-extension only)
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

/**
 * Dependency name prefixes / exact names that indicate Google Cloud SDK packages.
 * These are allowed in `cloud/package.json` but must not appear in the root
 * `package.json` (docs/security.md §15.6).
 */
const GOOGLE_CLOUD_SDK_PREFIXES = ["@google-cloud/", "google-cloud-"];
const GOOGLE_CLOUD_SDK_EXACT = ["googleapis", "google-auth-library", "firebase-admin", "firebase-functions"];

/** GCP credential patterns that must never appear in extension source files. */
const GCP_CREDENTIAL_PATTERNS: RegExp[] = [
  /"type"\s*:\s*"service_account"/, // service-account JSON type marker
  /"private_key"\s*:\s*"-----BEGIN/, // service-account private key field
  /AIza[0-9A-Za-z\-_]{35}/, // GCP API key format (39 chars total)
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

function getEgressCategory(lines: string[], index: number): string | undefined {
  for (const line of [lines[index], lines[index - 1]]) {
    const category = line ? /\/\/\s*egress:\s*([a-z-]+)/.exec(line)?.[1] : undefined;
    if (category) return category;
  }
  return undefined;
}

function isAnnotatedForDir(lines: string[], index: number, isExtensionDir: boolean): boolean {
  const category = getEgressCategory(lines, index);
  if (!category || !ALLOWED_CATEGORIES.has(category)) return false;
  // ai-provider is not permitted from the extension (Issue #564)
  if (isExtensionDir && category === "ai-provider") return false;
  return true;
}

function checkSourceFiles(repoRoot: string): EgressCheckResult {
  const violations: string[] = [];
  let scannedFiles = 0;
  for (const dir of SCAN_DIRS) {
    const isExtensionDir = dir === "extension";
    for (const file of walkTsFiles(join(repoRoot, dir))) {
      scannedFiles++;
      const relFile = relative(repoRoot, file);
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (!NETWORK_PATTERNS.some((re) => re.test(line))) return;
        if (isAnnotatedForDir(lines, index, isExtensionDir)) return;
        const category = getEgressCategory(lines, index);
        let msg: string;
        if (isExtensionDir && category === "ai-provider") {
          msg = `${relFile}:${index + 1}: extension must not use "// egress: ai-provider"; route AI via soroeru-cloud (docs/security.md §6): ${line.trim()}`;
        } else {
          msg = `${relFile}:${index + 1}: network call without "// egress: <allowed category>" annotation: ${line.trim()}`;
        }
        violations.push(msg);
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

function isGoogleCloudSdk(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    GOOGLE_CLOUD_SDK_PREFIXES.some((prefix) => lower.startsWith(prefix)) ||
    GOOGLE_CLOUD_SDK_EXACT.includes(lower)
  );
}

/**
 * Fail if the root `package.json` contains a Google Cloud SDK package.
 * GCP SDK packages belong exclusively in `cloud/package.json` (docs/security.md §15.6).
 */
function checkRootGcpSdkDenylist(repoRoot: string): string[] {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const names = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
  const violations: string[] = [];
  for (const name of names) {
    if (isGoogleCloudSdk(name)) {
      violations.push(
        `package.json: Google Cloud SDK dependency "${name}" must only appear in cloud/package.json (docs/security.md §15.6)`,
      );
    }
  }
  return violations;
}

/**
 * Fail if any extension source file contains a GCP credential-like string
 * (service-account JSON fields or API key format), which would indicate a
 * credential has been embedded in the extension bundle (docs/security.md §6).
 */
function checkExtensionCredentials(repoRoot: string): string[] {
  const violations: string[] = [];
  for (const file of walkTsFiles(join(repoRoot, "extension"))) {
    const relFile = relative(repoRoot, file);
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      const hit = GCP_CREDENTIAL_PATTERNS.find((re) => re.test(line));
      if (hit) {
        violations.push(
          `${relFile}:${index + 1}: GCP credential-like string in extension source (docs/security.md §6): ${line.trim()}`,
        );
      }
    });
  }
  return violations;
}

/**
 * Run the PRIV-001 static egress check against the repository at `repoRoot`.
 * `violations` is empty when every network-call site is annotated with an
 * allowed `// egress: <category>`, no telemetry/analytics dependency is
 * present, no Google Cloud SDK appears in the root package.json, and no
 * GCP credential-like string appears in extension source files.
 */
export function checkNetworkEgress(repoRoot: string): EgressCheckResult {
  const { scannedFiles, violations } = checkSourceFiles(repoRoot);
  return {
    scannedFiles,
    violations: [
      ...violations,
      ...checkDependencyDenylist(repoRoot),
      ...checkRootGcpSdkDenylist(repoRoot),
      ...checkExtensionCredentials(repoRoot),
    ],
  };
}
