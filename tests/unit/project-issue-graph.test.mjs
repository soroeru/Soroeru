import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { Command, MemorySaver, isInterrupted } from "@langchain/langgraph";

import {
  buildOrchestrationGraph,
  buildSummary,
  createDefaultDeps,
  parseGraphCliArgs,
} from "../../scripts/project-issue-graph.mjs";
import { FileCheckpointSaver } from "../../scripts/project-issue-graph-checkpointer.mjs";

const execFileAsync = promisify(execFile);

const parentRecord = {
  agent: "Codex",
  model: "gpt-5",
  role: "parent",
  selector: "sel",
  selectable: true,
  verifiable: true,
  timeoutMs: 60_000,
};
const workerRoute = (agent, model) => ({
  agent,
  model,
  role: "worker",
  selector: `sel ${model}`,
  selectable: true,
  verifiable: true,
  timeoutMs: 60_000,
});
const defaultCapabilities = [
  parentRecord,
  workerRoute("Codex", "gpt-5"),
  workerRoute("Claude", "sonnet"),
  workerRoute("Grok", "grok-4"),
];

const item = (number, dependencies = [], overrides = {}) => ({
  number,
  title: `Issue ${number}`,
  url: `https://example.com/${number}`,
  status: "Ready",
  priority: "P1",
  dependencies,
  ...overrides,
});

const usageSample = {
  inputTokens: 10,
  cachedInputTokens: 1,
  outputTokens: 2,
  toolCalls: 3,
  waitCalls: 4,
  wallClockMs: 500,
  fetchedBytes: 600,
};

function makeDeps(overrides = {}) {
  const dispatched = [];
  return {
    dispatched,
    uuid: () => `uuid-${dispatched.length + 1}`,
    now: () => "2026-07-22T00:00:00.000Z",
    loadCapabilities: async () => {
      throw new Error("unexpected-discovery");
    },
    invalidateCapabilities: async () => {},
    fetchItems: async () => {
      throw new Error("unexpected-fetch");
    },
    dispatch: async (job) => {
      dispatched.push(job);
      return { pid: 9000 + dispatched.length };
    },
    probeProcess: async () => "alive",
    ...overrides,
  };
}

function makeInput({ items, capabilities = defaultCapabilities, config = {} }) {
  return {
    config: {
      maxParallel: 1,
      releasePolicy: "pr-created",
      parent: { agent: "Codex", model: "gpt-5" },
      selectors: { issues: items.map(({ number }) => String(number)) },
      autoAssign: true,
      // Most cases here cover orchestration invariants that predate role
      // programs; they double as regression coverage for the single-worker
      // escape hatch. Role-program cases pass singleWorker: false.
      singleWorker: true,
      ...config,
    },
    items,
    capabilities,
  };
}

function makeRun({ deps = makeDeps(), checkpointer = new MemorySaver(), threadId = "t" } = {}) {
  const graph = buildOrchestrationGraph({ checkpointer });
  const config = { configurable: { thread_id: threadId, deps } };
  return {
    deps,
    graph,
    config,
    invoke: (input) => graph.invoke(input, config),
    resume: (value) => graph.invoke(new Command({ resume: value }), config),
    state: async () => (await graph.getState(config)).values,
  };
}

test("fails closed on a dependency cycle", async () => {
  const run = makeRun();
  const result = await run.invoke(makeInput({ items: [item(1, [2]), item(2, [1])] }));
  assert.equal(result.runStatus, "failed");
  assert.match(result.failureReason, /^dependency-cycle:/);
  assert.equal(run.deps.dispatched.length, 0);
});

test("fails closed on an open blocked-by dependency", async () => {
  const items = [item(1, [9], { blockedBy: [{ number: 9, state: "OPEN" }] })];
  const run = makeRun();
  const result = await run.invoke(makeInput({ items }));
  assert.equal(result.runStatus, "failed");
  assert.equal(result.failureReason, "dependency-open:1:9");
  assert.equal(run.deps.dispatched.length, 0);
});

test("stops before any dispatch when zero verified worker routes exist", async () => {
  const run = makeRun();
  const result = await run.invoke(makeInput({ items: [item(1)], capabilities: [parentRecord] }));
  assert.equal(result.runStatus, "failed");
  assert.equal(result.failureReason, "no-worker-route-available");
  assert.equal(run.deps.dispatched.length, 0);
});

test("fails closed when the parent route is unverifiable", async () => {
  const run = makeRun();
  const result = await run.invoke(
    makeInput({
      items: [item(1)],
      capabilities: [{ ...parentRecord, verifiable: false }, workerRoute("Codex", "gpt-5")],
    }),
  );
  assert.equal(result.runStatus, "failed");
  assert.match(result.failureReason, /^routing-unavailable:parent/);
  assert.equal(result.summary.routing.parent, "unavailable");
});

test("an unavailable agent is excluded from assignment", async () => {
  const run = makeRun();
  const result = await run.invoke(makeInput({ items: [item(1)], config: { unavailableAgents: ["Codex"] } }));
  assert.equal(isInterrupted(result), true);
  assert.deepEqual(
    run.deps.dispatched.map(({ route }) => route.agent),
    ["Claude"],
  );
});

test("a proposed assignment outside the verified pool fails closed", async () => {
  const run = makeRun();
  const result = await run.invoke({
    ...makeInput({ items: [item(1)], config: { autoAssign: false } }),
    proposedAssignments: [{ number: 1, agent: "Codex", model: "gpt-6-imagined" }],
  });
  assert.equal(result.runStatus, "failed");
  assert.equal(result.failureReason, "invalid-assignment:1:Codex:gpt-6-imagined");
  assert.equal(run.deps.dispatched.length, 0);
});

test("interactive assignment pauses with the verified pool and accepts only pool routes", async () => {
  const run = makeRun();
  const paused = await run.invoke(makeInput({ items: [item(1)], config: { autoAssign: false } }));
  assert.equal(isInterrupted(paused), true);
  const payload = paused.__interrupt__[0].value;
  assert.deepEqual(payload.assign.workerRoutes, [
    { agent: "Claude", model: "sonnet" },
    { agent: "Grok", model: "grok-4" },
  ]);
  const result = await run.resume({ assignments: [{ number: 1, agent: "Claude", model: "sonnet" }] });
  assert.equal(isInterrupted(result), true);
  assert.deepEqual(
    run.deps.dispatched.map(({ route }) => route.agent),
    ["Claude"],
  );
});

