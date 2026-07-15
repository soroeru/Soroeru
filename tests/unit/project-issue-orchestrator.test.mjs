import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  applyMilestone,
  buildRunPlan,
  buildUsageReport,
  fetchProjectItems,
  githubGraphql,
  parseCliArgs,
  parseImplementationAssignment,
  parseProjectItems,
  runOrchestration,
  selectProjectConfig,
  validateCapabilities,
  validateProjectItems,
} from "../../scripts/project-issue-orchestrator.mjs";

const fixtures = new URL("../fixtures/project-issue-orchestrator/", import.meta.url);
const load = async (name) => JSON.parse(await readFile(new URL(name, fixtures), "utf8"));
const runOptions = {
  maxParallel: 3,
  releasePolicy: "merged",
  runDate: "2026-07-20",
  aiSubAssignees: { Codex: "Claude", Claude: "Codex" },
  parent: { provider: "Codex", model: "gpt-5" },
  capabilities: [
    ...["parent", "worker"].map((role) => ({
      provider: "Codex",
      model: "gpt-5",
      role,
      selector: "test-selector",
      selectable: true,
      verifiable: true,
      timeoutMs: 60_000,
    })),
    {
      provider: "Claude",
      model: "sonnet",
      role: "worker",
      selector: "test-selector",
      selectable: true,
      verifiable: true,
      timeoutMs: 60_000,
    },
  ],
};
const usage = {
  inputTokens: 12,
  cachedInputTokens: 2,
  outputTokens: 3,
  toolCalls: 4,
  waitCalls: 5,
  wallClockMs: 600,
  fetchedBytes: 700,
};
const execFileAsync = promisify(execFile);

test("schedules A then B then C as dependencies complete", async () => {
  const items = parseProjectItems((await load("linear.json")).items);
  assert.deepEqual(
    buildRunPlan(items, { ...runOptions, completed: [] }).runnable.map(({ number }) => number),
    [101],
  );
  assert.deepEqual(
    buildRunPlan(items, { ...runOptions, completed: [101] }).runnable.map(({ number }) => number),
    [102],
  );
  assert.deepEqual(
    buildRunPlan(items, { ...runOptions, completed: [101, 102] }).runnable.map(({ number }) => number),
    [103],
  );
});

test("schedules both branches after their shared dependency completes", async () => {
  const items = parseProjectItems((await load("branching.json")).items);
  assert.deepEqual(
    buildRunPlan(items, { ...runOptions, completed: [201] }).runnable.map(({ number }) => number),
    [202, 203],
  );
});

test("rejects an unknown dependency before scheduling", async () => {
  const input = (await load("linear.json")).items;
  input[1].dependencies = [999];
  assert.throws(() => validateProjectItems(parseProjectItems(input)), /unknown-dependency:102:999/);
});

test("rejects a dependency cycle before scheduling", async () => {
  const input = (await load("linear.json")).items;
  input[0].dependencies = [103];
  assert.throws(() => validateProjectItems(parseProjectItems(input)), /dependency-cycle/);
});

for (const field of ["primary", "sub", "model"]) {
  test(`rejects missing ${field} assignment before scheduling`, async () => {
    const input = (await load("linear.json")).items;
    delete input[0][field];
    assert.throws(() => parseProjectItems(input), new RegExp(`missing-${field}:101`));
  });
}

test("rejects a missing or invalid implementation order", async () => {
  const input = (await load("linear.json")).items;
  delete input[0].order;
  assert.throws(() => parseProjectItems(input), /missing-order:101/);
  input[0].order = 0;
  assert.throws(() => parseProjectItems(input), /invalid-order:101/);
});

test("temporarily unavailable models block only their issues and recover on the next run", async () => {
  const items = parseProjectItems((await load("branching.json")).items);
  const unavailable = buildRunPlan(items, {
    ...runOptions,
    completed: [201],
    unavailableModels: ["sonnet"],
  });
  assert.deepEqual(
    unavailable.runnable.map(({ number }) => number),
    [203],
  );
  assert.deepEqual(unavailable.blocked, [{ number: 202, reason: "model-unavailable:sonnet" }]);
  assert.deepEqual(
    buildRunPlan(items, { ...runOptions, completed: [201] }).runnable.map(({ number }) => number),
    [202, 203],
  );
});

