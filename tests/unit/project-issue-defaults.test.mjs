import test from "node:test";
import assert from "node:assert/strict";

import {
  calculateIterationDates,
  classifyProject,
  parseProjectMetadata,
  resolveDefaults,
  applyProjectDefaults,
  toRetryableErrorPayload,
  parseIssueNumberInput,
  normalizeProjectIssueEvent,
  shapeIssueRecord,
  loadRepositoryIssue,
  reasonFromGraphqlFailure,
} from "../../scripts/project-issue-defaults.mjs";

test("parses the bounded project metadata block", () => {
  const result = parseProjectMetadata(
    "before\n<!-- project-metadata:start -->\n" +
      "- Priority: P1\n" +
      "- Size: M\n" +
      "- Feature group: AI探索・収集基盤\n" +
      "<!-- project-metadata:end -->\nafter",
  );

  assert.deepEqual(result, {
    priority: "P1",
    size: "M",
    featureGroup: "AI探索・収集基盤",
  });
});

test("ignores legacy AI assignment fields instead of failing", () => {
  const result = parseProjectMetadata(
    "<!-- project-metadata:start -->\n" +
      "- AI Assignee: Codex\n" +
      "- AI Sub Assignee: Claude\n" +
      "- Priority: P1\n" +
      "- Size: M\n" +
      "<!-- project-metadata:end -->\n" +
      "<!-- implementation-assignment:start -->\n" +
      "- Primary: Codex\n" +
      "- Model: gpt-5.6-sol\n" +
      "- Order: 1\n" +
      "<!-- implementation-assignment:end -->",
  );
  assert.deepEqual(result, { priority: "P1", size: "M", featureGroup: undefined });
});

test("ignores the legacy one-line implementation-assignment marker", () => {
  assert.deepEqual(parseProjectMetadata("<!-- implementation-assignment: codex -->"), {
    priority: undefined,
    size: undefined,
    featureGroup: undefined,
  });
});

test("classifies Visibility issues from Japanese disclosure labels", () => {
  assert.equal(classifyProject({ title: "開示台帳の収集改善", body: "", labels: [] }), "Visibility");
});

test("does not guess when two candidate projects are equally plausible", () => {
  assert.equal(
    classifyProject({
      title: "住所フォームの開示台帳更新",
      body: "",
      labels: ["Visibility", "Bulk Update"],
    }),
    null,
  );
});

test("uses documented safe defaults for missing and invalid values", () => {
  assert.deepEqual(resolveDefaults({ priority: "P9", size: "XXL" }, {}), {
    priority: "P2",
    size: "M",
    reasons: ["invalid-priority", "invalid-size"],
  });
  assert.deepEqual(resolveDefaults({ priority: "P1", size: "L" }, {}), {
    priority: "P1",
    size: "L",
    reasons: [],
  });
});

test("starts a one-day iteration on the day after the issue date", () => {
  assert.deepEqual(calculateIterationDates("2026-07-15"), {
    startDate: "2026-07-16",
    targetDate: "2026-07-16",
    name: "2026-07-16",
  });
});

const projectFixture = () => ({
  id: "project-1",
  title: "Visibility",
  items: { nodes: [{ id: "item-existing", content: { id: "issue-node-1" } }] },
  fields: {
    nodes: [
      {
        id: "priority",
        name: "Priority",
        dataType: "SINGLE_SELECT",
        options: [{ id: "p2", name: "P2" }],
      },
      {
        id: "size",
        name: "Size",
        dataType: "SINGLE_SELECT",
        options: [{ id: "m", name: "M" }],
      },
      { id: "start", name: "Start date", dataType: "DATE" },
      { id: "target", name: "Target date", dataType: "DATE" },
      {
        id: "iteration",
        name: "Iteration",
        dataType: "ITERATION",
        configuration: { iterations: [{ id: "it-existing", title: "2026-07-16" }] },
      },
    ],
  },
});

const issueFixture = () => ({
  id: "issue-1",
  node_id: "issue-node-1",
  title: "Visibility collection",
  body: "<!-- project-metadata:start -->\n- Priority: P2\n- Size: M\n<!-- project-metadata:end -->",
  labels: [],
  created_at: "2026-07-15T00:00:00Z",
});

const convergedFieldValues = {
  node: {
    fieldValues: {
      nodes: [
        { field: { name: "Priority" }, name: "P2" },
        { field: { name: "Size" }, name: "M" },
        { field: { name: "Start date" }, date: "2026-07-16" },
        { field: { name: "Target date" }, date: "2026-07-16" },
        { field: { name: "Iteration" }, title: "2026-07-16" },
      ],
    },
  },
};

