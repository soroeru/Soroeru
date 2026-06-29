// SEC-002 (#23): static check that no dependency provides CAPTCHA-solving,
// anti-bot / browser-fingerprint-evasion, or similar bypass-oriented tooling
// (docs/security.md §7). `Soroeru` DETECTS CAPTCHA / MFA / bot-detection
// walls and hands off to the user in the same session — it must never solve,
// bypass, hide, or outsource them (RFC-001 v3 §10b).
//
// This is a dependency-denylist check, not a code-behavior check: it scans
// package.json `dependencies` / `devDependencies` for package names matching
// known CAPTCHA-solver or anti-bot/fingerprint-evasion tooling. A match means
// a new, unreviewed bypass-oriented dependency was added and must be reviewed
// against docs/security.md §7 before it is accepted.

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Dependency-name substrings that indicate CAPTCHA-solving or anti-bot/fingerprint-evasion tooling. */
const BYPASS_DENYLIST = [
  "2captcha",
  "anticaptcha",
  "anti-captcha",
  "capsolver",
  "capmonster",
  "deathbycaptcha",
  "azcaptcha",
  "captcha-solver",
  "captchasolver",
  "nopecha",
  "buster-captcha",
  "stealth",
  "rebrowser",
  "undetected-chromedriver",
  "fingerprint-injector",
  "fingerprint-suite",
  "header-generator",
];

export interface BypassCheckResult {
  violations: string[];
}

/**
 * Run the SEC-002 dependency-denylist check against the repository at
 * `repoRoot`. `violations` is empty when no `dependencies` /
 * `devDependencies` entry in `package.json` matches a known CAPTCHA-solving
 * or anti-bot/fingerprint-evasion package name.
 */
export function checkBypassDenylist(repoRoot: string): BypassCheckResult {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const names = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
  const violations: string[] = [];
  for (const name of names) {
    const lower = name.toLowerCase();
    const hit = BYPASS_DENYLIST.find((bad) => lower.includes(bad));
    if (hit) {
      violations.push(
        `package.json: dependency "${name}" matches CAPTCHA-solving / bot-detection-evasion denylist entry "${hit}" (docs/security.md §7)`,
      );
    }
  }
  return { violations };
}
