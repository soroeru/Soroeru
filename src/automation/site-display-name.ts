import type { PageSnapshot } from "../types.js";

const TITLE_DELIMITER = /\s*(?:[｜|—–:·]|\s-\s)\s*/u;

export function siteDisplayNameCandidate(snapshot: PageSnapshot, domain: string): string | undefined {
  const metadataName = snapshot.siteName?.trim();
  const candidate = metadataName || snapshot.title.split(TITLE_DELIMITER, 1)[0]?.trim();
  if (!candidate || candidate.toLocaleLowerCase() === domain.trim().toLocaleLowerCase()) return undefined;
  return candidate;
}
