import test from "node:test";
import assert from "node:assert/strict";

import {
  calculateIterationDates,
  classifyProject,
  parseProjectMetadata,
  resolveDefaults,
  applyProjectDefaults,
} from "../../scripts/project-issue-defaults.mjs";

test("parses the bounded project metadata block", () => {
  const result = parseProjectMetadata(
    "before\n<!-- project-metadata:start -->\n" +
      "- AI Assignee: Codex\n" +
      "- Priority: P1\n" +
      "- Size: M\n" +
      "- Feature group: AI探索・収集基盤\n" +
      "<!-- project-metadata:end -->\nafter",
  );

  assert.deepEqual(result, {
    aiAssignee: "Codex",
    priority: "P1",
    size: "M",
    featureGroup: "AI探索・収集基盤",
  });
});

test("accepts legacy implementation-assignment metadata for the AI assignee", () => {
  const result = parseProjectMetadata("<!-- implementation-assignment: codex -->");
  assert.equal(result.aiAssignee, "Codex");
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
  assert.deepEqual(resolveDefaults({ aiAssignee: "Unknown", priority: "P9", size: "XXL" }), {
    aiAssignee: "未記載",
    priority: "P2",
    size: "M",
    reasons: ["unknown-ai-assignee", "invalid-priority", "invalid-size"],
  });
});

test("starts a one-day iteration on the day after the issue date", () => {
  assert.deepEqual(calculateIterationDates("2026-07-15"), {
    startDate: "2026-07-16",
    targetDate: "2026-07-16",
    name: "2026-07-16",
  });
});

test("reuses an existing item and iteration without creating duplicates", async () => {
  const calls = [];
  const graphql = async (query, variables) => {
    calls.push({ query, variables });
    return {
      updateProjectV2Field: {
        projectV2Field: { configuration: { iterations: [{ id: "it-existing", title: "2026-07-16" }] } },
      },
    };
  };
  const result = await applyProjectDefaults({
    issue: {
      id: "issue-1",
      node_id: "issue-node-1",
      title: "Visibility collection",
      body: "",
      labels: [],
      created_at: "2026-07-15T00:00:00Z",
    },
    project: {
      id: "project-1",
      title: "Visibility",
          items: { nodes: [{ id: "item-existing", content: { id: "issue-node-1" } }] },
      fields: {
        nodes: [
          {
            id: "ai",
            name: "AI Assignees",
            options: [
              { id: "codex", name: "Codex" },
              { id: "unknown", name: "未記載" },
            ],
          },
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
    },
    graphql,
    config: { projectName: "Visibility" },
  });

  assert.equal(result.itemId, "item-existing");
  assert.equal(result.iteration, "2026-07-16");
  assert.equal(
    calls.some(({ query }) => query.includes("AddItem")),
    false,
  );
  assert.equal(calls.length, 6);
});

test("does not mutate a project when a required option is unavailable", async () => {
  await assert.rejects(
    applyProjectDefaults({
      issue: {
        id: "issue-1",
        title: "Visibility",
        body: "- Priority: P1",
        labels: [],
        created_at: "2026-07-15T00:00:00Z",
      },
      project: { id: "project-1", fields: { nodes: [] }, items: { nodes: [] } },
      graphql: async () => {
        throw new Error("must-not-call-api");
      },
      config: { projectName: "Visibility" },
    }),
    /project-option-not-found|project-field-not-found/,
  );
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
  await assert.rejects(
    applyProjectDefaults({
      issue: {
        id: "issue-1",
        node_id: "issue-node-1",
        title: "Visibility collection",
        body: "<!-- project-metadata:start -->\n- Feature group: New group\n<!-- project-metadata:end -->",
        labels: [],
        created_at: "2026-07-15T00:00:00Z",
      },
      project: {
        id: "project-1",
        fields: {
          nodes: [
            { id: "ai", name: "AI Assignees", options: [{ id: "unknown", name: "未記載" }] },
            { id: "priority", name: "Priority", options: [{ id: "p2", name: "P2" }] },
            { id: "size", name: "Size", options: [{ id: "m", name: "M" }] },
            { id: "start", name: "Start date" },
            { id: "target", name: "Target date" },
            { id: "iteration", name: "Iteration", configuration: { iterations: [] } },
          ],
        },
        items: { nodes: [] },
      },
      graphql,
      config: { projectName: "Visibility" },
    }),
    /iteration-api-failed/,
  );
  assert.equal(calls.some((query) => query.includes("AddItem")), false);
});
