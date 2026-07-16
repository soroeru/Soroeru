#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalizeSubAssigneeMap, OWNER_TYPES } from "./project-issue-assignment.mjs";
import {
  DEFAULT_CONFIG_PATH,
  loadOrchestratorConfig,
  mergeOrchestratorConfig,
} from "./project-issue-config.mjs";
import { fetchProjectItems, githubGraphql } from "./project-issue-github.mjs";
import {
  applyMilestone,
  buildRunPlan,
  buildUsageReport,
  parseProjectItems,
  selectProjectConfig,
  selectProjectItems,
  validateCapabilities,
} from "./project-issue-plan.mjs";
import { readState, withStateLock, writeState } from "./project-issue-state.mjs";

// Re-export pure surface for tests and programmatic callers.
export {
  applyMilestone,
  buildRunPlan,
  buildUsageReport,
  parseImplementationAssignment,
  parseIssueAssignment,
  parseProjectItems,
  selectProjectItems,
  selectProjectConfig,
  validateCapabilities,
  validateProjectItems,
} from "./project-issue-plan.mjs";
export { buildProjectItemsQuery, fetchProjectItems, githubGraphql } from "./project-issue-github.mjs";

/**
 * Dry-run never mutates disk state and never applies milestones to the plan.
 * Pass `options.simulateMilestone: true` to apply a milestone in memory only
 * (still no disk write) for "what if this event landed" plans.
 */
export async function runOrchestration(input) {
  const items = parseProjectItems(input?.items);
  const options = input?.options ?? {};
  const aiSubAssignees = canonicalizeSubAssigneeMap(options.aiSubAssignees);
  for (const item of items) {
    const expectedSub = aiSubAssignees[item.primary];
    if (expectedSub === undefined)
      throw new Error(`missing-ai-sub-assignee-mapping:${item.number}`);
    if (expectedSub !== item.sub) throw new Error(`ai-sub-assignee-mismatch:${item.number}`);
  }
  const parent = options.parent;
  if (!parent?.agent || !parent?.model) throw new Error("parent-route-required");
  validateCapabilities(
    [{ agent: parent.agent, model: parent.model, role: "parent" }],
    options.capabilities,
  );

  const dryRun = Boolean(options.dryRun);
  const applyInMemory = Boolean(input.milestone) && (!dryRun || options.simulateMilestone);
  let nextState;

  if (!dryRun && input.milestone) {
    if (!options.statePath) throw new Error("state-path-required");
    nextState = await withStateLock(options.statePath, async () => {
      const lockedState = await readState(options.statePath);
      const updated = applyMilestone(lockedState, input.milestone, {
        issueNumbers: items.map(({ number }) => number),
        releasePolicy: options.releasePolicy,
      });
      await writeState(options.statePath, updated);
      return updated;
    });
  } else {
    const currentState = input.state ?? (await readState(options.statePath));
    nextState =
      applyInMemory && input.milestone
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
  });
  const requiredRoutes = plan.runnable
    .map((item) => ({
      agent: item.primary,
      model: item.model,
      role: "worker",
    }))
    .filter(
      (route, index, routes) =>
        routes.findIndex(
          (candidate) =>
            candidate.agent === route.agent &&
            candidate.model === route.model &&
            candidate.role === route.role,
        ) === index,
    );
  validateCapabilities(requiredRoutes, options.capabilities);
  return {
    dryRun,
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
    ["--issues", "issues"],
    ["--priority", "priority"],
    ["--iteration", "iteration"],
    ["--size", "size"],
    ["--unavailable-model", "unavailableModels"],
    ["--state-path", "statePath"],
    ["--existing-worktree", "existingWorktrees"],
    ["--milestone-json", "milestoneJson"],
    ["--milestone-file", "milestoneFile"],
    ["--capabilities-file", "capabilitiesFile"],
    ["--parent-agent", "parentAgent"],
    ["--parent-model", "parentModel"],
    ["--config", "configPath"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (flag === "--simulate-milestone") {
      options.simulateMilestone = true;
      continue;
    }
    // Backward-compatible alias; prefer --parent-agent.
    if (flag === "--parent-provider") {
      const value = argv[++index];
      if (value === undefined || value.startsWith("--")) throw new Error(`missing-flag-value:${flag}`);
      options.parentAgent = value;
      continue;
    }
    const key = valueFlags.get(flag);
    if (!key) throw new Error(`unknown-flag:${flag}`);
    const value = argv[++index];
    if (value === undefined || value.startsWith("--")) throw new Error(`missing-flag-value:${flag}`);
    if (["unavailableModels", "existingWorktrees", "issues", "priority", "iteration", "size"].includes(key)) {
      options[key] ??= [];
      if (["issues", "priority", "iteration", "size"].includes(key))
        options[key].push(...value.split(",").map((item) => item.trim()).filter(Boolean));
      else options[key].push(key === "existingWorktrees" ? Number(value) : value);
    } else options[key] = ["projectNumber", "maxParallel"].includes(key) ? Number(value) : value;
  }
  if (options.ownerType !== undefined && !OWNER_TYPES.has(options.ownerType))
    throw new Error("invalid-owner-type");
  if (options.milestoneJson && options.milestoneFile) throw new Error("milestone-source-conflict");
  return options;
}

