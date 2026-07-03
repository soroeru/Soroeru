// Shared URL helpers for the exploration flow (docs/design/visibility-exploration.md §0).
// RuleEngine and PageExplorer both use these for duplicate-visit detection: the
// explorer keeps `visitedUrls` as a set of *normalized* URLs, so anything that
// compares against that set must run the candidate through the same normalization.

/**
 * Normalize a URL for duplicate-visit detection:
 * - strip the fragment (#...)
 * - drop a trailing slash on non-root paths (also before a query string)
 * Query strings are kept as-is (parameter order / encoding differences are an
 * accepted limitation). Unparseable input is returned unchanged.
 */
export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    if (parsed.pathname !== "/" && parsed.pathname.endsWith("/")) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * Whether a link points at the given site (same domain or a subdomain).
 * Relative hrefs cannot name another host, so they count as same-site.
 */
export function isSameSite(href: string, domain: string): boolean {
  try {
    const host = new URL(href).hostname.toLowerCase().replace(/^www\./, "");
    return host === domain || host.endsWith(`.${domain}`);
  } catch {
    return href.startsWith("/") || href.startsWith("./") || href.startsWith("../");
  }
}

/**
 * Resolve a possibly-relative href against the page it was found on, so the
 * explorer can navigate to it. Returns undefined when no absolute URL can be
 * formed (a relative href combined with an unparseable base). Note that hrefs
 * carrying their own scheme (e.g. `javascript:`) resolve successfully and are
 * filtered later by isSameSite, whose hostname check they fail.
 */
export function resolveHref(href: string, baseUrl: string): string | undefined {
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return undefined;
  }
}
