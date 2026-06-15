// Shared site/form/field/wall/withdrawal definition matching, field-rule
// application, and local-candidate validation (#80, RFC-001 v3 §8,
// extension.md §3.2). Definitions (official and local-candidate) share one
// schema (src/types.ts); this module is the matching/validation logic used by
// both deterministic mode and AI mode.

import {
  KNOWN_PROFILE_KEYS,
  type DefinitionFieldRule,
  type FormField,
  type LocalCandidateDefinition,
  type MappingEntry,
  type PageSnapshot,
  type ProfileKey,
  type SiteDefinition,
} from "../types.js";

function safeRegex(pattern: string): RegExp | undefined {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return undefined;
  }
}

function hostnameMatches(hostname: string, domains: string[]): boolean {
  const host = hostname.toLowerCase();
  return domains.some((d) => {
    const domain = d.toLowerCase().replace(/^\*\./, "");
    return host === domain || host.endsWith(`.${domain}`);
  });
}

export interface DefinitionMatch<T extends SiteDefinition = SiteDefinition> {
  definition: T;
  score: number;
  /** Human-readable match reasons, for diagnostics/tests; never includes profile values. */
  reasons: string[];
}

/**
 * Score how well `definition` matches the current page (extension.md §3.2
 * step 2: domain, URL pattern, form signature, headings/buttons, wall
 * signals). Returns `undefined` if neither `match.domains` nor
 * `match.urlPatterns` matches — a definition must positively identify the
 * site before its other signals contribute to the score.
 */
export function matchDefinition<T extends SiteDefinition>(snapshot: PageSnapshot, definition: T): DefinitionMatch<T> | undefined {
  const reasons: string[] = [];
  let score = 0;
  const url = new URL(snapshot.url);

  const domainHit = !!definition.match.domains?.length && hostnameMatches(url.hostname, definition.match.domains);
  if (domainHit) {
    score += 10;
    reasons.push("domain");
  }
  const urlPatternHit = !!definition.match.urlPatterns?.some((p) => safeRegex(p)?.test(snapshot.url));
  if (urlPatternHit) {
    score += 8;
    reasons.push("url-pattern");
  }
  if (!domainHit && !urlPatternHit) return undefined;

  const sig = definition.registrationSignature;
  if (sig?.pathPatterns?.some((p) => safeRegex(p)?.test(url.pathname))) {
    score += 5;
    reasons.push("path-pattern");
  }
  if (sig?.fieldTokens?.length) {
    const haystacks = snapshot.fields.map((f) => `${f.name} ${f.id} ${f.autocomplete}`.toLowerCase());
    const hits = sig.fieldTokens.filter((t) => haystacks.some((h) => h.includes(t.toLowerCase())));
    if (hits.length) {
      score += hits.length;
      reasons.push(`field-tokens:${hits.length}`);
    }
  }
  if (sig?.headingPatterns?.some((p) => safeRegex(p)?.test(snapshot.visibleText))) {
    score += 2;
    reasons.push("heading");
  }
  if (sig?.buttonPatterns?.length) {
    const hits = sig.buttonPatterns.filter((p) => snapshot.buttons.some((b) => safeRegex(p)?.test(b.text)));
    if (hits.length) {
      score += hits.length * 2;
      reasons.push(`buttons:${hits.length}`);
    }
  }
  if (definition.wallSignals?.length) {
    const hits = definition.wallSignals.filter(
      (w) => safeRegex(w.pattern)?.test(snapshot.visibleText) || snapshot.wallMarkers.some((m) => safeRegex(w.pattern)?.test(m)),
    );
    if (hits.length) {
      score += hits.length;
      reasons.push(`wall-signals:${hits.length}`);
    }
  }
  return { definition, score, reasons };
}

/** Match and score every definition against the current page, best first. Non-matches (no domain/URL hit) are omitted. */
export function matchDefinitions<T extends SiteDefinition>(snapshot: PageSnapshot, definitions: readonly T[]): DefinitionMatch<T>[] {
  return definitions
    .map((d) => matchDefinition(snapshot, d))
    .filter((m): m is DefinitionMatch<T> => m !== undefined)
    .sort((a, b) => b.score - a.score);
}

/**
 * Resolve the best definitions for the current page from checked-in official
 * definitions and this vault's local candidates (extension.md §3.2 steps
 * 1-4), best first. Candidates marked `rejected` are excluded.
 */
export function resolveDefinitions(
  snapshot: PageSnapshot,
  official: readonly SiteDefinition[],
  candidates: readonly LocalCandidateDefinition[],
): DefinitionMatch[] {
  return matchDefinitions(snapshot, [...official, ...candidates.filter((c) => c.status !== "rejected")]);
}

function labelText(field: FormField): string {
  return [...field.labels, field.placeholder, field.nearbyText].filter(Boolean).join(" ");
}

function attrText(field: FormField): string {
  return `${field.name} ${field.id}`;
}

