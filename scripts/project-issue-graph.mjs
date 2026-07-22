#!/usr/bin/env node

/**
 * LangGraph StateGraph model of project-issue orchestration (Issue #439).
 *
 * The graph makes the long-running orchestration's state transitions,
 * parallel dispatch, checkpointing, recovery, and auditability explicit.
 * It does not replace the existing building blocks: config loading,
 * capability discovery, planning, milestone application, and dispatch all
 * call the same functions the classic `project-issue-orchestrator.mjs`
 * CLI uses. Runtime adapters, worktree lifecycle, and CLI process launch
 * stay outside the graph (they are injected side effects).
 *
 * Judgment points that belong to the orchestrating agent — dynamic route
 * assignment, the integration quality gate verdict, and worker lifecycle
 * events — surface as `interrupt()` pauses. Every resume payload is
 * validated against deterministic state (the verified worker-route pool,
 * the selected Issue set, closed event schemas), so an LLM caller can
 * only pick among verified routes and can never invent one; invalid
 * proposals fail the run closed.
 *
 * Graph state stores only non-sensitive orchestration data: Issue
 * numbers/titles/URLs/status, routing labels and selectors, milestones,
 * timestamps, process metadata, and exact usage. Issue bodies, prompts,
 * diffs, credentials, and personal data must never enter state (they
 * would otherwise be persisted by the checkpointer).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";

import { Annotation, Command, END, START, Send, StateGraph, interrupt, isInterrupted } from "@langchain/langgraph";

import {
  DEFAULT_CAPABILITIES_OUTPUT,
  loadOrRefreshCapabilities,
} from "./project-issue-capabilities.mjs";
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
  selectWorkerRoutes,
  validateCapabilities,
} from "./project-issue-plan.mjs";
import { FileCheckpointSaver } from "./project-issue-graph-checkpointer.mjs";

const execFileAsync = promisify(execFile);

export const DEFAULT_CHECKPOINT_DIR = "state/project-issue-graph";

const RELEASE_POLICIES = new Set(["pr-created", "merged"]);
const MILESTONE_TYPES = new Set(["pr-created", "merged"]);
const EVENT_TYPES = new Set(["milestone", "worker-interrupted", "worker-started", "check"]);
const GATE_CHECKS = Object.freeze([
  "conflicts-with-other-issues-in-run",
  "contract-consistency-with-dependencies-and-dependents",
  "acceptance-criteria-coverage",
]);

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

const unionStrings = (left = [], right = []) => [...new Set([...left, ...(right ?? [])])];
const unionNumbers = (left = [], right = []) =>
  [...new Set([...left, ...(right ?? [])].map(Number))].sort((a, b) => a - b);

/** Append-only milestone log, deduplicated on (issue, type). */
const mergeMilestones = (left = [], right = []) => {
  const merged = [...left];
  for (const entry of right ?? []) {
    if (!merged.some(({ issue, type }) => issue === entry.issue && type === entry.type))
      merged.push({ issue: entry.issue, type: entry.type });
  }
  return merged;
};

/** Keyed merge: entries in `right` replace same-issue entries in `left`. */
const mergeByIssue = (key) => (left = [], right) => {
  if (right === null) return [];
  const merged = [...left];
  for (const entry of right ?? []) {
    const index = merged.findIndex((existing) => existing[key] === entry[key]);
    if (index === -1) merged.push(entry);
    else merged[index] = entry;
  }
  return merged;
};