test("reuses an existing item and iteration and confirms convergence by readback", async () => {
  const calls = [];
  const graphql = async (query, variables) => {
    calls.push({ query, variables });
    if (query.includes("ItemFieldValues")) return convergedFieldValues;
    return {};
  };
  const result = await applyProjectDefaults({
    issue: issueFixture(),
    project: projectFixture(),
    graphql,
    config: { projectName: "Visibility" },
  });

  assert.equal(result.itemId, "item-existing");
  assert.equal(result.iteration, "2026-07-16");
  assert.deepEqual(result.reasons, []);
  assert.equal(
    calls.some(({ query }) => query.includes("AddItem")),
    false,
  );
  assert.equal(
    calls.some(({ query }) => query.includes("UpdateIteration")),
    false,
  );
  // Five field mutations (Priority, Size, Start date, Target date, Iteration)
  // plus the final readback query.
  assert.equal(calls.length, 6);
  assert.equal(calls.at(-1).query.includes("ItemFieldValues"), true);
});

test("does not report success when the readback shows an unconverged field", async () => {
  const graphql = async (query) => {
    if (query.includes("ItemFieldValues"))
      return {
        node: {
          fieldValues: {
            nodes: [
              { field: { name: "Priority" }, name: "P0" },
              { field: { name: "Size" }, name: "M" },
              { field: { name: "Start date" }, date: "2026-07-16" },
              { field: { name: "Target date" }, date: "2026-07-16" },
              { field: { name: "Iteration" }, title: "2026-07-16" },
            ],
          },
        },
      };
    return {};
  };
  await assert.rejects(
    applyProjectDefaults({
      issue: issueFixture(),
      project: projectFixture(),
      graphql,
      config: { projectName: "Visibility" },
    }),
    /project-fields-unconverged:Priority/,
  );
});

test("preserves configured field names in the retryable unconverged payload", async () => {
  const project = projectFixture();
  project.fields.nodes.find((field) => field.name === "Start date").name = "Start, actual: date";
  const graphql = async (query) => {
    if (query.includes("ItemFieldValues"))
      return {
        node: {
          fieldValues: {
            nodes: convergedFieldValues.node.fieldValues.nodes.map((value) =>
              value.field.name === "Start date"
                ? { field: { name: "Start, actual: date" }, date: "2026-07-17" }
                : value,
            ),
          },
        },
      };
    return {};
  };

  let caught;
  try {
    await applyProjectDefaults({
      issue: issueFixture(),
      project,
      graphql,
      config: { projectName: "Visibility", fields: { startDate: "Start, actual: date" } },
    });
  } catch (error) {
    caught = error;
  }

  assert.deepEqual(toRetryableErrorPayload(caught), {
    status: "retryable-error",
    reason: "project-fields-unconverged",
    fields: ["Start, actual: date"],
  });
});

test("reports an unavailable final readback separately from field divergence", async () => {
  const graphql = async (query) => (query.includes("ItemFieldValues") ? { node: null } : {});

  await assert.rejects(
    applyProjectDefaults({
      issue: issueFixture(),
      project: projectFixture(),
      graphql,
      config: { projectName: "Visibility" },
    }),
    /project-readback-unavailable/,
  );
});

test("does not mutate a project when a required field is missing", async () => {
  let mutationCount = 0;
  const project = projectFixture();
  project.fields.nodes = project.fields.nodes.filter((field) => field.name !== "Priority");
  await assert.rejects(
    applyProjectDefaults({
      issue: issueFixture(),
      project,
      graphql: async () => {
        mutationCount += 1;
        throw new Error("must-not-mutate");
      },
      config: { projectName: "Visibility" },
    }),
    /project-field-not-found:Priority/,
  );
  assert.equal(mutationCount, 0);
});

test("does not mutate a project when a required option is unavailable", async () => {
  let mutationCount = 0;
  const project = projectFixture();
  project.fields.nodes.find((field) => field.name === "Size").options = [];
  await assert.rejects(
    applyProjectDefaults({
      issue: issueFixture(),
      project,
      graphql: async () => {
        mutationCount += 1;
        throw new Error("must-not-mutate");
      },
      config: { projectName: "Visibility" },
    }),
    /project-option-not-found:Size/,
  );
  assert.equal(mutationCount, 0);
});