test("routes an existing Issue worktree through handoff-issue", async () => {
  const items = parseProjectItems((await load("linear.json")).items);
  const plan = buildRunPlan(items, { ...runOptions, completed: [], existingWorktrees: [101] });
  assert.equal(plan.runnable[0].route, "handoff-issue");
});

test("milestones create resumable state without carrying implementation logs", () => {
  const state = applyMilestone(
    {},
    {
      issue: 101,
      type: "merged",
      usage,
      log: "secret implementation log",
    },
    { issueNumbers: [101], releasePolicy: "merged" },
  );
  assert.deepEqual(state, {
    completed: [101],
    milestones: [{ issue: 101, type: "merged" }],
    usage: { 101: usage },
  });
});

test("reports the complete usage schema and marks a mixed total as partial", () => {
  assert.deepEqual(buildUsageReport({ 101: usage }, [101, 102]), {
    issues: [
      { number: 101, usage },
      { number: 102, usage: "unavailable" },
    ],
    total: { status: "partial", availableIssues: [101], unavailableIssues: [102], usage },
  });
});

test("dry-run returns a plan without writing state", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "soroeru-orchestrator-"));
  const statePath = path.join(directory, "state.json");
  await writeFile(statePath, '{"sentinel":true}\n');
  const input = await load("linear.json");
  const before = await readFile(statePath, "utf8");

  const result = await runOrchestration({
    ...input,
    options: { ...runOptions, dryRun: true, statePath },
    milestone: { issue: 101, type: "merged" },
  });

  assert.equal(result.dryRun, true);
  assert.equal(await readFile(statePath, "utf8"), before);
});

test("execute mode persists milestone state", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "soroeru-orchestrator-"));
  const statePath = path.join(directory, "state.json");
  const input = await load("linear.json");
  await runOrchestration({
    ...input,
    options: { ...runOptions, dryRun: false, statePath },
    milestone: { issue: 101, type: "merged" },
  });
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.deepEqual(state.completed, [101]);
});

test("concurrent milestone transactions preserve both events and usage records", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "soroeru-orchestrator-concurrent-"));
  const statePath = path.join(directory, "state.json");
  const input = await load("linear.json");
  const secondUsage = { ...usage, inputTokens: 99 };
  await Promise.all([
    runOrchestration({
      ...input,
      options: { ...runOptions, dryRun: false, statePath },
      milestone: { issue: 101, type: "merged", usage },
    }),
    runOrchestration({
      ...input,
      options: { ...runOptions, dryRun: false, statePath },
      milestone: { issue: 102, type: "merged", usage: secondUsage },
    }),
  ]);
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.deepEqual(state.completed, [101, 102]);
  assert.deepEqual(
    [...state.milestones].sort((left, right) => left.issue - right.issue),
    [
      { issue: 101, type: "merged" },
      { issue: 102, type: "merged" },
    ],
  );
  assert.deepEqual(state.usage, { 101: usage, 102: secondUsage });
});

test("reclaims a stale state lock left by a crashed process", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "soroeru-orchestrator-stale-lock-"));
  const statePath = path.join(directory, "state.json");
  const lockPath = `${statePath}.lock`;
  await mkdir(lockPath);
  const stale = new Date(Date.now() - 60_000);
  await utimes(lockPath, stale, stale);
  const input = await load("linear.json");
  const result = await runOrchestration({
    ...input,
    options: { ...runOptions, dryRun: false, statePath },
    milestone: { issue: 101, type: "merged", usage },
  });
  assert.deepEqual(result.state.completed, [101]);
});

test("requires maxParallel to be a positive integer and limits the runnable group", async () => {
  const items = parseProjectItems((await load("branching.json")).items);
  for (const maxParallel of [undefined, 0, -1, 1.5])
    assert.throws(
      () => buildRunPlan(items, { ...runOptions, maxParallel, completed: [201] }),
      /invalid-max-parallel/,
    );
  assert.deepEqual(
    buildRunPlan(items, { ...runOptions, maxParallel: 1, completed: [201] }).runnable.map(
      ({ number }) => number,
    ),
    [202],
  );
});