export const OrchestrationState = Annotation.Root({
  /** Sanitized run config (owner/name labels, maxParallel, releasePolicy, parent route, selectors). */
  config: Annotation(),
  /** Selected, sanitized project items (identity + ordering metadata + dependency closure). */
  items: Annotation(),
  /** Verified capability records from discovery (or explicit test input). */
  capabilities: Annotation(),
  /** Run-scoped verified worker-route pool after unavailable exclusions. */
  workerRoutes: Annotation(),
  /** Optional caller-proposed assignments; always validated against the pool. */
  proposedAssignments: Annotation(),
  unavailableAgents: Annotation({ reducer: unionStrings, default: () => [] }),
  unavailableModels: Annotation({ reducer: unionStrings, default: () => [] }),
  completed: Annotation({ reducer: unionNumbers, default: () => [] }),
  milestones: Annotation({ reducer: mergeMilestones, default: () => [] }),
  usage: Annotation({ reducer: (left = {}, right = {}) => ({ ...left, ...right }), default: () => ({}) }),
  plan: Annotation(),
  /** Current route assignment per Issue: {number, agent, model, route, attempt, mode}. */
  assignments: Annotation({ reducer: mergeByIssue("number"), default: () => [] }),
  /**
   * Worker execution metadata per Issue (latest attempt wins): issue,
   * attempt, uuid, pid/pgid when known, startedAt, worktreeId, agent,
   * model, expectedMilestone, status, dispatchCommand. PID alone never
   * decides recovery — probes must match uuid/start metadata too.
   */
  workerExecutions: Annotation({ reducer: mergeByIssue("issue"), default: () => [] }),
  gateResults: Annotation({ reducer: (left = [], right = []) => [...left, ...(right ?? [])], default: () => [] }),
  /** Milestone event currently under integration-gate review, or null. */
  pendingGate: Annotation(),
  /** Issues needing handoff: {issue, reason, proposedRoute?}; null clears. */
  pendingInterrupted: Annotation({ reducer: mergeByIssue("issue"), default: () => [] }),
  lastEventError: Annotation(),
  /** "verified" | "unavailable" — set by discover_capabilities. */
  parentRouting: Annotation(),
  runStatus: Annotation(),
  failureReason: Annotation(),
  summary: Annotation(),
});

/* ------------------------------------------------------------------ */
/* Pure state helpers                                                  */
/* ------------------------------------------------------------------ */

function getDeps(config) {
  const deps = config?.configurable?.deps;
  if (!deps) throw new Error("graph-deps-required");
  return deps;
}

function executionsFor(state, issue) {
  return (state.workerExecutions ?? []).filter((execution) => execution.issue === issue);
}

function activeExecutions(state) {
  return (state.workerExecutions ?? []).filter((execution) => execution.status === "running");
}

function attemptFor(state, issue) {
  return Math.max(0, ...executionsFor(state, issue).map(({ attempt }) => attempt)) + 1;
}

function pendingDispatches(state) {
  const executions = state.workerExecutions ?? [];
  return (state.assignments ?? []).filter(
    (assignment) =>
      !executions.some(
        (execution) => execution.issue === assignment.number && execution.attempt >= assignment.attempt,
      ),
  );
}

function skippedNumbers(state) {
  return (state.plan?.skipped ?? []).map(({ number }) => number);
}

function allComplete(state) {
  // Undefined items = the run never got past selection; an empty selection
  // (unreachable via selectProjectItems, which rejects empty matches) is
  // trivially complete rather than "blocked".
  if (!state.items) return false;
  const done = new Set([...(state.completed ?? []), ...skippedNumbers(state)]);
  return state.items.every(({ number }) => done.has(number));
}

function expectedMilestone(state, issue) {
  const hasPrCreated = (state.milestones ?? []).some(
    (milestone) => milestone.issue === issue && milestone.type === "pr-created",
  );
  return hasPrCreated ? "merged" : "pr-created";
}

function currentPool(state) {
  return selectWorkerRoutes(state.capabilities ?? [], {
    unavailableAgents: state.unavailableAgents,
    unavailableModels: state.unavailableModels,
  });
}

/** Resolve a proposed {agent, model} against the verified pool, or null. */
function resolveRoute(pool, proposal) {
  if (!proposal || typeof proposal !== "object") return null;
  return (
    pool.find(
      (route) =>
        route.agent === proposal.agent &&
        (route.requestedModel !== undefined
          ? route.requestedModel === proposal.model
          : route.model === proposal.model),
    ) ?? null
  );
}

function routeLabels(route) {
  return { agent: route.agent, model: route.requestedModel ?? route.model };
}