test("an invalid interactive assignment re-prompts instead of killing the run", async () => {
  const run = makeRun();
  await run.invoke(makeInput({ items: [item(1)], config: { autoAssign: false } }));
  const rejected = await run.resume({
    assignments: [{ number: 1, agent: "Codex", model: "gpt-6-imagined" }],
  });
  assert.equal(isInterrupted(rejected), true);
  const payload = rejected.__interrupt__[0].value;
  assert.equal(payload.lastEventError, "invalid-assignment:1:Codex:gpt-6-imagined");
  assert.ok(payload.assign, "re-presents the candidate set and verified pool");
  assert.equal(run.deps.dispatched.length, 0);
  // A corrected proposal then proceeds normally.
  const accepted = await run.resume({ assignments: [{ number: 1, agent: "Claude", model: "sonnet" }] });
  assert.equal(isInterrupted(accepted), true);
  assert.deepEqual(
    run.deps.dispatched.map(({ issueNumber }) => issueNumber),
    [1],
  );
});

test("schedules dependent Issues only after the release milestone passes the gate", async () => {
  const run = makeRun();
  let result = await run.invoke(makeInput({ items: [item(1), item(2, [1])] }));
  assert.deepEqual(
    run.deps.dispatched.map(({ issueNumber }) => issueNumber),
    [1],
  );

  result = await run.resume({ type: "milestone", issue: 1, milestone: "pr-created", usage: usageSample });
  assert.deepEqual(result.__interrupt__[0].value.gate, {
    issue: 1,
    type: "pr-created",
    checks: [
      "conflicts-with-other-issues-in-run",
      "contract-consistency-with-dependencies-and-dependents",
      "acceptance-criteria-coverage",
    ],
  });

  result = await run.resume({ accepted: true });
  assert.deepEqual(
    run.deps.dispatched.map(({ issueNumber }) => issueNumber),
    [1, 2],
  );

  result = await run.resume({ type: "milestone", issue: 2, milestone: "pr-created" });
  result = await run.resume({ accepted: true });
  assert.equal(result.runStatus, "complete");
  assert.deepEqual(result.summary.completed, [1, 2]);
  assert.deepEqual(result.summary.usage.total.availableIssues, [1]);
  assert.deepEqual(result.summary.usage.total.usage.inputTokens, 10);
});

test("gate rejection does not release dependents", async () => {
  const run = makeRun();
  await run.invoke(makeInput({ items: [item(1), item(2, [1])] }));
  await run.resume({ type: "milestone", issue: 1, milestone: "pr-created" });
  const result = await run.resume({ accepted: false, reason: "conflicts with issue 2 contract" });
  assert.equal(isInterrupted(result), true);
  // Still waiting on Issue 1; Issue 2 was never dispatched or completed.
  assert.deepEqual(
    run.deps.dispatched.map(({ issueNumber }) => issueNumber),
    [1],
  );
  const state = await run.state();
  assert.deepEqual(state.completed, []);
  assert.deepEqual(state.milestones, []);
  assert.deepEqual(state.gateResults, [
    { issue: 1, type: "pr-created", accepted: false, reason: "conflicts with issue 2 contract" },
  ]);
  // The worker may resubmit the same milestone after rework; acceptance
  // then releases and dispatches the dependent Issue.
  await run.resume({ type: "milestone", issue: 1, milestone: "pr-created" });
  const accepted = await run.resume({ accepted: true });
  assert.equal(isInterrupted(accepted), true);
  assert.deepEqual(
    run.deps.dispatched.map(({ issueNumber }) => issueNumber),
    [1, 2],
  );
  assert.deepEqual((await run.state()).completed, [1]);
});

test("merged release policy completes only on merged", async () => {
  const run = makeRun();
  await run.invoke(makeInput({ items: [item(1), item(2, [1])], config: { releasePolicy: "merged" } }));
  await run.resume({ type: "milestone", issue: 1, milestone: "pr-created" });
  let result = await run.resume({ accepted: true });
  // pr-created accepted but policy is merged: dependent not released.
  assert.deepEqual(
    run.deps.dispatched.map(({ issueNumber }) => issueNumber),
    [1],
  );
  const midState = await run.state();
  assert.deepEqual(midState.completed, []);
  assert.equal(midState.workerExecutions[0].expectedMilestone, "merged");

  await run.resume({ type: "milestone", issue: 1, milestone: "merged" });
  result = await run.resume({ accepted: true });
  assert.deepEqual(
    run.deps.dispatched.map(({ issueNumber }) => issueNumber),
    [1, 2],
  );
  await run.resume({ type: "milestone", issue: 2, milestone: "merged" });
  result = await run.resume({ accepted: true });
  assert.equal(result.runStatus, "complete");
});

test("duplicate milestone events are ignored without a second gate", async () => {
  const run = makeRun();
  await run.invoke(makeInput({ items: [item(1)] }));
  await run.resume({ type: "milestone", issue: 1, milestone: "pr-created" });
  const result = await run.resume({ accepted: true });
  assert.equal(result.runStatus, "complete");
  assert.deepEqual(result.summary.milestones, [{ issue: 1, type: "pr-created" }]);
});

test("a duplicate milestone while waiting reports an event error and keeps waiting", async () => {
  const run = makeRun();
  await run.invoke(makeInput({ items: [item(1), item(2, [1])], config: { maxParallel: 2 } }));
  await run.resume({ type: "milestone", issue: 1, milestone: "pr-created" });
  await run.resume({ accepted: true });
  const result = await run.resume({ type: "milestone", issue: 1, milestone: "pr-created" });
  assert.equal(isInterrupted(result), true);
  assert.equal(result.__interrupt__[0].value.lastEventError, "duplicate-milestone:1:pr-created");
  const state = await run.state();
  assert.deepEqual(state.milestones, [{ issue: 1, type: "pr-created" }]);
});

test("worker interruption hands off to another verified route in the same worktree", async () => {
  const run = makeRun();
  await run.invoke(makeInput({ items: [item(1)] }));
  const before = await run.state();
  assert.equal(before.workerExecutions[0].agent, "Claude");
  assert.equal(before.workerExecutions[0].worktreeId, "issue-1");

  const result = await run.resume({ type: "worker-interrupted", issue: 1, reason: "timeout" });
  assert.equal(isInterrupted(result), true);
  const state = await run.state();
  assert.deepEqual(state.unavailableAgents, ["Claude"]);
  const execution = state.workerExecutions[0];
  assert.equal(execution.agent, "Grok");
  assert.equal(execution.skill, "handoff-issue");
  assert.equal(execution.attempt, 2);
  assert.equal(execution.worktreeId, "issue-1");
  assert.equal(run.deps.dispatched.at(-1).skill, "handoff-issue");
});

