import {
  canonicalizeAssignee,
  OWNER_TYPES,
  parseIssueAssignment,
} from "./project-issue-assignment.mjs";

export const DEFAULT_PROJECT_FIELD_NAMES = Object.freeze({
  aiAssignee: "AI Assignees",
  aiSubAssignee: "AI Sub Assignees",
  priority: "Priority",
  iteration: "Iteration",
  size: "Size",
  status: "Status",
  startDate: "Start date",
});

export function buildProjectItemsQuery(ownerType) {
  if (!OWNER_TYPES.has(ownerType)) throw new Error("invalid-owner-type");
  return `query ProjectIssueOrchestration($owner: String!, $number: Int!, $cursor: String) { ${ownerType}(login: $owner) { projectV2(number: $number) { items(first: 100, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { fieldValues(first: 100) { nodes { ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { name } } } ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2FieldCommon { name } } } ... on ProjectV2ItemFieldIterationValue { title field { ... on ProjectV2FieldCommon { name } } } } } content { __typename ... on Issue { number title url body } } } } } } }`;
}

function requiredString(value, reason) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(reason);
  return value.trim();
}

function resolveFieldNames(fields = {}) {
  return {
    aiAssignee: fields.aiAssignee ?? DEFAULT_PROJECT_FIELD_NAMES.aiAssignee,
    aiSubAssignee: fields.aiSubAssignee ?? DEFAULT_PROJECT_FIELD_NAMES.aiSubAssignee,
    priority: fields.priority ?? DEFAULT_PROJECT_FIELD_NAMES.priority,
    iteration: fields.iteration ?? DEFAULT_PROJECT_FIELD_NAMES.iteration,
    size: fields.size ?? DEFAULT_PROJECT_FIELD_NAMES.size,
    status: fields.status ?? DEFAULT_PROJECT_FIELD_NAMES.status,
    startDate: fields.startDate ?? DEFAULT_PROJECT_FIELD_NAMES.startDate,
  };
}

/**
 * Fetch Project items and map each Issue to the minimal assignment schema.
 * Issue bodies are counted for telemetry then discarded from the returned items.
 * `fields` mirrors config/github-projects.json `fields` (aiAssignee / aiSubAssignee / …).
 */
export async function fetchProjectItems({
  owner,
  ownerType = "user",
  projectNumber,
  graphql,
  fields = {},
}) {
  requiredString(owner, "project-owner-required");
  if (!Number.isSafeInteger(projectNumber) || projectNumber <= 0) throw new Error("invalid-project-number");
  if (typeof graphql !== "function") throw new Error("graphql-required");
  const fieldNames = resolveFieldNames(fields);
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
    const fieldValues = new Map(
      (node.fieldValues?.nodes ?? []).map((value) => [value.field?.name, value.name ?? value.date ?? value.title]),
    );
    let assignment;
    let assignmentError;
    try {
      assignment = parseIssueAssignment(body);
    } catch (error) {
      assignment = {};
      assignmentError = error.message;
    }
    const number = node.content?.number;
    // Project single-select wins over body when present; canonicalize casing.
    const primary = canonicalizeAssignee(
      fieldValues.get(fieldNames.aiAssignee) ?? assignment.primary,
    );
    const sub = canonicalizeAssignee(
      fieldValues.get(fieldNames.aiSubAssignee) ?? assignment.sub,
    );
    const model = assignment.model;
    const order = assignment.order;
    const dependencies = assignment.dependencies;
    // Surface incomplete GitHub-shaped rows with the Issue number before planning.
    return [
      {
        number,
        title: node.content?.title,
        url: node.content?.url,
        status: fieldValues.get(fieldNames.status),
        priority: fieldValues.get(fieldNames.priority),
        iteration: fieldValues.get(fieldNames.iteration),
        size: fieldValues.get(fieldNames.size),
        startDate: fieldValues.get(fieldNames.startDate),
        primary,
        sub,
        model,
        order,
        dependencies,
        ...(assignmentError ? { assignmentError } : {}),
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
