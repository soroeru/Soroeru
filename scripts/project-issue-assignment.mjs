/**
 * Canonical Issue assignment vocabulary shared by Project defaults and
 * multi-Issue orchestration. Body markers may use English or Japanese labels;
 * all paths resolve to the same field names.
 */

export const AI_ASSIGNEES = new Map([
  ["claude", "Claude"],
  ["codex", "Codex"],
  ["gemini", "Gemini"],
  ["grok", "Grok"],
  ["未記載", "未記載"],
]);

/** English + Japanese labels → canonical field key. */
const FIELD_ALIASES = new Map([
  ["ai assignee", "primary"],
  ["primary", "primary"],
  ["担当", "primary"],
  ["ai sub assignee", "sub"],
  ["sub", "sub"],
  ["副担当", "sub"],
  ["model", "model"],
  ["モデル", "model"],
  ["order", "order"],
  ["実装順", "order"],
  ["dependencies", "dependencies"],
  ["前提", "dependencies"],
  ["priority", "priority"],
  ["size", "size"],
  ["feature group", "featureGroup"],
]);

export function normalize(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function toAiAssignee(value) {
  return AI_ASSIGNEES.get(normalize(value).toLowerCase()) ?? "未記載";
}

/** Canonical form when known; otherwise the trimmed input (for fail-closed callers). */
export function canonicalizeAssignee(value) {
  const text = normalize(value);
  if (!text) return undefined;
  return AI_ASSIGNEES.get(text.toLowerCase()) ?? text;
}

export function isKnownAssignee(value) {
  return AI_ASSIGNEES.has(normalize(value).toLowerCase());
}

/** Assignees allowed to run workers (excludes the Project placeholder 未記載). */
export function isOrchestrationAssignee(value) {
  const canonical = canonicalizeAssignee(value);
  return Boolean(canonical) && isKnownAssignee(canonical) && canonical !== "未記載";
}

/**
 * Build a primary→sub map with canonical keys/values.
 * Unknown assignee names fail closed.
 */
export function canonicalizeSubAssigneeMap(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("ai-sub-assignee-mapping-required");
  const result = {};
  for (const [key, value] of Object.entries(raw)) {
    const primary = canonicalizeAssignee(key);
    const sub = canonicalizeAssignee(value);
    if (!primary || !isKnownAssignee(primary))
      throw new Error(`invalid-ai-sub-assignee-mapping-key:${key}`);
    if (!sub || !isKnownAssignee(sub))
      throw new Error(`invalid-ai-sub-assignee-mapping-value:${key}`);
    result[primary] = sub;
  }
  return result;
}

export function isCanonicalDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

export const OWNER_TYPES = new Set(["user", "organization"]);

/**
 * Parse `<!-- name:start -->` … `<!-- name:end -->` key/value bullet lines into
 * a plain object of canonical keys.
 */
export function parseMarkedBlock(body, markerName) {
  const text = String(body ?? "");
  const escaped = markerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const block = text.match(
    new RegExp(`<!--\\s*${escaped}:start\\s*-->([\\s\\S]*?)<!--\\s*${escaped}:end\\s*-->`, "i"),
  )?.[1];
  if (!block) return {};
  const values = {};
  for (const line of block.split(/\r?\n/)) {
    const match = line.match(/^\s*-\s*([^:]+?)\s*:\s*(.*?)\s*$/);
    if (!match) continue;
    const key = FIELD_ALIASES.get(match[1].trim().toLowerCase());
    if (key) values[key] = match[2].trim();
  }
  return values;
}

export function parseDependenciesToken(raw) {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const text = normalize(raw);
  if (/^(none|なし)$/i.test(text)) return [];
  const tokens = text.split(/[,、]/).map((value) => value.trim());
  if (!tokens.length || tokens.some((value) => !/^#?[1-9]\d*$/.test(value)))
    throw new Error("invalid-dependency-metadata");
  return tokens.map((value) => Number(value.replace(/^#/, "")));
}

/**
 * Unified assignment parse: merges project-metadata and implementation-assignment
 * blocks (implementation-assignment wins on conflict for overlapping keys).
 * Also accepts the one-line legacy `<!-- implementation-assignment: codex -->`.
 */
export function parseIssueAssignment(body, { ignoreDependencies = false } = {}) {
  const text = String(body ?? "");
  const fromProject = parseMarkedBlock(text, "project-metadata");
  const fromImpl = parseMarkedBlock(text, "implementation-assignment");
  const merged = { ...fromProject, ...fromImpl };

  // One-line legacy only: must not match multi-line <!-- …:start --> / :end markers.
  const legacy = text.match(
    /<!--\s*implementation-assignment\s*:\s*(?!(?:start|end)\b)([^>]+?)\s*-->/i,
  )?.[1];
  if (!merged.primary && legacy) merged.primary = canonicalizeAssignee(legacy);

  let dependencies;
  if (!ignoreDependencies && Object.hasOwn(merged, "dependencies"))
    dependencies = parseDependenciesToken(merged.dependencies);

  const orderRaw = merged.order;
  let order;
  if (orderRaw !== undefined && orderRaw !== "") {
    order = Number(orderRaw);
    if (!Number.isSafeInteger(order) || order <= 0) throw new Error("invalid-order-metadata");
  }

  return {
    primary: canonicalizeAssignee(merged.primary),
    sub: canonicalizeAssignee(merged.sub),
    model: merged.model ? normalize(merged.model) : undefined,
    order,
    dependencies,
    priority: merged.priority ? normalize(merged.priority) : undefined,
    size: merged.size ? normalize(merged.size) : undefined,
    featureGroup: merged.featureGroup ? normalize(merged.featureGroup) : undefined,
  };
}

/** @deprecated Prefer parseIssueAssignment; kept as a thin alias for call sites. */
export function parseImplementationAssignment(body) {
  const assignment = parseIssueAssignment(body);
  return {
    primary: assignment.primary,
    sub: assignment.sub,
    model: assignment.model,
    order: assignment.order,
    dependencies: assignment.dependencies,
  };
}

/** Project-defaults shape derived from the same parser. */
export function parseProjectMetadata(body) {
  const assignment = parseIssueAssignment(body);
  return {
    aiAssignee: assignment.primary,
    aiSubAssignee: assignment.sub,
    priority: assignment.priority,
    size: assignment.size,
    featureGroup: assignment.featureGroup,
  };
}