test("requires a release policy and completes only its matching milestone", async () => {
  const items = parseProjectItems((await load("linear.json")).items);
  assert.throws(
    () => buildRunPlan(items, { ...runOptions, releasePolicy: undefined }),
    /invalid-release-policy/,
  );
  assert.throws(
    () => buildRunPlan(items, { ...runOptions, releasePolicy: "deployed" }),
    /invalid-release-policy/,
  );
  const issueNumbers = items.map(({ number }) => number);
  const afterPr = applyMilestone(
    {},
    { issue: 101, type: "pr-created" },
    { issueNumbers, releasePolicy: "merged" },
  );
  assert.deepEqual(afterPr.completed, []);
  const afterMerge = applyMilestone(
    afterPr,
    { issue: 101, type: "merged" },
    { issueNumbers, releasePolicy: "merged" },
  );
  assert.deepEqual(afterMerge.completed, [101]);
});

test("does not infer completion from Project status text", async () => {
  const raw = (await load("linear.json")).items;
  raw[0].status = "Done";
  const plan = buildRunPlan(parseProjectItems(raw), runOptions);
  assert.deepEqual(plan.runnable, []);
  assert.deepEqual(plan.skipped, [{ number: 101, reason: "status-not-runnable:Done" }]);
});

test("propagates unavailable model blockage to dependents", async () => {
  const items = parseProjectItems((await load("linear.json")).items);
  const plan = buildRunPlan(items, { ...runOptions, unavailableModels: ["gpt-5"] });
  assert.deepEqual(plan.blocked, [
    { number: 101, reason: "model-unavailable:gpt-5" },
    { number: 102, reason: "dependency-blocked:101" },
    { number: 103, reason: "dependency-blocked:102" },
  ]);
});

test("rejects milestones for unknown issues and types outside the allowlist", () => {
  const context = { issueNumbers: [101], releasePolicy: "merged" };
  assert.throws(
    () => applyMilestone({}, { issue: 999, type: "merged" }, context),
    /unknown-milestone-issue:999/,
  );
  assert.throws(
    () => applyMilestone({}, { issue: 101, type: "completed" }, context),
    /invalid-milestone-type:completed/,
  );
});

test("blocks issues whose start date is after the run date", async () => {
  const items = parseProjectItems((await load("linear.json")).items);
  const plan = buildRunPlan(items, { ...runOptions, runDate: "2026-07-14" });
  assert.deepEqual(plan.blocked[0], { number: 101, reason: "start-date-in-future:2026-07-15" });
});

test("rejects impossible item and run dates instead of accepting date-shaped strings", async () => {
  const raw = (await load("linear.json")).items;
  raw[0].startDate = "2026-02-30";
  assert.throws(() => parseProjectItems(raw), /invalid-start-date:101/);
  const items = parseProjectItems((await load("linear.json")).items);
  assert.throws(() => buildRunPlan(items, { ...runOptions, runDate: "2026-02-30" }), /invalid-run-date/);
});

test("treats Fable as an ordinary model name", async () => {
  const raw = (await load("linear.json")).items;
  raw[0].model = "Fable";
  const plan = buildRunPlan(parseProjectItems(raw), runOptions);
  assert.equal(plan.runnable[0].model, "Fable");
});

test("requires selectable, verifiable, bounded capability records for parent and workers", () => {
  const required = [
    { provider: "Claude", model: "Fable", role: "parent" },
    { provider: "Claude", model: "Fable", role: "worker" },
  ];
  const capabilities = required.map((route) => ({
    ...route,
    selector: "runtime-specific",
    selectable: true,
    verifiable: true,
    timeoutMs: 60_000,
  }));
  assert.deepEqual(validateCapabilities(required, capabilities), capabilities);
  assert.throws(
    () => validateCapabilities(required, [{ ...capabilities[0], verifiable: false }, capabilities[1]]),
    /routing-unavailable:parent:Claude:Fable/,
  );
});

test("run orchestration blocks before planning when a required worker capability is unverified", async () => {
  const input = await load("linear.json");
  input.options = {
    ...runOptions,
    capabilities: runOptions.capabilities.filter(
      (capability) => !(capability.role === "worker" && capability.model === "gpt-5"),
    ),
  };
  await assert.rejects(runOrchestration(input), /routing-unavailable:worker:Codex:gpt-5/);
});