test("an interruption can carry a proposed handoff route, validated against the pool", async () => {
  const capabilities = [...defaultCapabilities, workerRoute("Grok", "grok-4")];
  const run = makeRun();
  await run.invoke(makeInput({ items: [item(1)], capabilities }));
  await run.resume({
    type: "worker-interrupted",
    issue: 1,
    reason: "session-limit",
    proposedRoute: { agent: "Grok", model: "grok-4" },
  });
  const state = await run.state();
  assert.equal(state.workerExecutions[0].agent, "Grok");
});

test("fails closed when every handoff candidate is unavailable", async () => {
  const run = makeRun();
  const result = await run
    .invoke(makeInput({ items: [item(1)], capabilities: [parentRecord, workerRoute("Claude", "sonnet")] }))
    .then(() => run.resume({ type: "worker-interrupted", issue: 1, reason: "timeout" }));
  assert.equal(result.runStatus, "failed");
  assert.equal(result.failureReason, "no-worker-route-available:handoff:1");
  // The interrupted worktree is untouched: no further dispatch happened.
  assert.equal(run.deps.dispatched.length, 1);
});

test("a route failing at dispatch time is excluded and the Issue handed off", async () => {
  const invalidated = [];
  const deps = makeDeps({
    invalidateCapabilities: async (agent) => invalidated.push(agent),
    dispatch: async (job) => {
      if (job.route.agent === "Claude") throw new Error("model-mismatch");
      deps.dispatched.push(job);
      return { pid: 9100 };
    },
  });
  const run = makeRun({ deps });
  const result = await run.invoke(makeInput({ items: [item(1)] }));
  assert.equal(isInterrupted(result), true);
  const state = await run.state();
  assert.deepEqual(state.unavailableModels, ["sonnet"]);
  assert.deepEqual(state.unavailableAgents, []);
  assert.deepEqual(invalidated, ["Claude"]);
  assert.equal(state.workerExecutions[0].agent, "Grok");
  // The failed dispatch never started a worker, so no worktree exists yet:
  // the retry keeps the mode that attempt was going to use.
  assert.equal(state.workerExecutions[0].skill, "issue-implementation");
});

test("an interrupted worker with a pre-existing worktree hands off in handoff-issue mode", async () => {
  const run = makeRun();
  await run.invoke(makeInput({ items: [item(1)] }));
  await run.resume({ type: "worker-interrupted", issue: 1, reason: "session-limit" });
  const state = await run.state();
  assert.equal(state.workerExecutions[0].skill, "handoff-issue");
});

test("lost-notification check probes executions and hands off dead workers", async () => {
  const deps = makeDeps({ probeProcess: async () => "dead" });
  const run = makeRun({ deps });
  await run.invoke(makeInput({ items: [item(1)] }));
  const result = await run.resume({ type: "check" });
  assert.equal(isInterrupted(result), true);
  const state = await run.state();
  // A probe-detected death is not evidence against the agent CLI itself:
  // the agent stays in the pool (and is picked again here), unlike an
  // explicit interruption or dispatch failure.
  assert.deepEqual(state.unavailableAgents, []);
  assert.equal(state.workerExecutions[0].agent, "Claude");
  assert.equal(state.workerExecutions[0].skill, "handoff-issue");
  assert.equal(state.workerExecutions[0].attempt, 2);
});

test("a check with live workers keeps waiting without changes", async () => {
  const run = makeRun();
  await run.invoke(makeInput({ items: [item(1)] }));
  const result = await run.resume({ type: "check" });
  assert.equal(isInterrupted(result), true);
  const state = await run.state();
  assert.equal(state.workerExecutions[0].agent, "Claude");
  assert.equal(state.workerExecutions[0].status, "running");
});

test("worker-started events attach process metadata to the execution", async () => {
  const deps = makeDeps({ dispatch: async () => ({ pid: null, dispatchCommand: ["node", "x"] }) });
  const run = makeRun({ deps });
  await run.invoke(makeInput({ items: [item(1)] }));
  await run.resume({ type: "worker-started", issue: 1, pid: 4242, pgid: 4242 });
  const state = await run.state();
  assert.equal(state.workerExecutions[0].pid, 4242);
  assert.equal(state.workerExecutions[0].pgid, 4242);
  // The probe compares against the PID report time, not the earlier
  // dispatch record, so late-launched instruction-mode workers stay alive.
  assert.equal(state.workerExecutions[0].pidReportedAt, "2026-07-22T00:00:00.000Z");
});

test("the default probe accepts a live worker whose PID was reported after launch", async (t) => {
  const { spawn } = await import("node:child_process");
  const child = spawn("sleep", ["60"], { stdio: "ignore" });
  t.after(() => child.kill("SIGKILL"));
  await new Promise((resolve) => child.once("spawn", resolve));
  const { probeProcess } = createDefaultDeps({ cwd: process.cwd() });

  // Instruction-mode flow: dispatch was recorded long before the agent
  // actually launched the worker; the PID report time is what must match.
  const dispatchRecordedAt = new Date(Date.now() - 3_600_000).toISOString();
  assert.equal(
    await probeProcess({
      pid: child.pid,
      startedAt: dispatchRecordedAt,
      pidReportedAt: new Date().toISOString(),
    }),
    "alive",
  );
  // A PID recorded long ago but whose process started now is a reused PID.
  assert.equal(await probeProcess({ pid: child.pid, startedAt: dispatchRecordedAt }), "mismatch");
  assert.equal(await probeProcess({ startedAt: dispatchRecordedAt }), "unknown");

  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(await probeProcess({ pid: child.pid, pidReportedAt: new Date().toISOString() }), "dead");
});

test("dispatches independent Issues in parallel and tolerates reversed completion order", async () => {
  const run = makeRun();
  await run.invoke(makeInput({ items: [item(1), item(2)], config: { maxParallel: 2 } }));
  assert.deepEqual(run.deps.dispatched.map(({ issueNumber }) => issueNumber).sort(), [1, 2]);

  await run.resume({ type: "milestone", issue: 2, milestone: "pr-created" });
  await run.resume({ accepted: true });
  await run.resume({ type: "milestone", issue: 1, milestone: "pr-created" });
  const result = await run.resume({ accepted: true });
  assert.equal(result.runStatus, "complete");
  assert.deepEqual(result.summary.completed, [1, 2]);
});

