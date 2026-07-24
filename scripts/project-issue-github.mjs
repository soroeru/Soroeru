import { OWNER_TYPES } from "./project-issue-assignment.mjs";

export const DEFAULT_PROJECT_FIELD_NAMES = Object.freeze({
  priority: "Priority",
  iteration: "Iteration",
  size: "Size",
  status: "Status",
  startDate: "Start date",
});

export function buildProjectItemsQuery(ownerType) {
  if (!OWNER_TYPES.has(ownerType)) throw new Error("invalid-owner-type");
  return `query ProjectIssueOrchestration($owner: String!, $name: String!, $cursor: String) { ${ownerType}(login: $owner) { projectsV2(first: 10, query: $name) { nodes { title items(first: 100, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { fieldValues(first: 100) { nodes { ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { name } } } ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2FieldCommon { name } } } ... on ProjectV2ItemFieldIterationValue { title field { ... on ProjectV2FieldCommon { name } } } } } content { __typename ... on Issue { number title url blockedBy(first: 100) { nodes { number state } } } } } } } } } }`;
}

function requiredString(value, reason) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(reason);
  return value.trim();
}

function resolveFieldNames(fields = {}) {
  return {
    priority: fields.priority ?? DEFAULT_PROJECT_FIELD_NAMES.priority,
    iteration: fields.iteration ?? DEFAULT_PROJECT_FIELD_NAMES.iteration,
    size: fields.size ?? DEFAULT_PROJECT_FIELD_NAMES.size,
    status: fields.status ?? DEFAULT_PROJECT_FIELD_NAMES.status,
    startDate: fields.startDate ?? DEFAULT_PROJECT_FIELD_NAMES.startDate,
  };
}

/**
 * Fetch Project items and map each Issue to the minimal planning schema.
 * Issue bodies are never requested: dependencies come from GitHub `blockedBy`
 * relations and Priority/Size/Status come from Project fields, so no bounded
 * body extraction is needed. `fields` mirrors config/github-projects.json
 * `fields` (priority / size / …).
 */
export async function fetchProjectItems({ owner, ownerType = "organization", projectName, graphql, fields = {} }) {
  requiredString(owner, "project-owner-required");
  requiredString(projectName, "project-name-required");
  if (typeof graphql !== "function") throw new Error("graphql-required");
  const fieldNames = resolveFieldNames(fields);
  const query = buildProjectItemsQuery(ownerType);
  const nodes = [];
  let cursor = null;
  while (true) {
    const data = await graphql(query, { owner, name: projectName, cursor });
    const projects =
      data?.[ownerType]?.projectsV2?.nodes ??
      (data?.[ownerType]?.projectV2
        ? [{ title: projectName, items: data[ownerType].projectV2.items }]
        : null);
    if (!Array.isArray(projects)) throw new Error("project-not-found");
    const matches = projects.filter((project) => project?.title === projectName);
    if (!matches.length) throw new Error("project-not-found");
    if (matches.length !== 1) throw new Error("project-name-ambiguous");
    const items = matches[0].items;
    if (!Array.isArray(items?.nodes)) throw new Error("project-items-not-found");
    nodes.push(...items.nodes);
    if (!items.pageInfo?.hasNextPage) break;
    if (!items.pageInfo.endCursor) throw new Error("project-pagination-cursor-missing");
    cursor = items.pageInfo.endCursor;
  }
  // Total UTF-8 JSON bytes for every Project item node fetched, including
  // non-Issue nodes that are discarded below. This is a bounded-read metric,
  // not an Issue-body byte count (Issue bodies are never requested).
  let fetchedBytes = 0;
  const mapped = nodes.flatMap((node) => {
    fetchedBytes += Buffer.byteLength(JSON.stringify(node), "utf8");
    if (node.content?.__typename !== "Issue") return [];
    const fieldValues = new Map(
      (node.fieldValues?.nodes ?? []).map((value) => [
        value.field?.name,
        value.name ?? value.date ?? value.title,
      ]),
    );
    const blockedBy = node.content?.blockedBy?.nodes ?? [];
    return [
      {
        number: node.content?.number,
        title: node.content?.title,
        url: node.content?.url,
        status: fieldValues.get(fieldNames.status),
        priority: fieldValues.get(fieldNames.priority),
        iteration: fieldValues.get(fieldNames.iteration),
        size: fieldValues.get(fieldNames.size),
        startDate: fieldValues.get(fieldNames.startDate),
        dependencies: blockedBy.map((dependency) => Number(dependency.number)),
        blockedBy: blockedBy.map(({ number: dependency, state }) => ({
          number: Number(dependency),
          state,
        })),
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