async function loadProjectConfig(cli) {
  const config = JSON.parse(
    await fs.readFile(new URL("../config/github-projects.json", import.meta.url), "utf8"),
  );
  return selectProjectConfig(config.projects, {
    owner: cli.projectOwner,
    ownerType: cli.ownerType ?? "user",
    name: cli.projectName,
    number: cli.projectNumber,
  });
}

async function readInput(cli) {
  const selectors = {
    issues: cli.issues,
    priority: cli.priority,
    iteration: cli.iteration,
    size: cli.size,
  };
  if (cli.inputPath) {
    const input = JSON.parse(await fs.readFile(cli.inputPath, "utf8"));
    return { ...input, items: selectProjectItems(input.items, selectors) };
  }
  if (cli.projectOwner || cli.projectNumber) {
    if (!cli.projectOwner || !cli.projectNumber) throw new Error("project-owner-and-number-required");
    const project = await loadProjectConfig(cli);
    const fetched = await fetchProjectItems({
        owner: cli.projectOwner,
        ownerType: cli.ownerType ?? "user",
        projectNumber: cli.projectNumber,
        fields: project.fields,
        graphql: (query, variables) =>
          githubGraphql(query, variables, {
            token: process.env.GH_PROJECT_TOKEN || process.env.GITHUB_TOKEN,
          }),
      });
    return {
      ...fetched,
      items: selectProjectItems(fetched.items, selectors),
      projectConfig: project,
    };
  }
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  if (!chunks.length) throw new Error("input-required");
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function main() {
  const cli = parseCliArgs(process.argv.slice(2));
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  let yamlConfig = {};
  try {
    yamlConfig = await loadOrchestratorConfig(cli.configPath ?? DEFAULT_CONFIG_PATH, {
      cwd: repositoryRoot,
    });
  } catch (error) {
    if (error.message !== "config-file-not-found" || cli.configPath) throw error;
  }
  const merged = mergeOrchestratorConfig({
    yaml: yamlConfig,
    cli: {
      ...(cli.projectOwner === undefined ? {} : { projectOwner: cli.projectOwner }),
      ...(cli.ownerType === undefined ? {} : { ownerType: cli.ownerType }),
      ...(cli.projectNumber === undefined ? {} : { projectNumber: cli.projectNumber }),
      ...(cli.maxParallel === undefined ? {} : { maxParallel: cli.maxParallel }),
      ...(cli.releasePolicy === undefined ? {} : { releasePolicy: cli.releasePolicy }),
      ...(cli.unavailableModels === undefined ? {} : { unavailableModels: cli.unavailableModels }),
    },
  });
  const effectiveCli = {
    ...cli,
    ...(merged.projectOwner === undefined ? {} : { projectOwner: merged.projectOwner }),
    ...(merged.ownerType === undefined ? {} : { ownerType: merged.ownerType }),
    ...(merged.projectNumber === undefined ? {} : { projectNumber: merged.projectNumber }),
    ...(merged.maxParallel === undefined ? {} : { maxParallel: merged.maxParallel }),
    ...(merged.releasePolicy === undefined ? {} : { releasePolicy: merged.releasePolicy }),
    ...(merged.unavailableModels === undefined ? {} : { unavailableModels: merged.unavailableModels }),
  };
  const input = await readInput(effectiveCli);
  if (cli.milestoneJson) input.milestone = JSON.parse(cli.milestoneJson);
  if (cli.milestoneFile) input.milestone = JSON.parse(await fs.readFile(cli.milestoneFile, "utf8"));
  const capabilities = cli.capabilitiesFile
    ? JSON.parse(await fs.readFile(cli.capabilitiesFile, "utf8"))
    : undefined;
  input.options = {
    ...(input.options ?? {}),
    ...(cli.dryRun === undefined ? {} : { dryRun: cli.dryRun }),
    ...(cli.simulateMilestone === undefined ? {} : { simulateMilestone: cli.simulateMilestone }),
    ...(effectiveCli.maxParallel === undefined ? {} : { maxParallel: effectiveCli.maxParallel }),
    ...(effectiveCli.releasePolicy === undefined ? {} : { releasePolicy: effectiveCli.releasePolicy }),
    ...(effectiveCli.unavailableModels === undefined ? {} : { unavailableModels: effectiveCli.unavailableModels }),
    ...(cli.statePath === undefined ? {} : { statePath: cli.statePath }),
    ...(cli.existingWorktrees === undefined ? {} : { existingWorktrees: cli.existingWorktrees }),
    ...(capabilities === undefined ? {} : { capabilities }),
    ...(cli.parentAgent && cli.parentModel
      ? { parent: { agent: cli.parentAgent, model: cli.parentModel } }
      : {}),
  };
  if ((cli.parentAgent && !cli.parentModel) || (!cli.parentAgent && cli.parentModel))
    throw new Error("parent-agent-and-model-required");
  if (!input.options.aiSubAssignees) {
    const project = input.projectConfig ?? (effectiveCli.projectNumber ? await loadProjectConfig(effectiveCli) : null);
    if (project?.aiSubAssignees) input.options.aiSubAssignees = project.aiSubAssignees;
  }
  delete input.projectConfig;
  process.stdout.write(`${JSON.stringify(await runOrchestration(input))}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ status: "error", reason: error.message })}\n`);
    process.exitCode = 1;
  });
