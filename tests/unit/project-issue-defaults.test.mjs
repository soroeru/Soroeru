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
      "- AI Sub Assignee: Claude\n" +
      "- Priority: P1\n" +
      "- Size: M\n" +
      "- Feature group: AI探索・収集基盤\n" +
      "<!-- project-metadata:end -->\nafter",
  );

  assert.deepEqual(result, {
    aiAssignee: "Codex",
    aiSubAssignee: "Claude",
    priority: "P1",
    size: "M",
    featureGroup: "AI探索・収集基盤",
  });
});

test("maps the primary AI assignee to its configured sub assignee", () => {
  const result = resolveDefaults(
    { aiAssignee: "Codex", aiSubAssignee: "Claude", priority: "P1", size: "M" },
    { aiAssignees: ["Codex"], aiSubAssignees: ["Claude"], priorities: ["P1"], sizes: ["M"] },
    { Codex: "Claude" },
  );

  assert.equal(result.aiSubAssignee, "Claude");
});

test("derives a missing AI sub assignee from the configured mapping for legacy issues", () => {
  const result = resolveDefaults(
    { aiAssignee: "Codex", priority: "P1", size: "M" },
    { aiAssignees: ["Codex"], aiSubAssignees: ["Claude"], priorities: ["P1"], sizes: ["M"] },
    { Codex: "Claude" },
  );
  assert.equal(result.aiSubAssignee, "Claude");
  assert.equal(result.reasons.includes("missing-ai-sub-assignee"), false);
});

test("rejects an unknown AI sub assignee even when it normalizes to the fallback", () => {
  const result = resolveDefaults(
    { aiAssignee: "未記載", aiSubAssignee: "Unknown", priority: "P2", size: "M" },
    {},
    { 未記載: "未記載" },
  );

  assert.equal(result.reasons.includes("unknown-ai-sub-assignee"), true);
});

test("reports a missing primary-to-sub mapping distinctly from unknown names", () => {
  const result = resolveDefaults(
    { aiAssignee: "Codex", priority: "P1", size: "M" },
    { aiAssignees: ["Codex"], priorities: ["P1"], sizes: ["M"] },
    {},
  );
  assert.equal(result.reasons.includes("missing-ai-sub-assignee-mapping"), true);
  assert.equal(result.aiSubAssignee, undefined);
});

test("reports a map target that is absent from Project field options", () => {
  const result = resolveDefaults(
    { aiAssignee: "Codex", aiSubAssignee: "Claude", priority: "P1", size: "M" },
    { aiAssignees: ["Codex"], aiSubAssignees: ["Codex"], priorities: ["P1"], sizes: ["M"] },
    { Codex: "Claude" },
  );
  assert.equal(result.reasons.includes("ai-sub-assignee-option-missing"), true);
  assert.equal(result.aiSubAssignee, "Claude");
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
  assert.deepEqual(
    resolveDefaults(
      { aiAssignee: "Unknown", aiSubAssignee: "未記載", priority: "P9", size: "XXL" },
      {},
      { 未記載: "未記載" },
    ),
    {
      aiAssignee: "未記載",
      aiSubAssignee: "未記載",
      priority: "P2",
      size: "M",
      reasons: ["unknown-ai-assignee", "invalid-priority", "invalid-size"],
    },
  );
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
      body: "<!-- project-metadata:start -->\n- AI Sub Assignee: Claude\n<!-- project-metadata:end -->",
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
          {
            id: "ai-sub",
            name: "AI Sub Assignees",
            options: [{ id: "claude", name: "Claude" }],
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
    config: { projectName: "Visibility", aiSubAssignees: { 未記載: "Claude" } },
  });

  assert.equal(result.itemId, "item-existing");
  assert.equal(result.iteration, "2026-07-16");
  assert.equal(
    calls.some(({ query }) => query.includes("AddItem")),
    false,
  );
  assert.equal(calls.length, 7);
  assert.equal(
    calls.some(
      ({ variables }) => variables.fieldId === "ai-sub" && variables.value.singleSelectOptionId === "claude",
    ),
    true,
  );
});

test("does not mutate a project when the AI sub assignee field is missing", async () => {
  let mutationCount = 0;

  await assert.rejects(
    applyProjectDefaults({
      issue: {
        id: "issue-1",
        node_id: "issue-node-1",
        title: "Visibility collection",
        body: "<!-- project-metadata:start -->\n- AI Assignee: Codex\n- AI Sub Assignee: Claude\n<!-- project-metadata:end -->",
        labels: [],
        created_at: "2026-07-15T00:00:00Z",
      },
      project: {
        id: "project-1",
        fields: {
          nodes: [
            { id: "ai", name: "AI Assignees", options: [{ id: "codex", name: "Codex" }] },
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
        items: { nodes: [] },
      },
      graphql: async () => {
        mutationCount += 1;
        throw new Error("must-not-mutate");
      },
      config: { projectName: "Visibility", aiSubAssignees: { Codex: "Claude" } },
    }),
    /project-field-not-found:AI Sub Assignees/,
  );

  assert.equal(mutationCount, 0);
});

test("does not mutate a project when the AI sub assignee option is missing", async () => {
  let mutationCount = 0;

  await assert.rejects(
    applyProjectDefaults({
      issue: {
        id: "issue-1",
        node_id: "issue-node-1",
        title: "Visibility collection",
        body: "<!-- project-metadata:start -->\n- AI Assignee: Codex\n- AI Sub Assignee: Claude\n<!-- project-metadata:end -->",
        labels: [],
        created_at: "2026-07-15T00:00:00Z",
      },
      project: {
        id: "project-1",
        fields: {
          nodes: [
            { id: "ai", name: "AI Assignees", options: [{ id: "codex", name: "Codex" }] },
            {
              id: "ai-sub",
              name: "AI Sub Assignees",
              options: [{ id: "codex-sub", name: "Codex" }],
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
        items: { nodes: [] },
      },
      graphql: async () => {
        mutationCount += 1;
        throw new Error("must-not-mutate");
      },
      config: { projectName: "Visibility", aiSubAssignees: { Codex: "Claude" } },
    }),
    /ai-sub-assignee-option-missing/,
  );

  assert.equal(mutationCount, 0);
});

test("does not mutate a project when a required option is unavailable", async () => {
  await assert.rejects(
    applyProjectDefaults({
      issue: {
        id: "issue-1",
        title: "Visibility",
        body: "<!-- project-metadata:start -->\n- AI Sub Assignee: 未記載\n<!-- project-metadata:end -->",
        labels: [],
        created_at: "2026-07-15T00:00:00Z",
      },
      project: { id: "project-1", fields: { nodes: [] }, items: { nodes: [] } },
      graphql: async () => {
        throw new Error("must-not-call-api");
      },
      config: { projectName: "Visibility", aiSubAssignees: { 未記載: "未記載" } },
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
        body: "<!-- project-metadata:start -->\n- AI Sub Assignee: 未記載\n- Feature group: New group\n<!-- project-metadata:end -->",
        labels: [],
        created_at: "2026-07-15T00:00:00Z",
      },
      project: {
        id: "project-1",
        fields: {
          nodes: [
            { id: "ai", name: "AI Assignees", options: [{ id: "unknown", name: "未記載" }] },
            {
              id: "ai-sub",
              name: "AI Sub Assignees",
              options: [{ id: "unknown-sub", name: "未記載" }],
            },
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
      config: { projectName: "Visibility", aiSubAssignees: { 未記載: "未記載" } },
    }),
    /iteration-api-failed/,
  );
  assert.equal(
    calls.some((query) => query.includes("AddItem")),
    false,
  );
});