/**
 * Apply a definition's field rules to the page's fields (first matching rule
 * wins, same convention as the deterministic classifier's `RULES`). Returns
 * mapping entries for fields with a hit; fields with no hit are left for the
 * deterministic/AI mapper to classify.
 */
export function applyFieldRules(fields: FormField[], rules: DefinitionFieldRule[]): MappingEntry[] {
  const entries: MappingEntry[] = [];
  for (const field of fields) {
    const label = labelText(field);
    const attr = attrText(field);
    for (const rule of rules) {
      const labelHit = rule.labelPattern ? (safeRegex(rule.labelPattern)?.test(label) ?? false) : false;
      const attrHit = !labelHit && rule.attrPattern ? (safeRegex(rule.attrPattern)?.test(attr) ?? false) : false;
      if (labelHit || attrHit) {
        const entry: MappingEntry = { fieldId: field.fieldId, profileKey: rule.profileKey };
        if (rule.transform) entry.transform = rule.transform;
        entries.push(entry);
        break;
      }
    }
  }
  return entries;
}

export interface CandidateValidationResult {
  ok: boolean;
  errors: string[];
}

const KNOWN_PROFILE_KEY_SET = new Set<string>(KNOWN_PROFILE_KEYS);

function isValidProfileKey(key: ProfileKey): boolean {
  return KNOWN_PROFILE_KEY_SET.has(key) || key.startsWith("custom.");
}

/**
 * Patterns that suggest a definition embeds a raw personal value rather than
 * structure (security.md §9: candidates must not contain raw profile values).
 * This is a heuristic defense-in-depth check, not a guarantee.
 */
const RAW_VALUE_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "email address", re: /[\w.+-]+@[\w-]+\.[\w.-]+/ },
  { name: "card-number-like digit sequence", re: /\d[\d -]{10,18}\d/ },
  { name: "phone-number-like value", re: /0\d{1,4}-\d{1,4}-\d{3,4}/ },
];

/** Every free-text/pattern string embedded in a definition, for the privacy scan. */
function collectStrings(definition: LocalCandidateDefinition): string[] {
  const strings: string[] = [...(definition.match.domains ?? []), ...(definition.match.urlPatterns ?? [])];
  const sig = definition.registrationSignature;
  if (sig) {
    strings.push(...(sig.pathPatterns ?? []), ...(sig.fieldTokens ?? []), ...(sig.headingPatterns ?? []), ...(sig.buttonPatterns ?? []));
  }
  for (const rule of definition.fieldRules ?? []) {
    if (rule.labelPattern) strings.push(rule.labelPattern);
    if (rule.attrPattern) strings.push(rule.attrPattern);
  }
  for (const wall of definition.wallSignals ?? []) strings.push(wall.pattern);
  for (const step of definition.withdrawalSteps ?? []) {
    strings.push(step.description);
    if (step.linkPattern) strings.push(step.linkPattern);
  }
  if (definition.notes) strings.push(definition.notes);
  return strings;
}

/** Regex-source fields only (subset of `collectStrings`), checked for compile errors. */
function collectPatterns(definition: LocalCandidateDefinition): string[] {
  return [
    ...(definition.match.urlPatterns ?? []),
    ...(definition.registrationSignature?.pathPatterns ?? []),
    ...(definition.registrationSignature?.headingPatterns ?? []),
    ...(definition.registrationSignature?.buttonPatterns ?? []),
    ...(definition.fieldRules ?? []).flatMap((r) => [r.labelPattern, r.attrPattern].filter((p): p is string => !!p)),
    ...(definition.wallSignals ?? []).map((w) => w.pattern),
    ...(definition.withdrawalSteps ?? []).map((s) => s.linkPattern).filter((p): p is string => !!p),
  ];
}

/**
 * Validate a local candidate definition before it is stored / reused (#80).
 * Checks structural well-formedness (a site-identity rule is present, regex
 * patterns compile, profile keys are known/custom) and a privacy check for
 * embedded raw personal values (security.md §9). Does not mutate `definition`.
 */
export function validateCandidateDefinition(definition: LocalCandidateDefinition): CandidateValidationResult {
  const errors: string[] = [];
  if (!definition.id) errors.push("id is required");
  if (!definition.serviceName) errors.push("serviceName is required");
  if (!definition.match.domains?.length && !definition.match.urlPatterns?.length) {
    errors.push("match.domains or match.urlPatterns is required");
  }

  for (const pattern of collectPatterns(definition)) {
    if (!safeRegex(pattern)) errors.push(`invalid regular expression: ${pattern}`);
  }

  for (const rule of definition.fieldRules ?? []) {
    if (!rule.id) errors.push("fieldRules entry is missing id");
    if (!isValidProfileKey(rule.profileKey)) errors.push(`unknown profile key: ${rule.profileKey}`);
  }

  for (const text of collectStrings(definition)) {
    for (const { name, re } of RAW_VALUE_PATTERNS) {
      if (re.test(text)) errors.push(`possible raw personal value (${name}) found in definition`);
    }
  }

  return { ok: errors.length === 0, errors };
}
