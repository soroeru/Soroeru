import {
  canonicalizeAssignee,
  isCanonicalDate,
  isKnownAssignee,
  OWNER_TYPES,
} from "./project-issue-assignment.mjs";

const REQUIRED_ASSIGNMENTS = ["primary", "sub", "model"];
const RUNNABLE_STATUSES = new Set(["Ready", "Todo", "In Progress"]);
const RELEASE_POLICIES = new Set(["pr-created", "merged"]);
const MILESTONE_TYPES = new Set(["pr-created", "merged"]);
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
const HARD_BLOCK_KINDS = new Set([
  "model-unavailable",
  "start-date-in-future",
  "status-not-runnable",
  "dependency-blocked",
]);

function requiredString(value, reason) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(reason);
  return value.trim();
}

export function parseProjectItems(rawItems) {
  if (!Array.isArray(rawItems)) throw new Error("items-required");
  const items = rawItems.map((raw) => {
    const number = Number(raw?.number);
    if (!Number.isSafeInteger(number) || number <= 0) throw new Error("invalid-issue-number");
    for (const field of REQUIRED_ASSIGNMENTS) requiredString(raw[field], `missing-${field}:${number}`);
    const primary = canonicalizeAssignee(raw.primary);
    const sub = canonicalizeAssignee(raw.sub);
    if (!isKnownAssignee(primary)) throw new Error(`unknown-primary:${number}`);
    if (!isKnownAssignee(sub)) throw new Error(`unknown-sub:${number}`);
    if (!Array.isArray(raw.dependencies)) throw new Error(`missing-dependencies:${number}`);
    const dependencies = raw.dependencies.map((dependency) => Number(dependency));
    if (dependencies.some((dependency) => !Number.isSafeInteger(dependency) || dependency <= 0))
      throw new Error(`invalid-dependency:${number}`);
    if (raw.order === undefined || raw.order === null || raw.order === "")
      throw new Error(`missing-order:${number}`);
    const order = Number(raw.order);
    if (!Number.isSafeInteger(order) || order <= 0) throw new Error(`invalid-order:${number}`);
    const startDate = requiredString(raw.startDate, `missing-start-date:${number}`);
    if (!isCanonicalDate(startDate)) throw new Error(`invalid-start-date:${number}`);
    return Object.freeze({
      number,
      title: requiredString(raw.title, `missing-title:${number}`),
      url: requiredString(raw.url, `missing-url:${number}`),
      status: requiredString(raw.status, `missing-status:${number}`),
      startDate,
      primary,
      sub,
      model: raw.model.trim(),
      order,
      dependencies: Object.freeze([...new Set(dependencies)]),
    });
  });
  validateProjectItems(items);
  return Object.freeze(items);
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

function issueOrder(left, right) {
  return left.order - right.order || left.number - right.number;
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
        candidate.model === route.model &&
        candidate.role === route.role,
    );
    if (
      !match ||
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
  if (run.runDate !== undefined && !isCanonicalDate(run.runDate)) throw new Error("invalid-run-date");
  const completed = new Set((run.completed ?? []).map(Number));
  const unavailableModels = new Set(run.unavailableModels ?? []);
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

    // Dependency readiness wins over local model/start-date so a tree reports
    // dependency-blocked when an ancestor is hard-blocked (legacy behavior).
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
    if (run.runDate && item.startDate > run.runDate) {
      const ready = { kind: "start-date-in-future", detail: item.startDate };
      readinessByNumber.set(number, ready);
      return ready;
    }
    if (unavailableModels.has(item.model)) {
      const ready = { kind: "model-unavailable", detail: item.model };
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
      runnable.push({
        ...item,
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
  parseImplementationAssignment,
  parseIssueAssignment,
} from "./project-issue-assignment.mjs";
