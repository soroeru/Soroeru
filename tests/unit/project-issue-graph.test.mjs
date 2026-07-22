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
const defaultCapabilities = [parentRecord, workerRoute("Codex", "gpt-5"), workerRoute("Claude", "sonnet")];

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
  const result = await run.invoke(
    makeInput({ items: [item(1)], capabilities: [parentRecord] }),
  );
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
  const result = await run.invoke(
    makeInput({ items: [item(1)], config: { unavailableAgents: ["Codex"] } }),
  );
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
  assert.deepEqual(
    payload.assign.workerRoutes,
    [
      { agent: "Codex", model: "gpt-5" },
      { agent: "Claude", model: "sonnet" },
    ],
  );
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
  const accepted = await run.resume({ assignments: [{ number: 1, agent: "Codex", model: "gpt-5" }] });
  assert.equal(isInterrupted(accepted), true);
  assert.deepEqual(run.deps.dispatched.map(({ issueNumber }) => issueNumber), [1]);
});

test("schedules dependent Issues only after the release milestone passes the gate", async () => {
  const run = makeRun();
  let result = await run.invoke(makeInput({ items: [item(1), item(2, [1])] }));
  assert.deepEqual(run.deps.dispatched.map(({ issueNumber }) => issueNumber), [1]);

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
  assert.deepEqual(run.deps.dispatched.map(({ issueNumber }) => issueNumber), [1, 2]);

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
  assert.deepEqual(run.deps.dispatched.map(({ issueNumber }) => issueNumber), [1]);
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
  assert.deepEqual(run.deps.dispatched.map(({ issueNumber }) => issueNumber), [1, 2]);
  assert.deepEqual((await run.state()).completed, [1]);
});

test("merged release policy completes only on merged", async () => {
  const run = makeRun();
  await run.invoke(makeInput({ items: [item(1), item(2, [1])], config: { releasePolicy: "merged" } }));
  await run.resume({ type: "milestone", issue: 1, milestone: "pr-created" });
  let result = await run.resume({ accepted: true });
  // pr-created accepted but policy is merged: dependent not released.
  assert.deepEqual(run.deps.dispatched.map(({ issueNumber }) => issueNumber), [1]);
  const midState = await run.state();
  assert.deepEqual(midState.completed, []);
  assert.equal(midState.workerExecutions[0].expectedMilestone, "merged");

  await run.resume({ type: "milestone", issue: 1, milestone: "merged" });
  result = await run.resume({ accepted: true });
  assert.deepEqual(run.deps.dispatched.map(({ issueNumber }) => issueNumber), [1, 2]);
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
  assert.equal(before.workerExecutions[0].agent, "Codex");
  assert.equal(before.workerExecutions[0].worktreeId, "issue-1");

  const result = await run.resume({ type: "worker-interrupted", issue: 1, reason: "timeout" });
  assert.equal(isInterrupted(result), true);
  const state = await run.state();
  assert.deepEqual(state.unavailableAgents, ["Codex"]);
  const execution = state.workerExecutions[0];
  assert.equal(execution.agent, "Claude");
  assert.equal(execution.mode, "handoff-issue");
  assert.equal(execution.attempt, 2);
  assert.equal(execution.worktreeId, "issue-1");
  assert.equal(run.deps.dispatched.at(-1).mode, "handoff-issue");
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
    .invoke(makeInput({ items: [item(1)], capabilities: [parentRecord, workerRoute("Codex", "gpt-5")] }))
    .then(() => run.resume({ type: "worker-interrupted", issue: 1, reason: "timeout" }));
  assert.equal(result.runStatus, "failed");
  assert.equal(result.failureReason, "no-worker-route-available:handoff:1");
  // The interrupted worktree is untouched: no further dispatch happened.
  assert.equal(run.deps.dispatched.length, 1);
});

test("a route failing at dispatch time is excluded and the Issue handed off", async () => {
  const deps = makeDeps({
    dispatch: async (job) => {
      if (job.route.agent === "Codex") throw new Error("model-mismatch");
      deps.dispatched.push(job);
      return { pid: 9100 };
    },
  });
  const run = makeRun({ deps });
  const result = await run.invoke(makeInput({ items: [item(1)] }));
  assert.equal(isInterrupted(result), true);
  const state = await run.state();
  assert.deepEqual(state.unavailableAgents, ["Codex"]);
  assert.equal(state.workerExecutions[0].agent, "Claude");
  // The failed dispatch never started a worker, so no worktree exists yet:
  // the retry keeps the mode that attempt was going to use.
  assert.equal(state.workerExecutions[0].mode, "issue-implementation");
});

test("an interrupted worker with a pre-existing worktree hands off in handoff-issue mode", async () => {
  const run = makeRun();
  await run.invoke(makeInput({ items: [item(1)] }));
  await run.resume({ type: "worker-interrupted", issue: 1, reason: "session-limit" });
  const state = await run.state();
  assert.equal(state.workerExecutions[0].mode, "handoff-issue");
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
  assert.equal(state.workerExecutions[0].agent, "Codex");
  assert.equal(state.workerExecutions[0].mode, "handoff-issue");
  assert.equal(state.workerExecutions[0].attempt, 2);
});

test("a check with live workers keeps waiting without changes", async () => {
  const run = makeRun();
  await run.invoke(makeInput({ items: [item(1)] }));
  const result = await run.resume({ type: "check" });
  assert.equal(isInterrupted(result), true);
  const state = await run.state();
  assert.equal(state.workerExecutions[0].agent, "Codex");
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
  assert.equal(
    await probeProcess({ pid: child.pid, startedAt: dispatchRecordedAt }),
    "mismatch",
  );
  assert.equal(await probeProcess({ startedAt: dispatchRecordedAt }), "unknown");

  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(
    await probeProcess({ pid: child.pid, pidReportedAt: new Date().toISOString() }),
    "dead",
  );
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
  assert.deepEqual(run.deps.dispatched.map(({ issueNumber }) => issueNumber), [1]);
  await run.resume({ type: "milestone", issue: 1, milestone: "pr-created" });
  await run.resume({ accepted: true });
  assert.deepEqual(run.deps.dispatched.map(({ issueNumber }) => issueNumber), [1, 2]);
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
    ["assignments", "blocked", "completed", "milestones", "routing", "runnable", "skipped", "usage", "runStatus"].sort(),
  );
  assert.deepEqual(result.summary.assignments, [{ number: 1, agent: "Codex", model: "gpt-5" }]);
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
    assert.deepEqual(first.deps.dispatched.map(({ issueNumber }) => issueNumber), [1]);

    // Simulate a restart: a fresh saver instance hydrated from disk.
    const second = makeRun({
      checkpointer: await FileCheckpointSaver.load(checkpointFile),
      threadId: "restart",
    });
    await second.resume({ type: "milestone", issue: 1, milestone: "pr-created" });
    const result = await second.resume({ accepted: true });
    assert.equal(isInterrupted(result), true);
    assert.deepEqual(second.deps.dispatched.map(({ issueNumber }) => issueNumber), [2]);
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
      capabilities: [parentRecord, workerRoute("Codex", "gpt-5")],
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

    const resumeArgs = (event) => [
      script,
      "--thread-id",
      "cli-run",
      "--checkpoint-file",
      checkpointFile,
      "--resume-json",
      JSON.stringify(event),
    ];
    await execFileAsync(process.execPath, resumeArgs({ type: "milestone", issue: 1, milestone: "pr-created" }));
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
