import { canonicalizeAgent, isCanonicalDate, OWNER_TYPES } from "./project-issue-assignment.mjs";
import { determineEligibleModes } from "./project-issue-modes.mjs";

const RUNNABLE_STATUSES = new Set(["Ready", "Todo", "In Progress"]);
const RELEASE_POLICIES = new Set(["pr-created", "merged"]);
const MILESTONE_TYPES = new Set(["pr-created", "merged"]);
const PRIORITY_ORDER = ["P0", "P1", "P2", "P3"];
const USAGE_FIELDS = [
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "toolCalls",
  "waitCalls",
  "wallClockMs",
  "fetchedBytes",
];

/** Hard readiness kinds that block dependents via dependency-blocked. */
const HARD_BLOCK_KINDS = new Set(["status-not-runnable", "dependency-blocked"]);

function requiredString(value, reason) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(reason);
  return value.trim();
}

function optionalString(value) {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text === "" ? undefined : text;
}

/**
 * Items carry no agent/model assignment: routing is decided at run time from
 * capability records, so only identity, status, ordering metadata, and the
 * GitHub-derived dependency closure are validated here.
 */
export function parseProjectItems(rawItems) {
  if (!Array.isArray(rawItems)) throw new Error("items-required");
  const items = rawItems.map((raw) => {
    const number = Number(raw?.number);
    if (!Number.isSafeInteger(number) || number <= 0) throw new Error("invalid-issue-number");
    if (!Array.isArray(raw.dependencies)) throw new Error(`missing-dependencies:${number}`);
    const dependencies = raw.dependencies.map((dependency) => Number(dependency));
    if (dependencies.some((dependency) => !Number.isSafeInteger(dependency) || dependency <= 0))
      throw new Error(`invalid-dependency:${number}`);
    const startDate = optionalString(raw.startDate);
    if (startDate !== undefined && !isCanonicalDate(startDate))
      throw new Error(`invalid-start-date:${number}`);
    return Object.freeze({
      number,
      title: requiredString(raw.title, `missing-title:${number}`),
      url: requiredString(raw.url, `missing-url:${number}`),
      status: requiredString(raw.status, `missing-status:${number}`),
      priority: optionalString(raw.priority),
      size: optionalString(raw.size),
      iteration: optionalString(raw.iteration),
      ...(startDate === undefined ? {} : { startDate }),
      dependencies: Object.freeze([...new Set(dependencies)]),
    });
  });
  validateProjectItems(items);
  return Object.freeze(items);
}

function selectorValues(value) {
  return Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : [];
}

/** Select matching items and recursively include their dependency closure. */
export function selectProjectItems(rawItems, selectors = {}) {
  const issues = selectorValues(selectors.issues).map(Number);
  const priorities = selectorValues(selectors.priority);
  const iterations = selectorValues(selectors.iteration);
  const sizes = selectorValues(selectors.size);
  if (!issues.length && !priorities.length && !iterations.length && !sizes.length)
    throw new Error("issue-filter-required");
  if (issues.some((issue) => !Number.isSafeInteger(issue) || issue <= 0))
    throw new Error("invalid-issue-filter");

  const dimensions = [
    [issues, (item) => issues.includes(Number(item.number))],
    [priorities, (item) => priorities.includes(item.priority)],
    [iterations, (item) => iterations.includes(item.iteration)],
    [sizes, (item) => sizes.includes(item.size)],
  ].filter(([values]) => values.length);
  const matches = rawItems.filter((item) => dimensions.every(([, predicate]) => predicate(item)));
  if (!matches.length) throw new Error("no-issues-match-filter");

  const byNumber = new Map(rawItems.map((item) => [Number(item.number), item]));
  const selected = new Map();
  const completed = new Set();
  const visit = (item) => {
    const number = Number(item.number);
    if (selected.has(number)) return;
    if (!Array.isArray(item.dependencies)) throw new Error(`missing-dependencies:${number}`);
    selected.set(number, item);
    for (const dependency of item.dependencies) {
      const relation = (item.blockedBy ?? []).find(
        ({ number: blockedNumber }) => Number(blockedNumber) === Number(dependency),
      );
      if (relation?.state === "CLOSED") {
        completed.add(Number(dependency));
        continue;
      }
      if (relation?.state === "OPEN") throw new Error(`dependency-open:${number}:${dependency}`);
      if (relation && relation.state !== "CLOSED" && relation.state !== "OPEN")
        throw new Error(`dependency-state-unavailable:${number}:${dependency}`);
      const dependencyItem = byNumber.get(Number(dependency));
      if (!dependencyItem) throw new Error(`unknown-dependency:${number}:${dependency}`);
      visit(dependencyItem);
    }
  };
  for (const match of matches) visit(match);
  return {
    items: [...selected.values()].sort((left, right) => Number(left.number) - Number(right.number)),
    completed: [...completed].sort((left, right) => left - right),
  };
}