test("maxParallel counts active workers before dispatching more", async () => {
  const run = makeRun();
  await run.invoke(makeInput({ items: [item(1), item(2)], config: { maxParallel: 1 } }));
  assert.deepEqual(
    run.deps.dispatched.map(({ issueNumber }) => issueNumber),
    [1],
  );
  await run.resume({ type: "milestone", issue: 1, milestone: "pr-created" });
  await run.resume({ accepted: true });
  assert.deepEqual(
    run.deps.dispatched.map(({ issueNumber }) => issueNumber),
    [1, 2],
  );
});

test("an invalid gate verdict re-prompts the gate", async () => {
  const run = makeRun();
  await run.invoke(makeInput({ items: [item(1)] }));
  await run.resume({ type: "milestone", issue: 1, milestone: "pr-created" });
  const result = await run.resume({ accepted: "yes" });
  assert.equal(isInterrupted(result), true);
  const payload = result.__interrupt__[0].value;
  assert.equal(payload.gate.issue, 1);
  assert.equal(payload.lastEventError, "invalid-gate-verdict");
  const accepted = await run.resume({ accepted: true });
  assert.equal(accepted.runStatus, "complete");
});

test("summary keeps the established report fields", async () => {
  const run = makeRun();
  await run.invoke(makeInput({ items: [item(1)] }));
  await run.resume({ type: "milestone", issue: 1, milestone: "pr-created" });
  const result = await run.resume({ accepted: true });
  assert.deepEqual(
    Object.keys(result.summary).sort(),
    [
      "assignments",
      "blocked",
      "completed",
      "milestones",
      "roles",
      "routing",
      "runnable",
      "skipped",
      "usage",
      "runStatus",
    ].sort(),
  );
  assert.deepEqual(result.summary.assignments, [{ number: 1, agent: "Claude", model: "sonnet" }]);
  assert.deepEqual(result.summary.usage.issues, [{ number: 1, usage: "unavailable" }]);
});

test("buildSummary reports the parent routing status recorded by discovery", () => {
  assert.equal(buildSummary({ parentRouting: "unavailable" }, "failed").routing.parent, "unavailable");
  assert.equal(buildSummary({}, "failed").routing.parent, "verified");
});