export function buildSummary(state, runStatus) {
  const issueNumbers = (state.items ?? []).map(({ number }) => number);
  return {
    routing: { parent: state.parentRouting ?? "verified" },
    runnable: (state.plan?.runnable ?? []).map(({ number }) => number),
    assignments: (state.assignments ?? []).map(({ number, agent, model }) => ({ number, agent, model })),
    blocked: state.plan?.blocked ?? [],
    skipped: state.plan?.skipped ?? [],
    milestones: state.milestones ?? [],
    completed: state.completed ?? [],
    usage: buildUsageReport(state.usage ?? {}, issueNumbers),
    runStatus,
    ...(state.failureReason ? { failureReason: state.failureReason } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Nodes                                                               */
/* ------------------------------------------------------------------ */

function loadConfigNode(state) {
  const config = state.config;
  try {
    if (!config || typeof config !== "object") throw new Error("config-required");
    if (!Number.isSafeInteger(config.maxParallel) || config.maxParallel <= 0)
      throw new Error("invalid-max-parallel");
    if (!RELEASE_POLICIES.has(config.releasePolicy)) throw new Error("invalid-release-policy");
    if (!config.parent?.agent || !config.parent?.model) throw new Error("parent-route-required");
    const selectors = config.selectors ?? {};
    const hasSelector = ["issues", "priority", "iteration", "size"].some(
      (key) => Array.isArray(selectors[key]) && selectors[key].length,
    );
    if (!hasSelector) throw new Error("issue-filter-required");
    return {
      unavailableAgents: config.unavailableAgents ?? [],
      unavailableModels: config.unavailableModels ?? [],
    };
  } catch (error) {
    return { failureReason: error.message };
  }
}

async function discoverCapabilitiesNode(state, config) {
  let capabilities;
  try {
    capabilities = state.capabilities ?? (await getDeps(config).loadCapabilities(state.config));
    validateCapabilities(
      [{ agent: state.config.parent.agent, model: state.config.parent.model, role: "parent" }],
      capabilities,
    );
  } catch (error) {
    return { failureReason: error.message, parentRouting: "unavailable" };
  }
  try {
    const workerRoutes = selectWorkerRoutes(capabilities, {
      unavailableAgents: state.unavailableAgents,
      unavailableModels: state.unavailableModels,
    });
    return { capabilities, workerRoutes, parentRouting: "verified" };
  } catch (error) {
    return { failureReason: error.message, parentRouting: "verified" };
  }
}

async function fetchProjectIssuesNode(state, config) {
  try {
    const rawItems = state.items ?? (await getDeps(config).fetchItems(state.config)).items;
    const selection = selectProjectItems(rawItems, state.config.selectors);
    return { items: selection.items, completed: selection.completed };
  } catch (error) {
    return { failureReason: error.message };
  }
}

function validateDependenciesNode(state) {
  try {
    return { items: parseProjectItems(state.items) };
  } catch (error) {
    return { failureReason: error.message };
  }
}

function buildRunnablePlanNode(state) {
  try {
    const existingWorktrees = new Set([
      ...(state.config.existingWorktrees ?? []).map(Number),
      ...(state.workerExecutions ?? []).map(({ issue }) => issue),
    ]);
    const plan = buildRunPlan(state.items, {
      completed: state.completed,
      existingWorktrees: [...existingWorktrees],
      maxParallel: state.config.maxParallel,
      releasePolicy: state.config.releasePolicy,
    });
    const workerRoutes = currentPool(state);
    // Fail closed before any worktree mutation when Issues are runnable
    // but no verified worker route remains.
    if (plan.runnable.length && !workerRoutes.length)
      return { plan, workerRoutes, failureReason: "no-worker-route-available" };
    return { plan, workerRoutes };
  } catch (error) {
    return { failureReason: error.message };
  }
}

function dispatchCandidates(state) {
  const completed = new Set(state.completed ?? []);
  const interrupted = new Set((state.pendingInterrupted ?? []).map(({ issue }) => issue));
  const awaiting = new Set(pendingDispatches(state).map(({ number }) => number));
  return (state.plan?.runnable ?? []).filter(
    ({ number }) =>
      !completed.has(number) &&
      !interrupted.has(number) &&
      !awaiting.has(number) &&
      !executionsFor(state, number).some((execution) => execution.status === "running"),
  );
}

function assignRoutesNode(state) {
  if (state.failureReason) return {};
  const capacity = state.config.maxParallel - activeExecutions(state).length;
  const candidates = dispatchCandidates(state).slice(0, Math.max(0, capacity));
  if (!candidates.length) return {};

  const pool = currentPool(state);
  if (!pool.length) return { failureReason: "no-worker-route-available" };

  const proposedByNumber = new Map(
    (state.proposedAssignments ?? []).map((proposal) => [Number(proposal.number), proposal]),
  );
  let proposals = proposedByNumber;
  if (!state.config.autoAssign && !candidates.every(({ number }) => proposedByNumber.has(number))) {
    // Dynamic assignment is the orchestrating agent's judgment: pause and
    // present the deterministic candidate set plus the verified pool. The
    // resume payload can only reference pool entries (validated below).
    const resume = interrupt({
      assign: {
        issues: candidates.map(({ number, title, size, priority }) => ({ number, title, size, priority })),
        workerRoutes: pool.map(routeLabels),
      },
      ...(state.lastEventError ? { lastEventError: state.lastEventError } : {}),
    });
    if (!Array.isArray(resume?.assignments)) return { failureReason: "invalid-assignment:shape" };
    proposals = new Map(resume.assignments.map((proposal) => [Number(proposal.number), proposal]));
  }

  const assignments = [];
  for (const [index, item] of candidates.entries()) {
    const proposal = proposals.get(item.number);
    let route;
    if (proposal !== undefined) {
      route = resolveRoute(pool, proposal);
      if (!route)
        return { failureReason: `invalid-assignment:${item.number}:${proposal.agent}:${proposal.model}` };
    } else if (state.config.autoAssign) {
      route = pool[index % pool.length];
    } else {
      return { failureReason: `invalid-assignment:${item.number}:missing` };
    }
    assignments.push({
      number: item.number,
      ...routeLabels(route),
      route,
      attempt: attemptFor(state, item.number),
      mode: item.route,
    });
  }
  return { assignments, workerRoutes: pool, lastEventError: null };
}

async function dispatchWorkerNode(payload, config) {
  const deps = getDeps(config);
  const assignment = payload.assignment;
  const base = {
    issue: assignment.number,
    attempt: assignment.attempt,
    uuid: deps.uuid(),
    agent: assignment.agent,
    model: assignment.model,
    mode: assignment.mode,
    worktreeId: `issue-${assignment.number}`,
    expectedMilestone: payload.nextMilestone,
    startedAt: deps.now(),
  };
  try {
    const started = await deps.dispatch({
      route: assignment.route,
      issueNumber: assignment.number,
      releasePolicy: payload.releasePolicy,
      nextMilestone: payload.nextMilestone,
      mode: assignment.mode,
      uuid: base.uuid,
    });
    return {
      workerExecutions: [
        {
          ...base,
          status: "running",
          ...(started?.pid === undefined || started.pid === null ? {} : { pid: started.pid }),
          ...(started?.pgid === undefined ? {} : { pgid: started.pgid }),
          ...(started?.dispatchCommand === undefined ? {} : { dispatchCommand: started.dispatchCommand }),
        },
      ],
    };
  } catch (error) {
    // A route that fails at actual dispatch no longer reflects reality:
    // exclude the agent for this run and hand the Issue off. The next
    // orchestrator run should re-probe it (--invalidate-agent).
    return {
      workerExecutions: [{ ...base, status: "dispatch-failed", reason: error.message }],
      pendingInterrupted: [{ issue: assignment.number, reason: `dispatch-failed:${error.message}` }],
      unavailableAgents: [assignment.agent],
    };
  }
}

async function waitForEventsNode(state, config) {
  // Events already applied but not yet routed take precedence over waiting.
  if (state.pendingGate) return {};
  if ((state.pendingInterrupted ?? []).length) return {};

  const event = interrupt({
    waiting: {
      active: activeExecutions(state).map(({ issue, agent, model, expectedMilestone: next }) => ({
        issue,
        agent,
        model,
        expectedMilestone: next,
      })),
      accepts: [...EVENT_TYPES],
    },
    ...(state.lastEventError ? { lastEventError: state.lastEventError } : {}),
  });

  if (!event || typeof event !== "object" || !EVENT_TYPES.has(event.type))
    return { lastEventError: "invalid-event:type" };

  if (event.type === "milestone") {
    const issue = Number(event.issue);
    if (!Number.isSafeInteger(issue) || !state.items.some(({ number }) => number === issue))
      return { lastEventError: `invalid-event:unknown-issue:${event.issue}` };
    if (!MILESTONE_TYPES.has(event.milestone))
      return { lastEventError: `invalid-event:milestone-type:${event.milestone}` };
    if ((state.milestones ?? []).some((m) => m.issue === issue && m.type === event.milestone))
      return { lastEventError: `duplicate-milestone:${issue}:${event.milestone}` };
    return {
      pendingGate: {
        issue,
        type: event.milestone,
        ...(event.usage === undefined ? {} : { usage: event.usage }),
      },
      lastEventError: null,
    };
  }

  if (event.type === "worker-started") {
    const issue = Number(event.issue);
    const execution = executionsFor(state, issue).at(-1);
    if (!execution) return { lastEventError: `invalid-event:no-execution:${event.issue}` };
    return {
      workerExecutions: [
        {
          ...execution,
          ...(event.pid === undefined ? {} : { pid: Number(event.pid) }),
          ...(event.pgid === undefined ? {} : { pgid: Number(event.pgid) }),
          // Instruction-mode workers launch after the dispatch node ran, so
          // the liveness probe must compare against the moment the PID was
          // reported, not the (earlier) dispatch record time.
          pidReportedAt: getDeps(config).now(),
        },
      ],
      lastEventError: null,
    };
  }

  if (event.type === "worker-interrupted") {
    const issue = Number(event.issue);
    const execution = executionsFor(state, issue).at(-1);
    if (!execution || execution.status !== "running")
      return { lastEventError: `invalid-event:no-running-worker:${event.issue}` };
    return {
      workerExecutions: [
        { ...execution, status: "interrupted", reason: event.reason ?? "interrupted" },
      ],
      pendingInterrupted: [
        {
          issue,
          reason: event.reason ?? "interrupted",
          ...(event.proposedRoute === undefined ? {} : { proposedRoute: event.proposedRoute }),
        },
      ],
      unavailableAgents: [execution.agent],
      lastEventError: null,
    };
  }

  // "check": lost-notification fallback. Re-verify recorded executions via
  // the injected probe; a PID match alone is never sufficient (PID reuse).
  // Unlike a dispatch-time failure or an explicit interruption report, a
  // worker found dead by the probe says little about its agent CLI, so the
  // agent stays in the run's route pool (the handoff may pick it again).
  const deps = getDeps(config);
  const updates = { lastEventError: null };
  const interruptedNow = [];
  const executionUpdates = [];
  for (const execution of activeExecutions(state)) {
    const verdict = await deps.probeProcess(execution);
    if (verdict === "alive" || verdict === "unknown") continue;
    executionUpdates.push({ ...execution, status: "interrupted", reason: `probe:${verdict}` });
    interruptedNow.push({ issue: execution.issue, reason: `probe:${verdict}` });
  }
  if (executionUpdates.length) {
    updates.workerExecutions = executionUpdates;
    updates.pendingInterrupted = interruptedNow;
  }
  return updates;
}

function integrationGateNode(state) {
  const pending = state.pendingGate;
  const verdict = interrupt({
    gate: { issue: pending.issue, type: pending.type, checks: GATE_CHECKS },
    ...(state.lastEventError ? { lastEventError: state.lastEventError } : {}),
  });
  if (!verdict || typeof verdict !== "object" || typeof verdict.accepted !== "boolean")
    return { lastEventError: "invalid-gate-verdict" };
  return {
    gateResults: [
      {
        issue: pending.issue,
        type: pending.type,
        accepted: verdict.accepted,
        ...(verdict.reason === undefined ? {} : { reason: verdict.reason }),
      },
    ],
    lastEventError: null,
  };
}

function releaseDependentsNode(state) {
  const event = state.pendingGate;
  const next = applyMilestone(
    { completed: state.completed, milestones: state.milestones, usage: state.usage },
    { issue: event.issue, type: event.type, ...(event.usage === undefined ? {} : { usage: event.usage }) },
    {
      issueNumbers: state.items.map(({ number }) => number),
      releasePolicy: state.config.releasePolicy,
    },
  );
  const updates = {
    completed: next.completed,
    milestones: next.milestones,
    usage: next.usage,
    pendingGate: null,
  };
  const execution = executionsFor(state, event.issue).at(-1);
  if (execution && event.type === state.config.releasePolicy)
    updates.workerExecutions = [{ ...execution, status: "complete" }];
  else if (execution && execution.status === "running")
    updates.workerExecutions = [{ ...execution, expectedMilestone: "merged" }];
  return updates;
}

function returnToWorkerNode() {
  // Gate rejected: the Issue stays with its worker (reason recorded in
  // gateResults); dependents are not released.
  return { pendingGate: null };
}

function selectHandoffRouteNode(state) {
  const pool = currentPool(state);
  const assignments = [];
  for (const entry of state.pendingInterrupted ?? []) {
    if (!pool.length) return { failureReason: `no-worker-route-available:handoff:${entry.issue}` };
    let route = null;
    if (entry.proposedRoute !== undefined) {
      route = resolveRoute(pool, entry.proposedRoute);
      if (!route)
        return {
          failureReason: `invalid-assignment:${entry.issue}:${entry.proposedRoute?.agent}:${entry.proposedRoute?.model}`,
        };
    } else {
      route = pool[0];
    }
    // Handoff continues in the same Issue worktree: mode handoff-issue,
    // inherited WIP preserved (the worker was terminated, not the tree).
    assignments.push({
      number: entry.issue,
      ...routeLabels(route),
      route,
      attempt: attemptFor(state, entry.issue),
      mode: "handoff-issue",
    });
  }
  return { assignments, workerRoutes: pool, pendingInterrupted: null };
}

function failRunNode(state) {
  return { runStatus: "failed", summary: buildSummary(state, "failed") };
}

function summarizeRunNode(state) {
  let runStatus = "complete";
  if (state.failureReason) runStatus = "failed";
  else if (!allComplete(state)) runStatus = "blocked";
  return { runStatus, summary: buildSummary(state, runStatus) };
}

/* ------------------------------------------------------------------ */
/* Routers                                                             */
/* ------------------------------------------------------------------ */

const failOr = (next) => (state) => (state.failureReason ? "fail_run" : next);

function dispatchRouter(state) {
  if (state.failureReason) return "fail_run";
  const dispatches = pendingDispatches(state);
  if (dispatches.length)
    return dispatches.map(
      (assignment) =>
        new Send("dispatch_worker", {
          assignment,
          releasePolicy: state.config.releasePolicy,
          nextMilestone: expectedMilestone(state, assignment.number),
        }),
    );
  if (allComplete(state)) return "summarize_run";
  if (activeExecutions(state).length || (state.pendingInterrupted ?? []).length)
    return "wait_for_events";
  return "summarize_run";
}

function waitRouter(state) {
  if (state.failureReason) return "fail_run";
  if (state.pendingGate) return "integration_gate";
  if ((state.pendingInterrupted ?? []).length) return "select_handoff_route";
  if (allComplete(state)) return "summarize_run";
  return "wait_for_events";
}

function gateRouter(state) {
  if (state.failureReason) return "fail_run";
  if (state.lastEventError) return "integration_gate";
  const verdict = (state.gateResults ?? []).at(-1);
  return verdict?.accepted ? "release_dependents" : "return_to_worker";
}

/* ------------------------------------------------------------------ */
/* Graph                                                               */
/* ------------------------------------------------------------------ */

export function buildOrchestrationGraph({ checkpointer } = {}) {
  const graph = new StateGraph(OrchestrationState)
    .addNode("load_config", loadConfigNode)
    .addNode("discover_capabilities", discoverCapabilitiesNode)
    .addNode("fetch_project_issues", fetchProjectIssuesNode)
    .addNode("validate_dependencies", validateDependenciesNode)
    .addNode("build_runnable_plan", buildRunnablePlanNode)
    .addNode("assign_routes", assignRoutesNode)
    .addNode("dispatch_worker", dispatchWorkerNode)
    .addNode("wait_for_events", waitForEventsNode)
    .addNode("integration_gate", integrationGateNode)
    .addNode("release_dependents", releaseDependentsNode)
    .addNode("return_to_worker", returnToWorkerNode)
    .addNode("select_handoff_route", selectHandoffRouteNode)
    .addNode("fail_run", failRunNode)
    .addNode("summarize_run", summarizeRunNode)
    .addEdge(START, "load_config")
    .addConditionalEdges("load_config", failOr("discover_capabilities"))
    .addConditionalEdges("discover_capabilities", failOr("fetch_project_issues"))
    .addConditionalEdges("fetch_project_issues", failOr("validate_dependencies"))
    .addConditionalEdges("validate_dependencies", failOr("build_runnable_plan"))
    .addConditionalEdges("build_runnable_plan", failOr("assign_routes"))
    .addConditionalEdges("assign_routes", dispatchRouter)
    .addEdge("dispatch_worker", "wait_for_events")
    .addConditionalEdges("wait_for_events", waitRouter)
    .addConditionalEdges("integration_gate", gateRouter)
    .addEdge("release_dependents", "build_runnable_plan")
    .addEdge("return_to_worker", "wait_for_events")
    .addConditionalEdges("select_handoff_route", dispatchRouter)
    .addEdge("fail_run", END)
    .addEdge("summarize_run", END);
  return graph.compile({ checkpointer });
}

/* ------------------------------------------------------------------ */
/* Default side-effect implementations (injected, never checkpointed)  */
/* ------------------------------------------------------------------ */

export function createDefaultDeps({ cwd }) {
  return {
    uuid: () => crypto.randomUUID(),
    now: () => new Date().toISOString(),
    async loadCapabilities() {
      const discovered = await loadOrRefreshCapabilities({
        cachePath: path.resolve(cwd, DEFAULT_CAPABILITIES_OUTPUT),
        cwd,
      });
      return discovered.capabilities;
    },
    async fetchItems(config) {
      const projects = JSON.parse(
        await fs.readFile(path.resolve(cwd, "config/github-projects.json"), "utf8"),
      );
      const project = selectProjectConfig(projects.projects, {
        owner: config.projectOwner,
        ownerType: config.ownerType ?? "user",
        name: config.projectName,
      });
      return fetchProjectItems({
        owner: config.projectOwner,
        ownerType: config.ownerType ?? "user",
        projectName: config.projectName,
        fields: project.fields,
        graphql: (query, variables) =>
          githubGraphql(query, variables, {
            token: process.env.GH_PROJECT_TOKEN || process.env.GITHUB_TOKEN,
          }),
      });
    },
    /**
     * CLI process launch is intentionally outside the graph: emit the exact
     * dispatch command for the orchestrating agent to run (usually in a
     * backgrounded shell). The agent reports pid via a "worker-started"
     * event and milestones/interruptions as they happen.
     */
    async dispatch(job) {
      return {
        pid: null,
        dispatchCommand: [
          "node",
          "scripts/project-issue-dispatch.mjs",
          "--route-json",
          JSON.stringify(job.route),
          "--issue",
          String(job.issueNumber),
          "--release-policy",
          job.releasePolicy,
          "--next-milestone",
          job.nextMilestone,
        ],
      };
    },
    /**
     * PID-reuse-safe liveness probe: "alive" only when the recorded PID is
     * running AND its start time is not later than the recorded dispatch
     * time (a PID started after our record is a different, reused process).
     * "unknown" when there is no PID to check (instruction-mode dispatch).
     */
    async probeProcess(execution) {
      if (!Number.isSafeInteger(execution.pid)) return "unknown";
      let stdout;
      try {
        ({ stdout } = await execFileAsync("ps", ["-p", String(execution.pid), "-o", "lstart="]));
      } catch {
        return "dead";
      }
      const started = new Date(stdout.trim());
      if (Number.isNaN(started.getTime())) return "unknown";
      // Compare against when the PID was reported (instruction-mode workers
      // launch after the dispatch record was written), falling back to the
      // dispatch time for direct spawns.
      const recorded = new Date(execution.pidReportedAt ?? execution.startedAt);
      // Allow 5s skew between our ISO record and ps's second granularity.
      if (started.getTime() > recorded.getTime() + 5_000) return "mismatch";
      return "alive";
    },
  };
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

export function parseGraphCliArgs(argv) {
  const options = {};
  const valueFlags = new Map([
    ["--thread-id", "threadId"],
    ["--checkpoint-file", "checkpointFile"],
    ["--input", "inputPath"],
    ["--project-owner", "projectOwner"],
    ["--project-name", "projectName"],
    ["--owner-type", "ownerType"],
    ["--max-parallel", "maxParallel"],
    ["--release-policy", "releasePolicy"],
    ["--issues", "issues"],
    ["--priority", "priority"],
    ["--iteration", "iteration"],
    ["--size", "size"],
    ["--unavailable-model", "unavailableModels"],
    ["--unavailable-agent", "unavailableAgents"],
    ["--existing-worktree", "existingWorktrees"],
    ["--capabilities-file", "capabilitiesFile"],
    ["--parent-agent", "parentAgent"],
    ["--parent-model", "parentModel"],
    ["--assignments-json", "assignmentsJson"],
    ["--resume-json", "resumeJson"],
    ["--resume-file", "resumeFile"],
    ["--config", "configPath"],
  ]);
  const listKeys = new Set([
    "issues",
    "priority",
    "iteration",
    "size",
    "unavailableModels",
    "unavailableAgents",
    "existingWorktrees",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--auto-assign") {
      options.autoAssign = true;
      continue;
    }
    const key = valueFlags.get(flag);
    if (!key) throw new Error(`unknown-flag:${flag}`);
    const value = argv[++index];
    if (value === undefined || value.startsWith("--")) throw new Error(`missing-flag-value:${flag}`);
    if (listKeys.has(key)) {
      options[key] ??= [];
      if (["issues", "priority", "iteration", "size"].includes(key))
        options[key].push(
          ...value
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean),
        );
      else options[key].push(key === "existingWorktrees" ? Number(value) : value);
    } else options[key] = key === "maxParallel" ? Number(value) : value;
  }
  if (!options.threadId) throw new Error("thread-id-required");
  if (options.resumeJson && options.resumeFile) throw new Error("resume-source-conflict");
  return options;
}

async function buildStartInput(cli, repositoryRoot) {
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
    cli: Object.fromEntries(
      [
        ["projectOwner", cli.projectOwner],
        ["ownerType", cli.ownerType],
        ["projectName", cli.projectName],
        ["maxParallel", cli.maxParallel],
        ["releasePolicy", cli.releasePolicy],
        ["unavailableModels", cli.unavailableModels],
        ["unavailableAgents", cli.unavailableAgents],
      ].filter(([, value]) => value !== undefined),
    ),
  });
  if (!cli.parentAgent || !cli.parentModel) throw new Error("parent-agent-and-model-required");

  const input = {
    config: {
      projectOwner: merged.projectOwner,
      ownerType: merged.ownerType ?? "user",
      projectName: merged.projectName,
      maxParallel: merged.maxParallel,
      releasePolicy: merged.releasePolicy,
      unavailableAgents: merged.unavailableAgents ?? [],
      unavailableModels: merged.unavailableModels ?? [],
      parent: { agent: cli.parentAgent, model: cli.parentModel },
      selectors: {
        issues: cli.issues,
        priority: cli.priority,
        iteration: cli.iteration,
        size: cli.size,
      },
      existingWorktrees: cli.existingWorktrees ?? [],
      autoAssign: Boolean(cli.autoAssign),
    },
  };
  if (cli.inputPath) {
    const fileInput = JSON.parse(await fs.readFile(cli.inputPath, "utf8"));
    input.items = fileInput.items;
    if (fileInput.capabilities) input.capabilities = fileInput.capabilities;
  }
  if (cli.capabilitiesFile) {
    const loaded = JSON.parse(await fs.readFile(cli.capabilitiesFile, "utf8"));
    input.capabilities = Array.isArray(loaded) ? loaded : loaded.capabilities;
  }
  if (cli.assignmentsJson) input.proposedAssignments = JSON.parse(cli.assignmentsJson);
  return input;
}

async function main() {
  const cli = parseGraphCliArgs(process.argv.slice(2));
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const checkpointFile = path.resolve(
    repositoryRoot,
    cli.checkpointFile ?? path.join(DEFAULT_CHECKPOINT_DIR, `${cli.threadId}.json`),
  );
  const checkpointer = await FileCheckpointSaver.load(checkpointFile);
  const graph = buildOrchestrationGraph({ checkpointer });
  const config = {
    configurable: {
      thread_id: cli.threadId,
      deps: createDefaultDeps({ cwd: repositoryRoot }),
    },
  };

  let result;
  if (cli.resumeJson || cli.resumeFile) {
    const event = JSON.parse(cli.resumeJson ?? (await fs.readFile(cli.resumeFile, "utf8")));
    result = await graph.invoke(new Command({ resume: event }), config);
  } else {
    result = await graph.invoke(await buildStartInput(cli, repositoryRoot), config);
  }

  if (isInterrupted(result)) {
    const snapshot = await graph.getState(config);
    process.stdout.write(
      `${JSON.stringify({
        status: "paused",
        interrupts: result.__interrupt__.map(({ value }) => value),
        pendingDispatches: pendingDispatches(snapshot.values).map(({ number, agent, model }) => ({
          number,
          agent,
          model,
        })),
        // Instruction-mode dispatches the orchestrating agent still has to
        // launch (no pid reported yet via a "worker-started" event).
        dispatchInstructions: (snapshot.values.workerExecutions ?? [])
          .filter((execution) => execution.status === "running" && execution.pid === undefined)
          .map(({ issue, agent, model, uuid, dispatchCommand }) => ({
            issue,
            agent,
            model,
            uuid,
            ...(dispatchCommand === undefined ? {} : { dispatchCommand }),
          })),
        summary: buildSummary(snapshot.values, "in-progress"),
      })}\n`,
    );
    return;
  }
  process.stdout.write(
    `${JSON.stringify({ status: result.runStatus ?? "complete", summary: result.summary })}\n`,
  );
  if (result.runStatus === "failed") process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ status: "error", reason: error.message })}\n`);
    process.exitCode = 1;
  });
