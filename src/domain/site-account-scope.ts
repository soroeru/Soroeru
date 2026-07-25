// Canonical Site Account scope derivation and matching (Issue #474).
// Operations in Soroeru are restricted to HTTPS origins derived from the user's
// explicit disclosure ledger (Site Account set). Non-HTTPS origins and sites
// outside the ledger are fail-closed.

import type { SiteAccount } from "./entities.js";

/**
 * Normalize a domain string (lowercase, strip leading www., trim whitespace).
 * Returns undefined if invalid or contains path/query/port/spaces.
 */
export function normalizeScopeDomain(domain: string): string | undefined {
  const trimmed = domain.trim().toLowerCase().replace(/^\.+/, "").replace(/^www\./, "");
  if (!trimmed || trimmed.includes("/") || trimmed.includes(":") || trimmed.includes(" ")) {
    return undefined;
  }
  return trimmed;
}

/**
 * Derive the HTTPS origin for a SiteAccount.
 * // egress: target-site — HTTPS origin derivation for operable disclosure ledger scope
 * Prefers valid HTTPS URL origin if site.url is provided; otherwise uses `https://${normalizedDomain}`.
 * Returns undefined for non-HTTPS or non-web accounts (e.g. android://).
 */
export function deriveSiteAccountOrigin(site: Pick<SiteAccount, "domain" | "url">): string | undefined {
  if (site.url) {
    try {
      const parsed = new URL(site.url);
      if (parsed.protocol === "https:") {
        return parsed.origin;
      }
    } catch {
      // Fallback to domain normalization
    }
  }
  const normDomain = normalizeScopeDomain(site.domain);
  if (!normDomain) return undefined;
  // egress: target-site — HTTPS origin derivation for operable disclosure ledger scope
  return `https://${normDomain}`;
}

/**
 * Derive canonical allowed HTTPS origins from a set of SiteAccounts.
 * Deduplicated and sorted alphabetically.
 */
export function deriveLedgerAllowedOrigins(sites: readonly Pick<SiteAccount, "domain" | "url">[]): string[] {
  const set = new Set<string>();
  for (const site of sites) {
    const origin = deriveSiteAccountOrigin(site);
    if (origin) {
      set.add(origin);
    }
  }
  return [...set].sort();
}

/**
 * Check if a candidate URL or origin string is within the scope of a site account domain.
 * Match criteria:
 * - Candidate must be HTTPS
 * - Hostname equals normalized site domain or is a subdomain of normalized site domain.
 */
export function isSameSiteDomainScope(candidateUrlOrOrigin: string, siteDomain: string): boolean {
  try {
    const url = new URL(candidateUrlOrOrigin);
    if (url.protocol !== "https:") return false;
    const candidateHost = url.hostname.toLowerCase().replace(/^www\./, "");
    const normalizedDomain = normalizeScopeDomain(siteDomain);
    if (!normalizedDomain) return false;
    return candidateHost === normalizedDomain || candidateHost.endsWith(`.${normalizedDomain}`);
  } catch {
    return false;
  }
}

/**
 * Check if a candidate URL or origin is in the allowed scope of the Ledger's SiteAccount collection.
 */
export function isUrlInLedgerScope(
  candidateUrlOrOrigin: string,
  ledgerSites: readonly Pick<SiteAccount, "domain" | "url">[],
): boolean {
  try {
    const url = new URL(candidateUrlOrOrigin);
    if (url.protocol !== "https:") return false;
    return ledgerSites.some((site) => isSameSiteDomainScope(candidateUrlOrOrigin, site.domain));
  } catch {
    return false;
  }
}
