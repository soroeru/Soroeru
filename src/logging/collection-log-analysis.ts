// Collection-run failure analysis over the plain-text diagnostics log
// (Issue #317). Parses the newline-delimited JSON the FileLogger writes and
// reduces the `visibility` entries to one terminal outcome per site, then
// ranks failure causes by count so the Product Owner can see which problem to
// fix first. Pure functions, no I/O — the CLI in run/analyze-collection-log.ts
// does the reading/printing.
//
// The log carries structural facts only (domains, status/reason codes); this
// module never sees raw personal values.

/** One parsed diagnostics-log line (the FileLogger envelope plus known fields). */
export interface CollectionLogEntry {
  at?: string;
  level?: string;
  category?: string;
  message?: string;
  domain?: string;
  siteAccountId?: string;
  reason?: string;
  wall?: string;
  scheme?: string;
  error?: string;
}

/** The terminal outcome derived for one site from its last terminal log line. */
export interface SiteOutcome {
  /** Site key: the domain when logged, else the siteAccountId. */
  site: string;
  /** Stable cause bucket, e.g. "collected", "unreachable:dns-not-found", "wall:captcha". */
  category: string;
  /** Free-form detail for `failed:*` buckets (normalized error text). */
  detail?: string;
}

/** One ranked cause bucket. */
export interface RankedCause {
  category: string;
  count: number;
  /** Share of all analyzed sites (0..1). */
  share: number;
  sites: string[];
}

/** Tolerant JSONL parse: skips lines that are not valid JSON objects. */
export function parseLogEntries(text: string): CollectionLogEntry[] {
  const entries: CollectionLogEntry[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        entries.push(parsed as CollectionLogEntry);
      }
    } catch {
      // Not JSON (truncated write, stray output) — skip, never fail the analysis.
    }
  }
  return entries;
}

/**
 * Reduce the visibility entries to one terminal outcome per site. A site
 * retried within the same log keeps only its last terminal entry. A wall
 * pause is attributed to the most recent "wall detected" kind logged for the
 * same site before the pause (unknown when the log predates that log line).
 */
export function siteOutcomes(entries: CollectionLogEntry[]): SiteOutcome[] {
  const lastWallKind = new Map<string, string>();
  const outcomes = new Map<string, SiteOutcome>();

  for (const entry of entries) {
    if (entry.category !== "visibility") continue;
    const site = entry.domain ?? entry.siteAccountId;
    if (site === undefined || entry.message === undefined) continue;

    if (entry.message === "wall detected") {
      lastWallKind.set(site, entry.wall ?? "unknown");
      continue;
    }

    const outcome = terminalOutcome(entry, site, lastWallKind.get(site));
    if (outcome) outcomes.set(site, outcome);
  }
  return [...outcomes.values()];
}

/** Categories that are not collection failures (excluded from the failure ranking). */
const NON_FAILURE_CATEGORIES = new Set(["collected", "canceled"]);

/**
 * Rank failure causes by count, largest first. `collected` / `canceled`
 * outcomes are excluded — the caller reports them as totals, not causes.
 */
export function rankFailureCauses(outcomes: SiteOutcome[]): RankedCause[] {
  const buckets = new Map<string, string[]>();
  for (const outcome of outcomes) {
    if (NON_FAILURE_CATEGORIES.has(outcome.category)) continue;
    const sites = buckets.get(outcome.category) ?? [];
    sites.push(outcome.site);
    buckets.set(outcome.category, sites);
  }
  const total = outcomes.length;
  return [...buckets.entries()]
    .map(([category, sites]) => ({
      category,
      count: sites.length,
      share: total === 0 ? 0 : sites.length / total,
      sites: [...sites].sort(),
    }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
}

function terminalOutcome(
  entry: CollectionLogEntry,
  site: string,
  wallKind: string | undefined,
): SiteOutcome | undefined {
  switch (entry.message) {
    case "collection completed":
      return { site, category: "collected" };
    case "run canceled":
      // Skipping a wall in the UI aborts the current site, so a wall-skip
      // surfaces as "run canceled" preceded by "wall detected" for the same
      // site. Attribute those to the wall; a cancel with no preceding wall is
      // a genuine user/batch abort.
      return wallKind !== undefined
        ? { site, category: `wall:${wallKind}` }
        : { site, category: "canceled" };
    case "site unreachable":
      return { site, category: `unreachable:${entry.reason ?? "unknown"}` };
    case "login failed: still on a login page after submitting credentials":
      return { site, category: "login-incomplete" };
    case "no collectable data found":
      return { site, category: "no-data" };
    case "skipped non-web credential":
      return { site, category: "non-web-credential" };
    case "run paused for wall hand-off":
      return { site, category: `wall:${wallKind ?? "unknown"}` };
    case "run failed": {
      const detail = normalizeErrorText(entry.error);
      return { site, category: `failed:${detail}`, detail };
    }
    default:
      return undefined;
  }
}

/**
 * Collapse an error message into a stable bucket name: known Playwright /
 * Chromium failure shapes get a short code; anything else keeps a truncated,
 * URL-stripped prefix so unrelated errors do not merge into one bucket.
 */
export function normalizeErrorText(error: string | undefined): string {
  if (error === undefined || error.trim() === "") return "unknown";
  if (/Timeout \d+m?s exceeded/i.test(error)) return "operation-timeout";
  if (/Target (page, context or browser|closed)/i.test(error)) return "browser-closed";
  if (/net::ERR_ABORTED/i.test(error)) return "navigation-aborted";
  if (/Execution context was destroyed/i.test(error)) return "context-destroyed";
  if (/frame was detached/i.test(error)) return "frame-detached";
  const stripped = error
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length > 60 ? `${stripped.slice(0, 60)}…` : stripped;
}
