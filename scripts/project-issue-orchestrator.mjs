#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

function requiredString(value, reason) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(reason);
  return value.trim();
}

function isCanonicalDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

export function parseProjectItems(rawItems) {
  if (!Array.isArray(rawItems)) throw new Error("items-required");
  const items = rawItems.map((raw) => {
    const number = Number(raw?.number);
    if (!Number.isSafeInteger(number) || number <= 0) throw new Error("invalid-issue-number");
    for (const field of REQUIRED_ASSIGNMENTS) requiredString(raw[field], `missing-${field}:${number}`);
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
      primary: raw.primary.trim(),
      sub: raw.sub.trim(),
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

export function validateCapabilities(requiredRoutes, capabilities) {
  if (!Array.isArray(requiredRoutes) || !Array.isArray(capabilities))
    throw new Error("capability-records-required");
  const validated = [];
  for (const route of requiredRoutes) {
    const match = capabilities.find(
      (candidate) =>
        candidate.provider === route.provider &&
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
      throw new Error(`routing-unavailable:${route.role}:${route.provider}:${route.model}`);
    validated.push(match);
  }
  return validated;
}

export function buildRunPlan(items, run = {}) {
  validateProjectItems(items);
  if (!Number.isSafeInteger(run.maxParallel) || run.maxParallel <= 0) throw new Error("invalid-max-parallel");
  if (!RELEASE_POLICIES.has(run.releasePolicy)) throw new Error("invalid-release-policy");
  if (run.runDate !== undefined && !isCanonicalDate(run.runDate)) throw new Error("invalid-run-date");
  const completed = new Set((run.completed ?? []).map(Number));
  const unavailableModels = new Set(run.unavailableModels ?? []);
  const existingWorktrees = new Set((run.existingWorktrees ?? []).map(Number));
  const byNumber = new Map(items.map((item) => [item.number, item]));
  const intrinsicBlocks = new Map();
  const nonRunnable = new Set();
  for (const item of items) {
    if (!RUNNABLE_STATUSES.has(item.status)) nonRunnable.add(item.number);
    else if (run.runDate && item.startDate > run.runDate)
      intrinsicBlocks.set(item.number, `start-date-in-future:${item.startDate}`);
    else if (unavailableModels.has(item.model))
      intrinsicBlocks.set(item.number, `model-unavailable:${item.model}`);
  }
  const isBlocked = (number, seen = new Set()) => {
    if (completed.has(number)) return false;
    if (intrinsicBlocks.has(number) || nonRunnable.has(number)) return true;
    if (seen.has(number)) return false;
    seen.add(number);
    return byNumber.get(number).dependencies.some((dependency) => isBlocked(dependency, seen));
  };
  const runnable = [];
  const blocked = [];
  const skipped = [];

  for (const item of [...items].sort(issueOrder)) {
    if (completed.has(item.number)) {
      skipped.push({ number: item.number, reason: "already-completed" });
      continue;
    }
    if (!RUNNABLE_STATUSES.has(item.status)) {
      skipped.push({ number: item.number, reason: `status-not-runnable:${item.status}` });
      continue;
    }
    const blockedDependencies = item.dependencies.filter(
      (dependency) => !completed.has(dependency) && isBlocked(dependency),
    );
    if (blockedDependencies.length) {
      blocked.push({ number: item.number, reason: `dependency-blocked:${blockedDependencies.join(",")}` });
      continue;
    }
    const waiting = item.dependencies.filter((dependency) => !completed.has(dependency));
    if (waiting.length) {
      blocked.push({ number: item.number, reason: `dependencies-incomplete:${waiting.join(",")}` });
      continue;
    }
    if (intrinsicBlocks.has(item.number)) {
      blocked.push({ number: item.number, reason: intrinsicBlocks.get(item.number) });
      continue;
    }
    runnable.push({
      ...item,
      route: existingWorktrees.has(item.number) ? "handoff-issue" : "issue-implementation",
    });
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

export function parseImplementationAssignment(body) {
  const block = String(body ?? "").match(
    /<!--\s*implementation-assignment:start\s*-->([\s\S]*?)<!--\s*implementation-assignment:end\s*-->/i,
  )?.[1];
  if (!block) return {};
  const values = {};
  for (const line of block.split(/\r?\n/)) {
    const match = line.match(
      /^\s*-\s*(Primary|Sub|Model|Order|Dependencies|担当|副担当|モデル|実装順|前提)\s*:\s*(.*?)\s*$/i,
    );
    if (match) {
      const keys = {
        担当: "primary",
        副担当: "sub",
        モデル: "model",
        実装順: "order",
        前提: "dependencies",
      };
      values[keys[match[1]] ?? match[1].toLowerCase()] = match[2].trim();
    }
  }
  let dependencies;
  if (/^(none|なし)$/i.test(values.dependencies ?? "")) dependencies = [];
  else {
    const tokens = (values.dependencies ?? "").split(/[,、]/).map((value) => value.trim());
    if (!tokens.length || tokens.some((value) => !/^#?[1-9]\d*$/.test(value)))
      throw new Error("invalid-dependency-metadata");
    dependencies = tokens.map((value) => Number(value.replace(/^#/, "")));
  }
  return {
    primary: values.primary,
    sub: values.sub,
    model: values.model,
    order: Number(values.order),
    dependencies,
  };
}

export function buildProjectItemsQuery(ownerType) {
  if (!new Set(["user", "organization"]).has(ownerType)) throw new Error("invalid-owner-type");
  return `query ProjectIssueOrchestration($owner: String!, $number: Int!, $cursor: String) { ${ownerType}(login: $owner) { projectV2(number: $number) { items(first: 100, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { fieldValues(first: 100) { nodes { ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { name } } } ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2FieldCommon { name } } } } } content { __typename ... on Issue { number title url body } } } } } } }`;
}

export function selectProjectConfig(projects, selection = {}) {
  if (!Array.isArray(projects)) throw new Error("project-config-required");
  if (selection.ownerType !== undefined && !new Set(["user", "organization"]).has(selection.ownerType))
    throw new Error("invalid-owner-type");
  const matches = projects.filter(
    (project) =>
      (selection.owner === undefined || project.owner === undefined || project.owner === selection.owner) &&
      (selection.ownerType === undefined || project.ownerType === selection.ownerType) &&
      (selection.name === undefined || project.name === selection.name) &&
      (selection.number === undefined || project.number === selection.number),
  );
  if (!matches.length) throw new Error("project-config-not-found");
  if (matches.length !== 1) throw new Error("project-config-ambiguous");
  return matches[0];
}

export async function fetchProjectItems({ owner, ownerType = "user", projectNumber, graphql }) {
  requiredString(owner, "project-owner-required");
  if (!Number.isSafeInteger(projectNumber) || projectNumber <= 0) throw new Error("invalid-project-number");
  if (typeof graphql !== "function") throw new Error("graphql-required");
  const query = buildProjectItemsQuery(ownerType);
  const nodes = [];
  let cursor = null;
  while (true) {
    const data = await graphql(query, { owner, number: projectNumber, cursor });
    const items = data?.[ownerType]?.projectV2?.items;
    if (!Array.isArray(items?.nodes)) throw new Error("project-not-found");
    nodes.push(...items.nodes);
    if (!items.pageInfo?.hasNextPage) break;
    if (!items.pageInfo.endCursor) throw new Error("project-pagination-cursor-missing");
    cursor = items.pageInfo.endCursor;
  }
  let fetchedBytes = 0;
  const mapped = nodes.flatMap((node) => {
    const body = String(node.content?.body ?? "");
    fetchedBytes += Buffer.byteLength(body, "utf8");
    if (node.content?.__typename !== "Issue") return [];
    const fields = new Map(
      (node.fieldValues?.nodes ?? []).map((value) => [value.field?.name, value.name ?? value.date]),
    );
    const assignment = parseImplementationAssignment(body);
    return [
      {
        number: node.content?.number,
        title: node.content?.title,
        url: node.content?.url,
        status: fields.get("Status"),
        startDate: fields.get("Start date"),
        primary: fields.get("AI Assignees") ?? assignment.primary,
        sub: fields.get("AI Sub Assignees") ?? assignment.sub,
        model: assignment.model,
        order: assignment.order,
        dependencies: assignment.dependencies,
      },
    ];
  });
  return { items: mapped, fetchedBytes };
}

export async function githubGraphql(query, variables, { token, fetchImpl = fetch } = {}) {
  if (!token) throw new Error("github-token-required");
  const response = await fetchImpl("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const payload = await response.json();
  if (!response.ok || payload.errors?.length) throw new Error("github-graphql-failed");
  return payload.data;
}

async function readState(statePath) {
  if (!statePath) return {};
  try {
    return JSON.parse(await fs.readFile(statePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

async function writeState(statePath, state) {
  if (!statePath) throw new Error("state-path-required");
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const temporary = `${statePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: "wx" });
  await fs.rename(temporary, statePath);
}

async function withStateLock(statePath, operation, { timeoutMs = 5_000, pollMs = 10 } = {}) {
  if (!statePath) throw new Error("state-path-required");
  const lockPath = `${statePath}.lock`;
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await fs.mkdir(lockPath);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error("state-lock-timeout");
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
  try {
    return await operation();
  } finally {
    await fs.rm(lockPath, { recursive: true, force: true });
  }
}

export async function runOrchestration(input) {
  const items = parseProjectItems(input?.items);
  const options = input?.options ?? {};
  if (!options.aiSubAssignees || typeof options.aiSubAssignees !== "object")
    throw new Error("ai-sub-assignee-mapping-required");
  for (const item of items)
    if (options.aiSubAssignees[item.primary] !== item.sub)
      throw new Error(`ai-sub-assignee-mismatch:${item.number}`);
  const parent = options.parent;
  if (!parent?.provider || !parent?.model) throw new Error("parent-route-required");
  validateCapabilities(
    [{ provider: parent.provider, model: parent.model, role: "parent" }],
    options.capabilities,
  );
  let currentState;
  let nextState;
  if (!options.dryRun && input.milestone) {
    nextState = await withStateLock(options.statePath, async () => {
      const lockedState = await readState(options.statePath);
      const updated = applyMilestone(lockedState, input.milestone, {
        issueNumbers: items.map(({ number }) => number),
        releasePolicy: options.releasePolicy,
      });
      await writeState(options.statePath, updated);
      return updated;
    });
    currentState = nextState;
  } else {
    currentState = input.state ?? (await readState(options.statePath));
    nextState = input.milestone
      ? applyMilestone(currentState, input.milestone, {
          issueNumbers: items.map(({ number }) => number),
          releasePolicy: options.releasePolicy,
        })
      : currentState;
  }
  const plan = buildRunPlan(items, {
    completed: nextState.completed,
    unavailableModels: options.unavailableModels,
    existingWorktrees: options.existingWorktrees,
    maxParallel: options.maxParallel,
    releasePolicy: options.releasePolicy,
    runDate: options.runDate,
  });
  const requiredRoutes = plan.runnable
    .map((item) => ({
      provider: item.primary,
      model: item.model,
      role: "worker",
    }))
    .filter(
      (route, index, routes) =>
        routes.findIndex(
          (candidate) =>
            candidate.provider === route.provider &&
            candidate.model === route.model &&
            candidate.role === route.role,
        ) === index,
    );
  validateCapabilities(requiredRoutes, options.capabilities);
  return {
    dryRun: Boolean(options.dryRun),
    ...(input.fetchedBytes === undefined ? {} : { fetchedBytes: input.fetchedBytes }),
    plan,
    state: nextState,
    usage: buildUsageReport(
      nextState.usage,
      items.map(({ number }) => number),
    ),
  };
}

export function parseCliArgs(argv) {
  const options = {};
  const valueFlags = new Map([
    ["--input", "inputPath"],
    ["--project-owner", "projectOwner"],
    ["--project-number", "projectNumber"],
    ["--max-parallel", "maxParallel"],
    ["--release-policy", "releasePolicy"],
    ["--owner-type", "ownerType"],
    ["--project-name", "projectName"],
    ["--unavailable-model", "unavailableModels"],
    ["--run-date", "runDate"],
    ["--state-path", "statePath"],
    ["--existing-worktree", "existingWorktrees"],
    ["--milestone-json", "milestoneJson"],
    ["--milestone-file", "milestoneFile"],
    ["--capabilities-file", "capabilitiesFile"],
    ["--parent-provider", "parentProvider"],
    ["--parent-model", "parentModel"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    const key = valueFlags.get(flag);
    if (!key) throw new Error(`unknown-flag:${flag}`);
    const value = argv[++index];
    if (value === undefined || value.startsWith("--")) throw new Error(`missing-flag-value:${flag}`);
    if (["unavailableModels", "existingWorktrees"].includes(key)) {
      options[key] ??= [];
      options[key].push(key === "existingWorktrees" ? Number(value) : value);
    } else options[key] = ["projectNumber", "maxParallel"].includes(key) ? Number(value) : value;
  }
  if (options.ownerType !== undefined && !new Set(["user", "organization"]).has(options.ownerType))
    throw new Error("invalid-owner-type");
  if (options.milestoneJson && options.milestoneFile) throw new Error("milestone-source-conflict");
  return options;
}

async function readInput(cli) {
  if (cli.inputPath) {
    const inputPath = cli.inputPath;
    if (!inputPath) throw new Error("input-path-required");
    return JSON.parse(await fs.readFile(inputPath, "utf8"));
  }
  if (cli.projectOwner || cli.projectNumber) {
    if (!cli.projectOwner || !cli.projectNumber) throw new Error("project-owner-and-number-required");
    const fetched = await fetchProjectItems({
      owner: cli.projectOwner,
      ownerType: cli.ownerType ?? "user",
      projectNumber: cli.projectNumber,
      graphql: (query, variables) =>
        githubGraphql(query, variables, {
          token: process.env.GH_PROJECT_TOKEN || process.env.GITHUB_TOKEN,
        }),
    });
    return fetched;
  }
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  if (!chunks.length) throw new Error("input-required");
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function main() {
  const cli = parseCliArgs(process.argv.slice(2));
  const input = await readInput(cli);
  if (cli.milestoneJson) input.milestone = JSON.parse(cli.milestoneJson);
  if (cli.milestoneFile) input.milestone = JSON.parse(await fs.readFile(cli.milestoneFile, "utf8"));
  const capabilities = cli.capabilitiesFile
    ? JSON.parse(await fs.readFile(cli.capabilitiesFile, "utf8"))
    : undefined;
  input.options = {
    ...(input.options ?? {}),
    ...(cli.dryRun === undefined ? {} : { dryRun: cli.dryRun }),
    ...(cli.maxParallel === undefined ? {} : { maxParallel: cli.maxParallel }),
    ...(cli.releasePolicy === undefined ? {} : { releasePolicy: cli.releasePolicy }),
    ...(cli.unavailableModels === undefined ? {} : { unavailableModels: cli.unavailableModels }),
    ...(cli.runDate === undefined ? {} : { runDate: cli.runDate }),
    ...(cli.statePath === undefined ? {} : { statePath: cli.statePath }),
    ...(cli.existingWorktrees === undefined ? {} : { existingWorktrees: cli.existingWorktrees }),
    ...(capabilities === undefined ? {} : { capabilities }),
    ...(cli.parentProvider && cli.parentModel
      ? { parent: { provider: cli.parentProvider, model: cli.parentModel } }
      : {}),
  };
  if ((cli.parentProvider && !cli.parentModel) || (!cli.parentProvider && cli.parentModel))
    throw new Error("parent-provider-and-model-required");
  if (!input.options.aiSubAssignees && cli.projectNumber) {
    const config = JSON.parse(
      await fs.readFile(new URL("../config/github-projects.json", import.meta.url), "utf8"),
    );
    const project = selectProjectConfig(config.projects, {
      owner: cli.projectOwner,
      ownerType: cli.ownerType ?? "user",
      name: cli.projectName,
      number: cli.projectNumber,
    });
    if (!project?.aiSubAssignees) throw new Error("ai-sub-assignee-mapping-required");
    input.options.aiSubAssignees = project.aiSubAssignees;
  }
  process.stdout.write(`${JSON.stringify(await runOrchestration(input))}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ status: "error", reason: error.message })}\n`);
    process.exitCode = 1;
  });