export function validateProjectItems(items) {
  const byNumber = new Map();
  for (const item of items) {
    if (byNumber.has(item.number)) throw new Error(`duplicate-issue:${item.number}`);
    byNumber.set(item.number, item);
  }
  for (const item of items)
    for (const dependency of item.dependencies)
      if (!byNumber.has(dependency)) throw new Error(`unknown-dependency:${item.number}:${dependency}`);

  const visiting = new Set();
  const visited = new Set();
  const visit = (number) => {
    if (visiting.has(number)) throw new Error(`dependency-cycle:${number}`);
    if (visited.has(number)) return;
    visiting.add(number);
    for (const dependency of byNumber.get(number).dependencies) visit(dependency);
    visiting.delete(number);
    visited.add(number);
  };
  for (const number of byNumber.keys()) visit(number);
  return items;
}

function priorityRank(priority) {
  const rank = PRIORITY_ORDER.indexOf(priority);
  return rank === -1 ? PRIORITY_ORDER.length : rank;
}

/** Deterministic execution order: Priority (P0 first), then Issue number. */
function issueOrder(left, right) {
  return priorityRank(left.priority) - priorityRank(right.priority) || left.number - right.number;
}

/**
 * Capability records identify an agent runtime (Codex/Claude/…) plus model.
 * Field name is `agent`, not API-provider branding.
 */
export function validateCapabilities(requiredRoutes, capabilities) {
  if (!Array.isArray(requiredRoutes) || !Array.isArray(capabilities))
    throw new Error("capability-records-required");
  const validated = [];
  for (const route of requiredRoutes) {
    const match = capabilities.find(
      (candidate) =>
        candidate.agent === route.agent &&
        // `requestedModel` preserves the requested display name while
        // `model` remains the runtime's canonical model identifier. Keep
        // accepting the legacy shape where `model` is the requested name,
        // but never let a canonical ID override a supplied display label.
        (candidate.requestedModel !== undefined
          ? candidate.requestedModel === route.model
          : candidate.model === route.model) &&
        candidate.role === route.role,
    );
    if (
      !match ||
      (match.requestedModel !== undefined &&
        (typeof match.requestedModel !== "string" || match.requestedModel.trim() === "")) ||
      typeof match.model !== "string" ||
      match.model.trim() === "" ||
      !match.selectable ||
      !match.verifiable ||
      typeof match.selector !== "string" ||
      !Number.isSafeInteger(match.timeoutMs) ||
      match.timeoutMs <= 0
    )
      throw new Error(`routing-unavailable:${route.role}:${route.agent}:${route.model}`);
    validated.push(match);
  }
  return validated;
}

/**
 * Run-time worker route pool: every role=worker capability record that is
 * well-formed, selectable, verifiable, and not excluded by the run-scoped
 * unavailable agent/model lists. The orchestrating agent assigns each
 * runnable Issue to one of these routes; the pool never invents a route.
 */