test("does not mutate a project when a required field has the wrong type", async () => {
  let mutationCount = 0;
  const project = projectFixture();
  project.fields.nodes.find((field) => field.name === "Start date").dataType = "TEXT";
  await assert.rejects(
    applyProjectDefaults({
      issue: issueFixture(),
      project,
      graphql: async () => {
        mutationCount += 1;
        throw new Error("must-not-mutate");
      },
      config: { projectName: "Visibility" },
    }),
    /project-field-type-mismatch:Start date/,
  );
  assert.equal(mutationCount, 0);
});

test("does not update a project when classification is required but absent", async () => {
  await assert.rejects(
    applyProjectDefaults({
      issue: {
        id: "issue-1",
        title: "Unrelated maintenance",
        body: "",
        labels: [],
        created_at: "2026-07-15T00:00:00Z",
      },
      project: { id: "project-1", fields: { nodes: [] }, items: { nodes: [] } },
      graphql: async () => {
        throw new Error("must-not-call-api");
      },
      config: { projectName: "Visibility", requireClassification: true },
    }),
    /project-unclassified/,
  );
});

test("creates the iteration before adding the Issue item", async () => {
  const calls = [];
  const graphql = async (query) => {
    calls.push(query);
    if (query.includes("UpdateIteration")) {
      throw new Error("iteration-api-failed");
    }
    throw new Error("item-mutation-must-not-run");
  };
  const issue = issueFixture();
  issue.body =
    "<!-- project-metadata:start -->\n- Priority: P2\n- Size: M\n- Feature group: New group\n<!-- project-metadata:end -->";
  const project = projectFixture();
  project.items.nodes = [];
  await assert.rejects(
    applyProjectDefaults({ issue, project, graphql, config: { projectName: "Visibility" } }),
    /iteration-api-failed/,
  );
  assert.equal(
    calls.some((query) => query.includes("AddItem")),
    false,
  );
});

test("parseIssueNumberInput accepts positive integers only", () => {
  assert.equal(parseIssueNumberInput("413"), 413);
  assert.equal(parseIssueNumberInput(" 7 "), 7);
  assert.throws(() => parseIssueNumberInput(""), /invalid-issue-number/);
  assert.throws(() => parseIssueNumberInput("0"), /invalid-issue-number/);
  assert.throws(() => parseIssueNumberInput("-1"), /invalid-issue-number/);
  assert.throws(() => parseIssueNumberInput("4.1"), /invalid-issue-number/);
  assert.throws(() => parseIssueNumberInput("abc"), /invalid-issue-number/);
});

test("normalizeProjectIssueEvent shapes issues.opened and workflow_dispatch the same way", () => {
  const opened = normalizeProjectIssueEvent(
    {
      action: "opened",
      issue: {
        id: 1,
        node_id: "I_1",
        number: 10,
        title: "Visibility test",
        body: "body",
        labels: [{ name: "Visibility" }],
        created_at: "2026-07-15T00:00:00Z",
      },
      repository: { full_name: "soroeru/Soroeru" },
    },
    { repositoryFullName: "soroeru/Soroeru" },
  );
  assert.equal(opened.source, "issues.opened");
  assert.deepEqual(opened.issue, {
    id: 1,
    node_id: "I_1",
    number: 10,
    title: "Visibility test",
    body: "body",
    labels: [{ name: "Visibility" }],
    created_at: "2026-07-15T00:00:00Z",
  });

  const dispatch = normalizeProjectIssueEvent(
    {
      inputs: { issue_number: "413" },
      repository: { full_name: "soroeru/Soroeru" },
    },
    { repositoryFullName: "soroeru/Soroeru" },
  );
  assert.deepEqual(dispatch, {
    source: "workflow_dispatch",
    issueNumber: 413,
    issue: null,
  });
});

test("normalizeProjectIssueEvent rejects PRs, invalid numbers, and repository mismatch", () => {
  assert.throws(
    () =>
      normalizeProjectIssueEvent({
        issue: {
          id: 1,
          node_id: "I_1",
          created_at: "2026-07-15T00:00:00Z",
          pull_request: { url: "https://example.invalid" },
        },
      }),
    /pull-request-not-supported/,
  );
  assert.throws(
    () => normalizeProjectIssueEvent({ inputs: { issue_number: "0" } }),
    /invalid-issue-number/,
  );
  assert.throws(
    () =>
      normalizeProjectIssueEvent(
        {
          issue: { id: 1, node_id: "I_1", created_at: "2026-07-15T00:00:00Z" },
          repository: { full_name: "other/Repo" },
        },
        { repositoryFullName: "soroeru/Soroeru" },
      ),
    /repository-mismatch/,
  );
  assert.throws(() => normalizeProjectIssueEvent({}), /issue-event-required/);
});

