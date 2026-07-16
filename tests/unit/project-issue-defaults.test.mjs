import test from "node:test";
import assert from "node:assert/strict";

import {
  calculateIterationDates,
  classifyProject,
  parseProjectMetadata,
  resolveDefaults,
  applyProjectDefaults,
  toRetryableErrorPayload,
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
      { id: "priority", name: "Priority", options: [{ id: "p2", name: "P2" }] },
      { id: "size", name: "Size", options: [{ id: "m", name: "M" }] },
      { id: "start", name: "Start date" },
      { id: "target", name: "Target date" },
      {
        id: "iteration",
        name: "Iteration",
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