export function selectWorkerRoutes(capabilities, { unavailableAgents = [], unavailableModels = [] } = {}) {
  if (!Array.isArray(capabilities)) throw new Error("capability-records-required");
  const excludedAgents = new Set(
    unavailableAgents
      .map((agent) => (canonicalizeAgent(agent) ?? "").toLowerCase())
      .filter(Boolean),
  );
  const excludedModels = new Set(unavailableModels);
  const routes = [];
  for (const record of capabilities) {
    if (record?.role !== "worker") continue;
    if (
      typeof record.agent !== "string" ||
      record.agent.trim() === "" ||
      record.agent !== record.agent.trim() ||
      (record.requestedModel !== undefined &&
        (typeof record.requestedModel !== "string" ||
          record.requestedModel.trim() === "" ||
          record.requestedModel !== record.requestedModel.trim())) ||
      typeof record.model !== "string" ||
      record.model.trim() === "" ||
      record.model !== record.model.trim() ||
      typeof record.selector !== "string" ||
      record.selector.trim() === "" ||
      typeof record.selectable !== "boolean" ||
      typeof record.verifiable !== "boolean" ||
      !Number.isSafeInteger(record.timeoutMs) ||
      record.timeoutMs <= 0
    )
      throw new Error(`invalid-capability-record:${record?.agent ?? "unknown"}`);
    if (record.selectable !== true || record.verifiable !== true) continue;
    if (excludedAgents.has(canonicalizeAgent(record.agent).toLowerCase())) continue;
    if (excludedModels.has(record.model) || excludedModels.has(record.requestedModel)) continue;
    routes.push(record);
  }
  return routes;
}

function reasonFromReadiness(readiness) {
  if (readiness.detail !== undefined) return `${readiness.kind}:${readiness.detail}`;
  return readiness.kind;
}

/**
 * Single readiness classification per Issue (topo-friendly memoization), then
 * emit runnable / blocked / skipped. Parallel cap is applied last.
 */
export function buildRunPlan(items, run = {}) {
  validateProjectItems(items);
  if (!Number.isSafeInteger(run.maxParallel) || run.maxParallel <= 0) throw new Error("invalid-max-parallel");
  if (!RELEASE_POLICIES.has(run.releasePolicy)) throw new Error("invalid-release-policy");
  const completed = new Set((run.completed ?? []).map(Number));
  const existingWorktrees = new Set((run.existingWorktrees ?? []).map(Number));
  const byNumber = new Map(items.map((item) => [item.number, item]));
  const readinessByNumber = new Map();

  const computeReadiness = (number) => {
    if (readinessByNumber.has(number)) return readinessByNumber.get(number);
    if (completed.has(number)) {
      const ready = { kind: "already-completed" };
      readinessByNumber.set(number, ready);
      return ready;
    }
    const item = byNumber.get(number);
    if (!RUNNABLE_STATUSES.has(item.status)) {
      const ready = { kind: "status-not-runnable", detail: item.status };
      readinessByNumber.set(number, ready);
      return ready;
    }

    // Dependency readiness wins over local readiness so a tree reports
    // dependency-blocked when an ancestor is hard-blocked.
    const incomplete = item.dependencies.filter((dependency) => !completed.has(dependency));
    const hardDeps = [];
    for (const dependency of incomplete) {
      const child = computeReadiness(dependency);
      if (HARD_BLOCK_KINDS.has(child.kind)) hardDeps.push(dependency);
    }
    if (hardDeps.length) {
      const ready = { kind: "dependency-blocked", detail: hardDeps.join(",") };
      readinessByNumber.set(number, ready);
      return ready;
    }
    if (incomplete.length) {
      const ready = { kind: "dependencies-incomplete", detail: incomplete.join(",") };
      readinessByNumber.set(number, ready);
      return ready;
    }
    const ready = { kind: "runnable" };
    readinessByNumber.set(number, ready);
    return ready;
  };

  const runnable = [];
  const blocked = [];
  const skipped = [];

  for (const item of [...items].sort(issueOrder)) {
    const readiness = computeReadiness(item.number);
    if (readiness.kind === "already-completed") {
      skipped.push({ number: item.number, reason: "already-completed" });
      continue;
    }
    if (readiness.kind === "status-not-runnable") {
      skipped.push({ number: item.number, reason: reasonFromReadiness(readiness) });
      continue;
    }
    if (readiness.kind === "runnable") {
      const eligibleModes = determineEligibleModes({
        riskCategory: item.riskCategory ?? "low",
        size: item.size ?? "M",
        dependencyDepth: item.dependencies ? item.dependencies.length : 0,
      });
      runnable.push({
        ...item,
        eligibleModes,
        mode: eligibleModes[0],
        route: existingWorktrees.has(item.number) ? "handoff-issue" : "issue-implementation",
      });
      continue;
    }
    blocked.push({ number: item.number, reason: reasonFromReadiness(readiness) });
  }

  for (const item of runnable.splice(run.maxParallel))
    blocked.push({ number: item.number, reason: `parallel-limit:${run.maxParallel}` });

  return { runnable, blocked, skipped };
}