test("shapeIssueRecord rejects incomplete and PR payloads before mutation", () => {
  assert.throws(() => shapeIssueRecord(null), /issue-event-required/);
  assert.throws(
    () => shapeIssueRecord({ id: 1, created_at: "2026-07-15T00:00:00Z" }),
    /issue-node-id-required/,
  );
  assert.throws(
    () =>
      shapeIssueRecord({
        id: 1,
        node_id: "I_1",
        created_at: "2026-07-15T00:00:00Z",
        pull_request: {},
      }),
    /pull-request-not-supported/,
  );
});

test("loadRepositoryIssue fetches and shapes only same-repo Issues", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, hasAuth: Boolean(init?.headers?.Authorization) });
    return {
      status: 200,
      ok: true,
      async json() {
        return {
          id: 99,
          node_id: "I_99",
          number: 413,
          title: "Visibility collection",
          body: "x",
          labels: [],
          created_at: "2026-07-15T00:00:00Z",
        };
      },
    };
  };
  const issue = await loadRepositoryIssue(
    { owner: "soroeru", repo: "Soroeru", issueNumber: "413", token: "test-token" },
    fetchImpl,
  );
  assert.equal(issue.number, 413);
  assert.equal(issue.node_id, "I_99");
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/repos\/soroeru\/Soroeru\/issues\/413$/);
  assert.equal(calls[0].hasAuth, true);
});

test("loadRepositoryIssue rejects missing tokens, 404s, and pull requests before mutation", async () => {
  await assert.rejects(
    loadRepositoryIssue({ owner: "soroeru", repo: "Soroeru", issueNumber: 1, token: "" }),
    /project-token-required/,
  );
  await assert.rejects(
    loadRepositoryIssue(
      { owner: "soroeru", repo: "Soroeru", issueNumber: 1, token: "t" },
      async () => ({ status: 404, ok: false, async json() { return {}; } }),
    ),
    /issue-not-found/,
  );
  await assert.rejects(
    loadRepositoryIssue(
      { owner: "soroeru", repo: "Soroeru", issueNumber: 5, token: "t" },
      async () => ({
        status: 200,
        ok: true,
        async json() {
          return {
            id: 1,
            node_id: "I_1",
            number: 5,
            created_at: "2026-07-15T00:00:00Z",
            pull_request: { url: "x" },
          };
        },
      }),
    ),
    /pull-request-not-supported/,
  );
});

test("toRetryableErrorPayload maps secret and validation failures without extra detail", () => {
  assert.deepEqual(toRetryableErrorPayload(new Error("project-token-required")), {
    status: "retryable-error",
    reason: "project-token-required",
  });
  assert.deepEqual(toRetryableErrorPayload(new Error("invalid-issue-number")), {
    status: "retryable-error",
    reason: "invalid-issue-number",
  });
  assert.deepEqual(toRetryableErrorPayload(new Error("pull-request-not-supported")), {
    status: "retryable-error",
    reason: "pull-request-not-supported",
  });
  assert.deepEqual(toRetryableErrorPayload(new Error("github-graphql-failed")), {
    status: "retryable-error",
    reason: "github-graphql-failed",
  });
  assert.deepEqual(toRetryableErrorPayload(new Error("github-graphql-forbidden")), {
    status: "retryable-error",
    reason: "github-graphql-forbidden",
  });
});

test("reasonFromGraphqlFailure classifies integration and not-found errors", () => {
  assert.equal(reasonFromGraphqlFailure(false, {}), "github-graphql-http-failed");
  assert.equal(reasonFromGraphqlFailure(true, {}), null);
  assert.equal(
    reasonFromGraphqlFailure(true, {
      errors: [{ type: "FORBIDDEN", message: "Resource not accessible by integration" }],
    }),
    "github-graphql-forbidden",
  );
  assert.equal(
    reasonFromGraphqlFailure(true, { errors: [{ type: "NOT_FOUND", message: "Could not resolve" }] }),
    "github-graphql-not-found",
  );
  assert.equal(
    reasonFromGraphqlFailure(true, { errors: [{ message: "something else" }] }),
    "github-graphql-failed",
  );
});