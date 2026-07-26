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

export function buildProjectByNumberQuery(ownerType) {
  if (!OWNER_TYPES.has(ownerType)) throw new Error("invalid-owner-type");
  return `query GetProject($owner: String!, $number: Int!) {
  ${ownerType}(login: $owner) {
    projectV2(number: $number) {
      id
      fields(first: 100) {
        nodes {
          ... on ProjectV2Field { id name dataType }
          ... on ProjectV2SingleSelectField { id name dataType options { id name } }
        }
      }
      items(first: 100) {
        nodes {
          id
          content { ... on Issue { number } }
          fieldValues(first: 100) {
            nodes {
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
                field { ... on ProjectV2FieldCommon { name } }
              }
            }
          }
        }
      }
    }
  }
}`;
}

const UPDATE_STATUS_MUTATION = `mutation UpdateStatus($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: ProjectV2FieldValue!) {
  updateProjectV2ItemFieldValue(input: { projectId: $projectId itemId: $itemId fieldId: $fieldId value: $value }) {
    projectV2Item { id }
  }
}`;

const READBACK_STATUS_QUERY = `query ReadbackStatus($itemId: ID!) {
  node(id: $itemId) {
    ... on ProjectV2Item {
      fieldValues(first: 100) {
        nodes {
          ... on ProjectV2ItemFieldSingleSelectValue {
            name
            field { ... on ProjectV2FieldCommon { name } }
          }
        }
      }
    }
  }
}`;

/**
 * Transition selected Backlog items to Ready status before orchestration.
 * Follows fail-close pattern: validate all IDs before mutations, perform mutations,
 * then readback and validate. Idempotent: Ready/InProgress/InReview/Done items unchanged.
 */
export async function transitionBacklogToReady({
  projectNumber,
  projectOwner,
  projectOwnerType = "organization",
  selectedIssueNumbers = [],
  dryRun = false,
  graphql,
  fields = {},
}) {
  requiredString(projectOwner, "project-owner-required");
  if (!Number.isSafeInteger(projectNumber) || projectNumber <= 0) throw new Error("invalid-project-number");
  if (typeof graphql !== "function") throw new Error("graphql-required");
  if (!Array.isArray(selectedIssueNumbers)) throw new Error("selected-issue-numbers-required");

  const fieldNames = resolveFieldNames(fields);
  const selectedSet = new Set(selectedIssueNumbers.map(Number));
  if (selectedSet.size === 0) return { transitioned: [] };

  // Phase 1: Fetch Project and validate all IDs before mutations
  const projectData = await graphql(buildProjectByNumberQuery(projectOwnerType), {
    owner: projectOwner,
    number: projectNumber,
  });
  const project = projectData?.[projectOwnerType]?.projectV2;
  if (!project) throw new Error("project-not-found");

  const statusField = project.fields.nodes.find((f) => f.name === fieldNames.status);
  if (!statusField) throw new Error(`project-field-not-found:${fieldNames.status}`);
  if (statusField.dataType !== "SINGLE_SELECT") throw new Error(`project-field-type-mismatch:${fieldNames.status}`);

  const readyOption = statusField.options.find((opt) => opt.name === "Ready");
  if (!readyOption) throw new Error("status-ready-option-not-found");

  const backlogOption = statusField.options.find((opt) => opt.name === "Backlog");
  if (!backlogOption) throw new Error("status-backlog-option-not-found");

  // Map Issue numbers to Project item IDs; identify Backlog items to transition
  const itemsByNumber = new Map(
    project.items.nodes
      .filter((item) => item.content?.number !== undefined)
      .map((item) => [Number(item.content.number), item]),
  );

  const toTransition = [];
  for (const issueNumber of selectedSet) {
    const item = itemsByNumber.get(issueNumber);
    if (!item) throw new Error(`project-item-not-found:${issueNumber}`);

    const statusValue = item.fieldValues.nodes.find((fv) => fv.field?.name === fieldNames.status);
    const currentStatus = statusValue?.name;

    // Only transition if currently Backlog; all other statuses are idempotent (no-op)
    if (currentStatus === "Backlog") {
      toTransition.push({ issueNumber, itemId: item.id });
    }
  }

  if (toTransition.length === 0) return { transitioned: [] };
  if (dryRun) return { transitioned: toTransition.map((t) => t.issueNumber), dryRun: true };

  // Phase 2: Perform mutations
  for (const { itemId } of toTransition) {
    await graphql(UPDATE_STATUS_MUTATION, {
      projectId: project.id,
      itemId,
      fieldId: statusField.id,
      value: { singleSelectOptionId: readyOption.id },
    });
  }

  // Phase 3: Readback and validate all transitions converged
  const failedTransitions = [];
  for (const { issueNumber, itemId } of toTransition) {
    const readback = await graphql(READBACK_STATUS_QUERY, { itemId });
    if (!readback?.node || !Array.isArray(readback.node.fieldValues?.nodes))
      throw new Error(`project-readback-unavailable:${issueNumber}`);

    const statusValue = readback.node.fieldValues.nodes.find((fv) => fv.field?.name === fieldNames.status);
    if (statusValue?.name !== "Ready") {
      failedTransitions.push(issueNumber);
    }
  }

  if (failedTransitions.length) {
    const error = new Error(`status-transition-unconverged:${failedTransitions.join(",")}`);
    error.issues = failedTransitions;
    throw error;
  }

  return { transitioned: toTransition.map((t) => t.issueNumber) };
}