test("validates workers only for runnable issues after persisting a completing milestone", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "soroeru-orchestrator-capability-"));
  const statePath = path.join(directory, "state.json");
  const input = await load("linear.json");
  const parentOnly = runOptions.capabilities.filter((capability) => capability.role === "parent");
  const result = await runOrchestration({
    ...input,
    options: {
      ...runOptions,
      dryRun: false,
      statePath,
      runDate: "2026-07-14",
      unavailableModels: ["sonnet"],
      capabilities: parentOnly,
    },
    milestone: { issue: 101, type: "merged", usage },
  });
  assert.deepEqual(result.state.completed, [101]);
  assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")).completed, [101]);
  assert.deepEqual(result.plan.runnable, []);
});

test("CLI rejects unknown flags", async () => {
  const script = new URL("../../scripts/project-issue-orchestrator.mjs", import.meta.url);
  const fixture = new URL("../fixtures/project-issue-orchestrator/linear.json", import.meta.url);
  await assert.rejects(
    execFileAsync(process.execPath, [script.pathname, "--input", fixture.pathname, "--unknown"]),
    ({ stderr }) => stderr.includes("unknown-flag:--unknown"),
  );
});

test("extracts only the bounded implementation assignment metadata", () => {
  const body = `private prose\n<!-- implementation-assignment:start -->\n- Primary: Codex\n- Sub: Claude\n- Model: Fable\n- Order: 7\n- Dependencies: #10, 11\n<!-- implementation-assignment:end -->\nmore private prose`;
  assert.deepEqual(parseImplementationAssignment(body), {
    primary: "Codex",
    sub: "Claude",
    model: "Fable",
    order: 7,
    dependencies: [10, 11],
  });
});

test("extracts the repository's Japanese implementation assignment format", () => {
  const body = `<!-- implementation-assignment:start -->
- 実装順: 01
- 担当: Codex
- モデル: GPT-5.6-Sol
- 前提: #10, #11
<!-- implementation-assignment:end -->`;
  assert.deepEqual(parseImplementationAssignment(body), {
    primary: "Codex",
    sub: undefined,
    model: "GPT-5.6-Sol",
    order: 1,
    dependencies: [10, 11],
  });
});

test("parses ASCII and Japanese dependency separators without silently dropping malformed tokens", () => {
  const body = (dependencies) =>
    `<!-- implementation-assignment:start -->\n- Primary: Codex\n- Sub: Claude\n- Model: Fable\n- Order: 1\n- Dependencies: ${dependencies}\n<!-- implementation-assignment:end -->`;
  assert.deepEqual(parseImplementationAssignment(body("#10, 11、#12")).dependencies, [10, 11, 12]);
  for (const malformed of ["#10, nope", "#10,,#11", "#10、#-2"])
    assert.throws(() => parseImplementationAssignment(body(malformed)), /invalid-dependency-metadata/);
});

test("selects exactly one owner/type/name/number Project configuration", () => {
  const projects = [
    { owner: "octo", ownerType: "user", name: "Visibility", number: 9 },
    { owner: "acme", ownerType: "organization", name: "Visibility", number: 9 },
  ];
  assert.deepEqual(
    selectProjectConfig(projects, {
      owner: "acme",
      ownerType: "organization",
      name: "Visibility",
      number: 9,
    }),
    projects[1],
  );
  assert.throws(
    () => selectProjectConfig(projects, { name: "Visibility", number: 9 }),
    /project-config-ambiguous/,
  );
  assert.throws(
    () =>
      selectProjectConfig([{ ownerType: "user", name: "Visibility", number: 9 }], {
        owner: "octo",
        ownerType: "user",
        name: "Visibility",
        number: 9,
      }),
    /project-config-not-found/,
  );
  assert.throws(
    () => selectProjectConfig(projects, { owner: "octo", ownerType: "team", number: 9 }),
    /invalid-owner-type/,
  );
});

test("rejects a primary and sub assignment that does not match the configured mapping", async () => {
  const input = await load("linear.json");
  input.options = {
    ...runOptions,
    aiSubAssignees: { Codex: "Gemini", Claude: "Codex" },
  };
  await assert.rejects(runOrchestration(input), /ai-sub-assignee-mismatch:101/);
});