test("resumes after a process restart from the file checkpointer with the same thread id", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "graph-checkpoint-"));
  const checkpointFile = path.join(directory, "run.json");
  try {
    const first = makeRun({
      checkpointer: await FileCheckpointSaver.load(checkpointFile),
      threadId: "restart",
    });
    await first.invoke(makeInput({ items: [item(1), item(2, [1])] }));
    assert.deepEqual(
      first.deps.dispatched.map(({ issueNumber }) => issueNumber),
      [1],
    );

    // Simulate a restart: a fresh saver instance hydrated from disk.
    const second = makeRun({
      checkpointer: await FileCheckpointSaver.load(checkpointFile),
      threadId: "restart",
    });
    await second.resume({ type: "milestone", issue: 1, milestone: "pr-created" });
    const result = await second.resume({ accepted: true });
    assert.equal(isInterrupted(result), true);
    assert.deepEqual(
      second.deps.dispatched.map(({ issueNumber }) => issueNumber),
      [2],
    );
    const state = await second.state();
    assert.deepEqual(state.completed, [1]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("checkpoints contain no Issue bodies, prompts, diffs, or credentials", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "graph-checkpoint-"));
  const checkpointFile = path.join(directory, "run.json");
  try {
    const run = makeRun({
      checkpointer: await FileCheckpointSaver.load(checkpointFile),
      threadId: "privacy",
    });
    await run.invoke(makeInput({ items: [item(1)] }));
    await run.resume({ type: "milestone", issue: 1, milestone: "pr-created" });
    await run.resume({ accepted: true });
    const raw = await readFile(checkpointFile, "utf8");
    for (const marker of ["issueBody", "prompt", "diff", "credential", "password", "token"])
      assert.equal(raw.includes(marker), false, `checkpoint leaks ${marker}`);
    // State carries only the sanitized item fields.
    assert.equal(raw.includes("https://example.com/1"), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the graph CLI starts, pauses, and resumes across separate processes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "graph-cli-"));
  const checkpointFile = path.join(directory, "run.json");
  const inputFile = path.join(directory, "input.json");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    inputFile,
    JSON.stringify({
      items: [item(1)],
      capabilities: [parentRecord, workerRoute("Claude", "sonnet")],
    }),
  );
  const script = new URL("../../scripts/project-issue-graph.mjs", import.meta.url).pathname;
  try {
    const started = await execFileAsync(process.execPath, [
      script,
      "--thread-id",
      "cli-run",
      "--checkpoint-file",
      checkpointFile,
      "--input",
      inputFile,
      "--issues",
      "1",
      "--max-parallel",
      "1",
      "--release-policy",
      "pr-created",
      "--parent-agent",
      "Codex",
      "--parent-model",
      "gpt-5",
      "--auto-assign",
    ]);
    const paused = JSON.parse(started.stdout);
    assert.equal(paused.status, "paused");
    assert.equal(paused.dispatchInstructions.length, 1);
    assert.equal(paused.dispatchInstructions[0].issue, 1);
    // Roles are on by default, so the first worker is the implementer and
    // the launch command carries its role.
    assert.equal(paused.dispatchInstructions[0].role, "implementer");
    assert.ok(paused.dispatchInstructions[0].dispatchCommand.includes("--role"));

    const resumeArgs = (event) => [
      script,
      "--thread-id",
      "cli-run",
      "--checkpoint-file",
      checkpointFile,
      "--resume-json",
      JSON.stringify(event),
    ];
    await execFileAsync(
      process.execPath,
      resumeArgs({ type: "role-complete", issue: 1, role: "implementer" }),
    );
    await execFileAsync(
      process.execPath,
      resumeArgs({ type: "role-complete", issue: 1, role: "reviewer", verdict: "PASS" }),
    );
    const finished = await execFileAsync(process.execPath, resumeArgs({ accepted: true }));
    const result = JSON.parse(finished.stdout);
    assert.equal(result.status, "complete");
    assert.deepEqual(result.summary.completed, [1]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the file checkpointer rejects unsupported and corrupt files with stable reasons", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "graph-checkpoint-"));
  const { writeFile } = await import("node:fs/promises");
  try {
    const wrongFormat = path.join(directory, "wrong.json");
    await writeFile(wrongFormat, JSON.stringify({ format: "something-else/v9" }));
    await assert.rejects(FileCheckpointSaver.load(wrongFormat), /checkpoint-format-unsupported/);

    const corrupt = path.join(directory, "corrupt.json");
    await writeFile(corrupt, "{ not json");
    await assert.rejects(FileCheckpointSaver.load(corrupt), /checkpoint-file-corrupt/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("deleteThread persists across a checkpointer reload", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "graph-checkpoint-"));
  const checkpointFile = path.join(directory, "run.json");
  try {
    const first = makeRun({
      checkpointer: await FileCheckpointSaver.load(checkpointFile),
      threadId: "wipe",
    });
    await first.invoke(makeInput({ items: [item(1)] }));

    const saver = await FileCheckpointSaver.load(checkpointFile);
    assert.notEqual(await saver.getTuple({ configurable: { thread_id: "wipe" } }), undefined);
    await saver.deleteThread("wipe");

    const reloaded = await FileCheckpointSaver.load(checkpointFile);
    assert.equal(await reloaded.getTuple({ configurable: { thread_id: "wipe" } }), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("parseGraphCliArgs validates thread id and resume sources", () => {
  assert.throws(() => parseGraphCliArgs([]), /thread-id-required/);
  assert.throws(
    () => parseGraphCliArgs(["--thread-id", "t", "--resume-json", "{}", "--resume-file", "x"]),
    /resume-source-conflict/,
  );
  assert.throws(
    () => parseGraphCliArgs(["--thread-id", "t", "--existing-worktree", "foo"]),
    /invalid-flag-value:--existing-worktree:foo/,
  );
  const options = parseGraphCliArgs([
    "--thread-id",
    "t",
    "--issues",
    "1,2",
    "--existing-worktree",
    "3",
    "--auto-assign",
  ]);
  assert.deepEqual(options.issues, ["1", "2"]);
  assert.deepEqual(options.existingWorktrees, [3]);
  assert.equal(options.autoAssign, true);
});

test("classifies failure taxonomy into recoverable and unrecoverable reasons", async () => {
  const { classifyFailure, FAILURE_TAXONOMY, FAILURE_TRANSITIONS, idempotencyKey } =
    await import("../../scripts/project-issue-graph.mjs");
  assert.equal(classifyFailure("timeout").recoverable, true);
  assert.equal(classifyFailure("session-limit").recoverable, true);
  assert.equal(classifyFailure("provider-unavailable").recoverable, true);
  assert.equal(classifyFailure("worker-crashed").recoverable, true);
  assert.equal(classifyFailure("auth-failed").recoverable, false);
  assert.equal(classifyFailure("policy-blocked").recoverable, false);
  assert.equal(classifyFailure("invalid-input").recoverable, false);

  assert.deepEqual(Array.from(FAILURE_TRANSITIONS.running), ["retrying", "handing_off", "failed"]);
  assert.equal(idempotencyKey(1, "dispatch", 1), "issue-1:dispatch:1");
});

/* ------------------------------------------------------------------ */
/* Role programs (#482)                                                */
/* ------------------------------------------------------------------ */

const roleInput = (items, config = {}) => makeInput({ items, config: { singleWorker: false, ...config } });

test("a role program dispatches the implementer, then the reviewer on a different route", async () => {
  const run = makeRun();
  await run.invoke(roleInput([item(1)]));

  const implementer = run.deps.dispatched.at(-1);
  assert.equal(implementer.role, "implementer");
  assert.equal(implementer.skill, "issue-implementation");
  assert.equal(implementer.executionMode, "direct-review");

  await run.resume({ type: "role-complete", issue: 1, role: "implementer" });
  const reviewer = run.deps.dispatched.at(-1);
  assert.equal(reviewer.role, "reviewer");
  assert.equal(reviewer.reviewPass, 1);
  // A reviewer runs no implementation skill; it enters the existing worktree
  // read-only.
  assert.equal(Object.hasOwn(reviewer, "skill"), false);
  // Independent review means a different runtime.
  assert.notEqual(reviewer.route.agent, implementer.route.agent);

  await run.resume({ type: "role-complete", issue: 1, role: "reviewer", verdict: "PASS" });
  const result = await run.resume({ accepted: true });
  assert.deepEqual(result.summary.milestones, [{ issue: 1, type: "pr-created" }]);
  assert.deepEqual(result.summary.completed, [1]);
  assert.deepEqual(result.summary.roles, [
    { issue: 1, executionMode: "direct-review", role: null, status: "awaiting-milestone", reviewPasses: 1 },
  ]);
});

test("a plan-implement-review Issue runs the planner before the implementer", async () => {
  const run = makeRun();
  await run.invoke(roleInput([item(1, [], { size: "XL" })]));
  const planner = run.deps.dispatched.at(-1);
  assert.equal(planner.role, "planner");
  assert.equal(planner.executionMode, "plan-implement-review");

  await run.resume({ type: "role-complete", issue: 1, role: "planner" });
  const implementer = run.deps.dispatched.at(-1);
  assert.equal(implementer.role, "implementer");
  // The planner already created the worktree.
  assert.equal(implementer.skill, "handoff-issue");
});

test("a milestone reported while the role program is still running is rejected", async () => {
  const run = makeRun();
  await run.invoke(roleInput([item(1)]));
  await run.resume({ type: "milestone", issue: 1, milestone: "pr-created" });
  const state = await run.state();
  assert.equal(state.lastEventError, "role-program-active:1:implementer");
  assert.deepEqual(state.milestones, []);
  assert.deepEqual(state.completed, []);
});

test("NEEDS_REVISION buys one fix pass, and the second rejection blocks the Issue", async () => {
  const run = makeRun();
  await run.invoke(roleInput([item(1)]));
  await run.resume({ type: "role-complete", issue: 1, role: "implementer" });
  await run.resume({ type: "role-complete", issue: 1, role: "reviewer", verdict: "NEEDS_REVISION" });

  const fix = run.deps.dispatched.at(-1);
  assert.equal(fix.role, "implementer");
  assert.equal(fix.skill, "handoff-issue");

  await run.resume({ type: "role-complete", issue: 1, role: "implementer" });
  assert.equal(run.deps.dispatched.at(-1).reviewPass, 2);

  const dispatchesBefore = run.deps.dispatched.length;
  const result = await run.resume({
    type: "role-complete",
    issue: 1,
    role: "reviewer",
    verdict: "NEEDS_REVISION",
  });
  assert.equal(result.runStatus, "blocked");
  assert.equal(run.deps.dispatched.length, dispatchesBefore, "no third review pass");
  assert.deepEqual(result.summary.milestones, []);
  assert.equal(result.summary.roles[0].status, "blocked");
});

test("an interrupted reviewer resumes as the reviewer on another verified route", async () => {
  const run = makeRun();
  await run.invoke(roleInput([item(1)]));
  await run.resume({ type: "role-complete", issue: 1, role: "implementer" });
  const reviewer = run.deps.dispatched.at(-1);

  await run.resume({ type: "worker-interrupted", issue: 1, reason: "session-limit" });
  const handoff = run.deps.dispatched.at(-1);
  assert.equal(handoff.role, "reviewer");
  // Still a reviewer after the handoff, so still no implementation skill.
  assert.equal(Object.hasOwn(handoff, "skill"), false);
  assert.notEqual(handoff.route.agent, reviewer.route.agent);
  const state = await run.state();
  assert.equal(state.workerExecutions[0].worktreeId, "issue-1");
});

test("mode telemetry is emitted once, at release, with labels and counters only", async () => {
  const run = makeRun();
  await run.invoke(roleInput([item(1)]));
  await run.resume({ type: "role-complete", issue: 1, role: "implementer" });
  await run.resume({ type: "role-complete", issue: 1, role: "reviewer", verdict: "PASS" });
  // The gate may still send the program back, so nothing terminal is recorded
  // until the Issue is actually released.
  assert.deepEqual((await run.state()).modeTelemetry, []);

  await run.resume({ accepted: true });
  const state = await run.state();
  assert.equal(state.modeTelemetry.length, 1);
  const record = state.modeTelemetry[0];
  assert.equal(record.issueNumber, 1);
  assert.equal(record.mode, "direct-review");
  assert.equal(record.outcome, "released");
  assert.equal(record.selectionReason, "deterministic-policy");
  assert.equal(record.reviewPasses, 1);
  assert.deepEqual(Object.keys(record.routes.implementer).sort(), ["agent", "model"]);
  const serialized = JSON.stringify(state.modeTelemetry);
  for (const forbidden of ["selector", "prompt", "diff", "body"])
    assert.equal(serialized.includes(forbidden), false, `telemetry leaked ${forbidden}`);
});

test("single-worker mode dispatches one roleless worker per Issue", async () => {
  const run = makeRun();
  await run.invoke(makeInput({ items: [item(1)] }));
  assert.equal(run.deps.dispatched.at(-1).role, undefined);
  const state = await run.state();
  assert.deepEqual(state.roleStates, []);
  await run.resume({ type: "milestone", issue: 1, milestone: "pr-created" });
  const result = await run.resume({ accepted: true });
  assert.deepEqual(result.summary.completed, [1]);
});

test("an integration-gate rejection sends the Issue back to the implementer", async () => {
  const run = makeRun();
  await run.invoke(roleInput([item(1)]));
  await run.resume({ type: "role-complete", issue: 1, role: "implementer" });
  await run.resume({ type: "role-complete", issue: 1, role: "reviewer", verdict: "PASS" });

  await run.resume({ accepted: false, reason: "conflicts-with-other-issues-in-run" });
  const fix = run.deps.dispatched.at(-1);
  assert.equal(fix.role, "implementer");
  assert.equal(fix.skill, "handoff-issue");
  const state = await run.state();
  assert.deepEqual(state.milestones, []);
  assert.deepEqual(state.completed, []);
  assert.equal(state.roleStates[0].fixCycles, 1);
});

test("a role whose recorded route left the pool is re-picked from what remains", async () => {
  const run = makeRun();
  await run.invoke(roleInput([item(1)]));
  const implementer = run.deps.dispatched.at(-1);
  // Interrupting the implementer excludes its agent for the rest of the run;
  // the reviewer route recorded at program start may be the one left.
  await run.resume({ type: "worker-interrupted", issue: 1, reason: "session-limit" });
  await run.resume({ type: "role-complete", issue: 1, role: "implementer" });

  const reviewer = run.deps.dispatched.at(-1);
  assert.equal(reviewer.role, "reviewer");
  const state = await run.state();
  assert.deepEqual(state.unavailableAgents, [implementer.route.agent]);
  assert.notEqual(reviewer.route.agent, implementer.route.agent);
});

test("route identity survives a checkpoint round-trip", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "graph-roles-"));
  try {
    const checkpointFile = path.join(directory, "run.json");
    const deps = makeDeps();
    const first = makeRun({ deps, checkpointer: await FileCheckpointSaver.load(checkpointFile) });
    await first.invoke(roleInput([item(1)]));
    const implementer = deps.dispatched.at(-1);
    assert.equal(implementer.role, "implementer");

    // A fresh saver reloads state from disk, so the role's recorded routes
    // come back as new objects: distinctness must hold on labels, not on
    // object identity.
    const second = makeRun({ deps, checkpointer: await FileCheckpointSaver.load(checkpointFile) });
    const reloaded = await second.state();
    assert.equal(reloaded.roleStates.length, 1, "state came back from disk");
    assert.notEqual(reloaded.roleStates[0].routes.implementer, implementer.route);

    await second.resume({ type: "role-complete", issue: 1, role: "implementer" });
    const reviewer = deps.dispatched.at(-1);
    assert.equal(reviewer.role, "reviewer");
    assert.notEqual(reviewer.route.agent, implementer.route.agent);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a role program completes under --release-policy merged instead of dead-ending", async () => {
  const run = makeRun();
  await run.invoke(roleInput([item(1)], { releasePolicy: "merged" }));
  await run.resume({ type: "role-complete", issue: 1, role: "implementer" });
  await run.resume({ type: "role-complete", issue: 1, role: "reviewer", verdict: "PASS" });

  // pr-created passes the gate but does not release under this policy: the
  // run must stay waitable for the external merge event, not summarize.
  const afterPrCreated = await run.resume({ accepted: true });
  assert.equal(isInterrupted(afterPrCreated), true);
  const waiting = await run.state();
  assert.deepEqual(waiting.milestones, [{ issue: 1, type: "pr-created" }]);
  assert.deepEqual(waiting.completed, []);

  await run.resume({ type: "milestone", issue: 1, milestone: "merged" });
  const result = await run.resume({ accepted: true });
  assert.equal(result.runStatus, "complete");
  assert.deepEqual(result.summary.completed, [1]);
});

test("an implementer route proposal equal to the reviewer's is rejected on a fix cycle", async () => {
  const run = makeRun();
  await run.invoke(roleInput([item(1)], { autoAssign: false }));
  await run.resume({ assignments: [{ number: 1, agent: "Claude", model: "sonnet" }] });
  await run.resume({ type: "role-complete", issue: 1, role: "implementer" });
  await run.resume({ assignments: [{ number: 1, agent: "Grok", model: "grok-4" }] });
  await run.resume({ type: "role-complete", issue: 1, role: "reviewer", verdict: "NEEDS_REVISION" });

  // The fix pass must not move the implementer onto the reviewer's runtime.
  const rejected = await run.resume({ assignments: [{ number: 1, agent: "Grok", model: "grok-4" }] });
  assert.equal(isInterrupted(rejected), true);
  assert.equal(
    rejected.__interrupt__[0].value.lastEventError,
    "invalid-assignment:1:implementer-route-not-distinct",
  );
  const accepted = await run.resume({ assignments: [{ number: 1, agent: "Claude", model: "sonnet" }] });
  assert.equal(isInterrupted(accepted), true);
  assert.equal(run.deps.dispatched.at(-1).role, "implementer");
  assert.equal(run.deps.dispatched.at(-1).route.agent, "Claude");
});

test("a handoff keeps the reviewer off the implementer's route", async () => {
  const run = makeRun();
  await run.invoke({
    ...roleInput([item(1)]),
    // Three worker routes remain after the parent agent is excluded, so a
    // distinct choice still exists once the reviewer's agent drops out.
    capabilities: [...defaultCapabilities, workerRoute("Gemini", "gemini-3")],
  });
  const implementer = run.deps.dispatched.at(-1);
  await run.resume({ type: "role-complete", issue: 1, role: "implementer" });
  const reviewer = run.deps.dispatched.at(-1);

  // Interrupting the reviewer excludes its agent; the replacement must still
  // differ from the implementer's route, not just fall back to pool[0].
  await run.resume({ type: "worker-interrupted", issue: 1, reason: "timeout" });
  const handoff = run.deps.dispatched.at(-1);
  assert.equal(handoff.role, "reviewer");
  assert.notEqual(handoff.route.agent, reviewer.route.agent);
  assert.notEqual(handoff.route.agent, implementer.route.agent);
});

test("a handoff with no distinct route left shares one and records the degradation", async () => {
  const run = makeRun();
  await run.invoke(roleInput([item(1)]));
  const implementer = run.deps.dispatched.at(-1);
  await run.resume({ type: "role-complete", issue: 1, role: "implementer" });

  // Only two worker routes exist here, so excluding the reviewer's agent
  // leaves the implementer's route as the single option: continue on it
  // rather than failing the run, and say so.
  await run.resume({ type: "worker-interrupted", issue: 1, reason: "timeout" });
  const handoff = run.deps.dispatched.at(-1);
  assert.equal(handoff.role, "reviewer");
  assert.equal(handoff.route.agent, implementer.route.agent);
  const state = await run.state();
  assert.equal(state.roleStates[0].degraded, "same-route:reviewer:no-distinct-route-left");
});

test("malformed role-complete events are rejected without touching state", async () => {
  const run = makeRun();
  await run.invoke(roleInput([item(1)]));
  const before = await run.state();

  // The event's role must match the running worker's role.
  await run.resume({ type: "role-complete", issue: 1, role: "reviewer", verdict: "PASS" });
  let state = await run.state();
  assert.equal(state.lastEventError, "invalid-event:role-mismatch:1:reviewer");
  assert.deepEqual(state.roleStates, before.roleStates);

  // A reviewer completion needs a valid verdict.
  await run.resume({ type: "role-complete", issue: 1, role: "implementer" });
  await run.resume({ type: "role-complete", issue: 1, role: "reviewer", verdict: "LGTM" });
  state = await run.state();
  assert.equal(state.lastEventError, "invalid-event:invalid-review-verdict:LGTM");
  assert.equal(state.roleStates[0].status, "active");
  assert.equal(state.roleStates[0].reviewPasses, 0);
});

test("a role-complete event in single-worker mode is rejected", async () => {
  const run = makeRun();
  await run.invoke(makeInput({ items: [item(1)] }));
  await run.resume({ type: "role-complete", issue: 1, role: "implementer" });
  const state = await run.state();
  assert.equal(state.lastEventError, "invalid-event:no-role-program:1");
  assert.deepEqual(state.roleStates, []);
  assert.deepEqual(state.milestones, []);
});

test("an interrupted planner is handed off away from the implementer's route", async () => {
  const run = makeRun();
  await run.invoke({
    // A third worker route has to remain after the planner's agent is
    // excluded, otherwise sharing is unavoidable.
    ...roleInput([item(1, [], { size: "XL" })]),
    capabilities: [...defaultCapabilities, workerRoute("Gemini", "gemini-3")],
  });
  const planner = run.deps.dispatched.at(-1);
  assert.equal(planner.role, "planner");
  const state = await run.state();
  const implementerRoute = state.roleStates[0].routes.implementer;

  await run.resume({ type: "worker-interrupted", issue: 1, reason: "timeout" });
  const handoff = run.deps.dispatched.at(-1);
  assert.equal(handoff.role, "planner");
  // Without a planner preference this would fall back to pool[0], which is
  // exactly the implementer's route.
  assert.notEqual(handoff.route.agent, implementerRoute.agent);
  assert.notEqual(handoff.route.agent, planner.route.agent);
});

test("a fix pass tells the implementer a PR already exists", async () => {
  const run = makeRun();
  await run.invoke(roleInput([item(1)]));
  const first = run.deps.dispatched.at(-1);
  // The first pass creates the PR, so it carries no fix cycle.
  assert.equal(first.role, "implementer");
  assert.equal(Object.hasOwn(first, "fixCycle"), false);
  assert.equal(first.skill, "issue-implementation");

  await run.resume({ type: "role-complete", issue: 1, role: "implementer" });
  await run.resume({ type: "role-complete", issue: 1, role: "reviewer", verdict: "NEEDS_REVISION" });

  const fix = run.deps.dispatched.at(-1);
  assert.equal(fix.role, "implementer");
  assert.equal(fix.fixCycle, 1);
  // handoff-issue resumes the worktree; it never opens a second PR.
  assert.equal(fix.skill, "handoff-issue");
  assert.ok(fix.dispatchCommand === undefined || fix.dispatchCommand.includes("--fix-cycle"));
});

test("an interrupted fix pass keeps its fix cycle across the handoff", async () => {
  const run = makeRun();
  await run.invoke(roleInput([item(1)]));
  await run.resume({ type: "role-complete", issue: 1, role: "implementer" });
  await run.resume({ type: "role-complete", issue: 1, role: "reviewer", verdict: "NEEDS_REVISION" });
  await run.resume({ type: "worker-interrupted", issue: 1, reason: "session-limit" });

  const handoff = run.deps.dispatched.at(-1);
  assert.equal(handoff.role, "implementer");
  assert.equal(handoff.fixCycle, 1, "the replacement worker must still know a PR exists");
});

test("a second integration-gate rejection blocks instead of reopening again", async () => {
  const run = makeRun();
  await run.invoke(roleInput([item(1)]));
  await run.resume({ type: "role-complete", issue: 1, role: "implementer" });
  await run.resume({ type: "role-complete", issue: 1, role: "reviewer", verdict: "PASS" });

  // First gate rejection spends the gate's own single reopen.
  await run.resume({ accepted: false, reason: "conflicts-with-other-issues-in-run" });
  let state = await run.state();
  assert.equal(state.roleStates[0].gateReopens, 1);
  assert.equal(state.roleStates[0].status, "active");

  await run.resume({ type: "role-complete", issue: 1, role: "implementer" });
  await run.resume({ type: "role-complete", issue: 1, role: "reviewer", verdict: "PASS" });
  const result = await run.resume({ accepted: false, reason: "conflicts-with-other-issues-in-run" });

  assert.equal(result.runStatus, "blocked");
  state = await run.state();
  assert.equal(state.roleStates[0].status, "blocked");
  assert.equal(state.roleStates[0].blockedReason, "integration-gate-rejected-twice");
  assert.deepEqual(state.milestones, []);
  assert.deepEqual(state.completed, []);
});

test("a role-program dispatch failure hands off with the worktree-creating skill", async () => {
  let failNext = true;
  const deps = makeDeps({
    dispatch: async (job) => {
      deps.dispatched.push(job);
      if (failNext) {
        failNext = false;
        throw new Error("cli-not-found");
      }
      return { pid: 9100 + deps.dispatched.length };
    },
  });
  const run = makeRun({ deps });
  await run.invoke(roleInput([item(1)]));

  const handoff = deps.dispatched.at(-1);
  assert.equal(handoff.role, "implementer");
  // The failed attempt never started a worker, so no worktree exists yet:
  // the replacement must create one rather than resume a missing tree.
  assert.equal(handoff.skill, "issue-implementation");
  const state = await run.state();
  assert.deepEqual(state.unavailableModels, [deps.dispatched[0].route.model]);
  assert.deepEqual(state.unavailableAgents, []);
});

test("a dispatch failure keeps another verified model from the same agent usable", async () => {
  const invalidated = [];
  let failNext = true;
  const deps = makeDeps({
    invalidateCapabilities: async (agent) => invalidated.push(agent),
    dispatch: async (job) => {
      deps.dispatched.push(job);
      if (failNext) {
        failNext = false;
        throw new Error("model-credit-unavailable");
      }
      return { pid: 9200 + deps.dispatched.length };
    },
  });
  const capabilities = [
    parentRecord,
    workerRoute("Claude", "claude-sonnet"),
    workerRoute("Claude", "claude-fable"),
  ];
  const run = makeRun({ deps });
  await run.invoke({ ...roleInput([item(1)]), capabilities });

  const state = await run.state();
  const failedModel = deps.dispatched[0].route.model;
  assert.deepEqual(state.unavailableModels, [failedModel]);
  assert.deepEqual(invalidated, ["Claude"]);
  assert.equal(deps.dispatched.at(-1).route.agent, "Claude");
  assert.notEqual(deps.dispatched.at(-1).route.model, failedModel);
});

test("a dispatch failure fails closed when its capability cache cannot be invalidated", async () => {
  const deps = makeDeps({
    invalidateCapabilities: async () => {
      throw new Error("cache-read-only");
    },
    dispatch: async () => {
      throw new Error("model-mismatch");
    },
  });
  const run = makeRun({ deps });
  const result = await run.invoke(makeInput({ items: [item(1)] }));

  assert.equal(result.runStatus, "failed");
  assert.equal(result.failureReason, "capability-invalidation-failed:cache-read-only");
  assert.deepEqual(result.unavailableModels, ["sonnet"]);
});

test("two pool records for one runtime do not count as distinct routes", async () => {
  // Same agent+model, different selector: the selector is an invocation
  // detail, so these are one runtime and independent review is impossible.
  const oneRuntime = [
    parentRecord,
    { ...workerRoute("Claude", "sonnet"), selector: "sel sonnet --a" },
    { ...workerRoute("Claude", "sonnet"), selector: "sel sonnet --b" },
  ];
  const run = makeRun();
  await run.invoke({ ...roleInput([item(1)]), capabilities: oneRuntime });
  const state = await run.state();
  // The collapse must be detected and recorded, not pass silently as two
  // "distinct" routes just because the selectors differ.
  assert.match(state.roleStates[0].degraded, /^same-route:\w+:no-distinct-route-left$/);

  await run.resume({ type: "role-complete", issue: 1, role: "implementer" });
  const implementer = run.deps.dispatched[0];
  const reviewer = run.deps.dispatched.at(-1);
  assert.equal(reviewer.role, "reviewer");
  assert.equal(reviewer.route.agent, implementer.route.agent);
  assert.equal(reviewer.route.model, implementer.route.model);
});

test("a blocked run reports why in the summary", async () => {
  const run = makeRun();
  await run.invoke(roleInput([item(1)]));
  await run.resume({ type: "role-complete", issue: 1, role: "implementer" });
  const result = await run.resume({ type: "role-complete", issue: 1, role: "reviewer", verdict: "REJECTED" });
  assert.equal(result.runStatus, "blocked");
  assert.deepEqual(result.summary.roles, [
    {
      issue: 1,
      executionMode: "direct-review",
      role: null,
      status: "blocked",
      reviewPasses: 1,
      blockedReason: "review-rejected",
    },
  ]);
});