export function applyMilestone(currentState = {}, event, context = {}) {
  if (!RELEASE_POLICIES.has(context.releasePolicy)) throw new Error("invalid-release-policy");
  const issue = Number(event?.issue);
  if (!Number.isSafeInteger(issue) || issue <= 0) throw new Error("invalid-milestone-issue");
  const type = requiredString(event.type, "missing-milestone-type");
  if (!new Set(context.issueNumbers ?? []).has(issue)) throw new Error(`unknown-milestone-issue:${issue}`);
  if (!MILESTONE_TYPES.has(type)) throw new Error(`invalid-milestone-type:${type}`);
  const completed = new Set((currentState.completed ?? []).map(Number));
  if (type === context.releasePolicy) completed.add(issue);
  const milestones = [...(currentState.milestones ?? []), { issue, type }];
  const usage = { ...(currentState.usage ?? {}) };
  if (event.usage !== undefined) usage[String(issue)] = normalizeUsage(event.usage);
  return { completed: [...completed].sort((a, b) => a - b), milestones, usage };
}

function normalizeUsage(value) {
  const normalized = {};
  for (const field of USAGE_FIELDS) {
    const number = Number(value?.[field]);
    if (!Number.isSafeInteger(number) || number < 0) throw new Error(`invalid-usage:${field}`);
    normalized[field] = number;
  }
  return normalized;
}

export function buildUsageReport(usage = {}, issueNumbers = []) {
  const totalUsage = Object.fromEntries(USAGE_FIELDS.map((field) => [field, 0]));
  const availableIssues = [];
  const unavailableIssues = [];
  const issues = issueNumbers.map((number) => {
    const raw = usage[String(number)];
    if (raw === undefined) {
      unavailableIssues.push(number);
      return { number, usage: "unavailable" };
    }
    const exact = normalizeUsage(raw);
    for (const field of USAGE_FIELDS) totalUsage[field] += exact[field];
    availableIssues.push(number);
    return { number, usage: exact };
  });
  let total = "unavailable";
  if (availableIssues.length)
    total = {
      status: unavailableIssues.length ? "partial" : "complete",
      availableIssues,
      unavailableIssues,
      usage: totalUsage,
    };
  return { issues, total };
}

export function selectProjectConfig(projects, selection = {}) {
  if (!Array.isArray(projects)) throw new Error("project-config-required");
  if (selection.ownerType !== undefined && !OWNER_TYPES.has(selection.ownerType))
    throw new Error("invalid-owner-type");
  const matches = projects.filter(
    (project) =>
      (selection.owner === undefined || project.owner === selection.owner) &&
      (selection.ownerType === undefined || project.ownerType === selection.ownerType) &&
      (selection.name === undefined || project.name === selection.name) &&
      (selection.number === undefined || project.number === selection.number),
  );
  if (!matches.length) throw new Error("project-config-not-found");
  if (matches.length !== 1) throw new Error("project-config-ambiguous");
  return matches[0];
}

export {
  isCanonicalDate,
  normalize,
  OWNER_TYPES,
  parseProjectMetadata,
} from "./project-issue-assignment.mjs";
