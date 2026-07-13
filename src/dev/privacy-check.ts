// PRIV-002 (#21): static check that local persistence is limited to the
// encrypted storage abstraction, the encrypted export/import (SEC-003 / #44),
// and the masked measurement output (docs/security.md §3).
//
// This scans `src/**/*.ts`, `run/**/*.ts`, `electron/**/*.ts`,
// `extension/**/*.ts`, and `native-host/**/*.ts`
// (excluding `*.test.ts`) for lines that write to the local filesystem. Every
// match must carry a `// persist: <category>` annotation (on the same line or
// the line above) naming one of the allowed categories below; an unannotated
// match means a new, unreviewed local-write site was added that may bypass the
// encrypted storage abstraction.
//
// `sites/` (the local 127.0.0.1-only PoC test-site server
// and its served fixtures) is out of scope.

import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

export const SCAN_DIRS = ["src", "run", "electron", "extension", "native-host"];

/** Allowed `// persist: <category>` annotations for a flagged line. */
export const ALLOWED_PERSIST_CATEGORIES = new Set([
  "encrypted-store", // src/store/store.ts: AES-256-GCM encrypted store + recovery rekey (docs/security.md §4)
  "encrypted-export", // recovery export/import: same encrypted JSON shape as the on-disk store (§4)
  "measurement-output", // state/soroeru-poc/matrix-*.json, masked via maskForArtifact (§3)
  "diagnostics-log", // src/logging/file-logger.ts: unencrypted by design (Issue #314), structural facts only
  "native-host-registration", // native-host/: Chrome native-messaging manifest + per-launch handshake token, no personal values (§12.1)
]);

/** Patterns that indicate a line writes to the local filesystem. */
const WRITE_PATTERNS: RegExp[] = [
  /\bwriteFile(?:Sync)?\(/,
  /\bappendFile(?:Sync)?\(/,
  /\bcreateWriteStream\(/,
];

export interface PersistenceCheckResult {
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
    const category = line ? /\/\/\s*persist:\s*([a-z-]+)/.exec(line)?.[1] : undefined;
    if (category && ALLOWED_PERSIST_CATEGORIES.has(category)) return true;
  }
  return false;
}

/**
 * Run the PRIV-002 static local-persistence check against the repository at
 * `repoRoot`. `violations` is empty when every local-write site is annotated
 * with an allowed `// persist: <category>`.
 */
export function checkLocalPersistence(repoRoot: string): PersistenceCheckResult {
  const violations: string[] = [];
  let scannedFiles = 0;
  for (const dir of SCAN_DIRS) {
    for (const file of walkTsFiles(join(repoRoot, dir))) {
      scannedFiles++;
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (!WRITE_PATTERNS.some((re) => re.test(line))) return;
        if (!isAnnotated(lines, index)) {
          violations.push(
            `${relative(repoRoot, file)}:${index + 1}: local write without "// persist: ${[...ALLOWED_PERSIST_CATEGORIES].join("|")}" annotation: ${line.trim()}`,
          );
        }
      });
    }
  }
  return { scannedFiles, violations };
}