test("paginates organization ProjectV2 items and discards Issue bodies from returned metadata", async () => {
  const calls = [];
  const graphql = async (query, variables) => {
    calls.push({ query, variables });
    const secondPage = variables.cursor === "next";
    return {
      organization: {
        projectV2: {
          items: {
            pageInfo: { hasNextPage: !secondPage, endCursor: secondPage ? null : "next" },
            nodes: [
              {
                fieldValues: {
                  nodes: [
                    { field: { name: "Status" }, name: "Ready" },
                    { field: { name: "Start date" }, date: "2026-07-15" },
                  ],
                },
                content: {
                  __typename: "Issue",
                  number: secondPage ? 302 : 301,
                  title: secondPage ? "Second issue" : "Fetched issue",
                  url: `https://example.invalid/issues/${secondPage ? 302 : 301}`,
                  body: "secret\n<!-- implementation-assignment:start -->\n- Primary: Codex\n- Sub: Claude\n- Model: Fable\n- Order: 1\n- Dependencies: none\n<!-- implementation-assignment:end -->",
                },
              },
            ],
          },
        },
      },
    };
  };
  const result = await fetchProjectItems({
    owner: "acme",
    ownerType: "organization",
    projectNumber: 9,
    graphql,
  });
  assert.deepEqual(calls[0].variables, { owner: "acme", number: 9, cursor: null });
  assert.deepEqual(calls[1].variables, { owner: "acme", number: 9, cursor: "next" });
  assert.equal(calls[0].query.includes("body"), true);
  assert.deepEqual(
    result.items.map(({ number }) => number),
    [301, 302],
  );
  assert.equal(result.fetchedBytes > 0, true);
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.equal(
    result.items.some((item) => Object.hasOwn(item, "body")),
    false,
  );
});

test("skips draft, pull request, and non-Issue Project items", async () => {
  const assignment =
    "<!-- implementation-assignment:start -->\n- Primary: Codex\n- Sub: Claude\n- Model: Fable\n- Order: 1\n- Dependencies: none\n<!-- implementation-assignment:end -->";
  const node = (content) => ({
    fieldValues: {
      nodes: [
        { field: { name: "Status" }, name: "Ready" },
        { field: { name: "Start date" }, date: "2026-07-15" },
      ],
    },
    content,
  });
  const graphql = async () => ({
    user: {
      projectV2: {
        items: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            node({ __typename: "Issue", number: 401, title: "Issue", url: "issue", body: assignment }),
            node({ __typename: "PullRequest", number: 402, title: "PR", url: "pr", body: assignment }),
            node({ __typename: "DraftIssue", title: "Draft", body: assignment }),
            node(null),
          ],
        },
      },
    },
  });
  const result = await fetchProjectItems({ owner: "octo", projectNumber: 9, graphql });
  assert.deepEqual(
    result.items.map(({ number }) => number),
    [401],
  );
});

test("parses the documented operational Project CLI flags", () => {
  assert.deepEqual(
    parseCliArgs([
      "--project-owner",
      "octo",
      "--owner-type",
      "user",
      "--project-number",
      "9",
      "--dry-run",
      "--max-parallel",
      "2",
      "--release-policy",
      "pr-created",
      "--unavailable-model",
      "Fable",
      "--unavailable-model",
      "sonnet",
      "--run-date",
      "2026-07-15",
      "--state-path",
      "/tmp/state.json",
      "--existing-worktree",
      "101",
      "--existing-worktree",
      "102",
      "--milestone-json",
      '{"issue":101,"type":"pr-created"}',
    ]),
    {
      projectOwner: "octo",
      ownerType: "user",
      projectNumber: 9,
      dryRun: true,
      maxParallel: 2,
      releasePolicy: "pr-created",
      unavailableModels: ["Fable", "sonnet"],
      runDate: "2026-07-15",
      statePath: "/tmp/state.json",
      existingWorktrees: [101, 102],
      milestoneJson: '{"issue":101,"type":"pr-created"}',
    },
  );
  assert.throws(() => parseCliArgs(["--mystery"]), /unknown-flag:--mystery/);
});

test("GitHub GraphQL transport accepts an injected fetch implementation", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, json: async () => ({ data: { viewer: { login: "octo" } } }) };
  };
  const result = await githubGraphql("query Viewer { viewer { login } }", {}, { token: "fake", fetchImpl });
  assert.deepEqual(result, { viewer: { login: "octo" } });
  assert.equal(calls[0].url, "https://api.github.com/graphql");
  assert.equal(calls[0].init.headers.Authorization, "bearer fake");
});
