import fs from "node:fs/promises";

import { normalize, parseProjectMetadata } from "./project-issue-assignment.mjs";

export const DEFAULTS = Object.freeze({
  priority: "P2",
  size: "M",
});

export { parseProjectMetadata };

const PROJECT_RULES = [
  { name: "Visibility", keywords: ["visibility", "開示", "台帳", "サイト情報"] },
  { name: "Bulk Update", keywords: ["bulk update", "一括更新", "住所一括"] },
  {
    name: "Registration / Form Automation",
    keywords: ["registration", "form automation", "フォーム自動入力", "登録"],
  },
];

/**
 * Resolve Project field defaults for the remaining metadata vocabulary
 * (Priority / Size). Agent assignment is decided at orchestration run time
 * and is never resolved or stored here.
 */
export function resolveDefaults(metadata, choices = {}) {
  const priorityChoices = new Set(choices.priorities ?? ["P0", "P1", "P2", "P3"]);
  const sizeChoices = new Set(choices.sizes ?? ["XS", "S", "M", "L", "XL"]);
  const reasons = [];
  const priority = priorityChoices.has(metadata.priority) ? metadata.priority : DEFAULTS.priority;
  if (priority !== metadata.priority) reasons.push("invalid-priority");
  const size = sizeChoices.has(metadata.size) ? metadata.size : DEFAULTS.size;
  if (size !== metadata.size) reasons.push("invalid-size");
  return {
    priority: priorityChoices.has(priority) ? priority : ([...priorityChoices][0] ?? DEFAULTS.priority),
    size: sizeChoices.has(size) ? size : ([...sizeChoices][0] ?? DEFAULTS.size),
    reasons,
  };
}

export function classifyProject(issue, candidates = PROJECT_RULES) {
  const labels = (issue.labels ?? [])
    .map((label) => (typeof label === "string" ? label : (label.name ?? "")))
    .join(" ");
  const haystack = `${normalize(issue.title)} ${normalize(issue.body)} ${labels}`.toLowerCase();
  const matches = candidates.filter((candidate) =>
    candidate.keywords.some((keyword) => haystack.includes(keyword.toLowerCase())),
  );
  return matches.length === 1 ? matches[0].name : null;
}

export function selectProjectConfig(issue, projects) {
  const configured = (projects ?? []).filter((candidate) => candidate?.number);
  if (configured.length === 1) {
    return { ...configured[0], requireClassification: false };
  }
  const projectName = classifyProject(
    issue,
    configured.flatMap((candidate) => candidate.candidates ?? []),
  );
  if (projectName) {
    return configured.find((candidate) => candidate.name === projectName) ?? null;
  }
  return null;
}

export function calculateIterationDates(issueDate) {
  const date = new Date(`${issueDate}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issueDate) || Number.isNaN(date.valueOf()))
    throw new Error("invalid-issue-date");
  date.setUTCDate(date.getUTCDate() + 1);
  const next = date.toISOString().slice(0, 10);
  return { startDate: next, targetDate: next, name: next };
}

export function buildProjectQuery(ownerType) {
  // GraphQL exposes a single project as projectV2(number:); projectsV2 is a
  // connection and does not accept `number` (that shape returns GraphQL errors).
  // Only organization projects are supported.
  if (ownerType !== "organization") throw new Error("invalid-owner-type");
  return `query Project($owner: String!, $number: Int!, $cursor: String) { organization(login: $owner) { projectV2(number: $number) { id title fields(first: 100) { nodes { ... on ProjectV2Field { id name dataType } ... on ProjectV2SingleSelectField { id name dataType options { id name } } ... on ProjectV2IterationField { id name dataType configuration { duration startDay iterations { id title startDate duration } } } } } items(first: 100, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { id content { ... on Issue { id number body } } fieldValues(first: 100) { nodes { ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { name } } } ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { name } } } ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2FieldCommon { name } } } ... on ProjectV2ItemFieldIterationValue { title field { ... on ProjectV2FieldCommon { name } } } } } } } } } }`;
}

export const ADD_ITEM_MUTATION = `mutation AddItem($projectId: ID!, $contentId: ID!) { addProjectV2ItemById(input: { projectId: $projectId contentId: $contentId }) { item { id } } }`;
export const UPDATE_ITEM_MUTATION = `mutation UpdateItem($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: ProjectV2FieldValue!) { updateProjectV2ItemFieldValue(input: { projectId: $projectId itemId: $itemId fieldId: $fieldId value: $value }) { projectV2Item { id } } }`;
export const UPDATE_ITERATION_MUTATION = `mutation UpdateIteration($fieldId: ID!, $configuration: ProjectV2IterationFieldConfigurationInput!) { updateProjectV2Field(input: { fieldId: $fieldId iterationConfiguration: $configuration }) { projectV2Field { ... on ProjectV2IterationField { id configuration { duration startDay iterations { id title startDate duration } } } } } }`;
export const ITERATION_FIELD_QUERY = `query IterationField($fieldId: ID!) { node(id: $fieldId) { ... on ProjectV2IterationField { id configuration { duration startDay iterations { id title startDate duration } } } } }`;
export const ITEM_FIELD_VALUES_QUERY = `query ItemFieldValues($itemId: ID!) { node(id: $itemId) { ... on ProjectV2Item { fieldValues(first: 100) { nodes { ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { name } } } ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2FieldCommon { name } } } ... on ProjectV2ItemFieldIterationValue { title field { ... on ProjectV2FieldCommon { name } } } ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { name } } } } } } } }`;

export function selectReconciliationIssueNumbers(project, config = {}) {
  return (project?.items?.nodes ?? []).flatMap((item) => {
    if (!item.content?.id || !Number.isSafeInteger(item.content.number)) return [];
    const metadata = parseProjectMetadata(item.content.body ?? "");
    const requiredFields = [
      config.fields?.priority ?? "Priority",
      config.fields?.size ?? "Size",
      config.fields?.startDate ?? "Start date",
      config.fields?.targetDate ?? "Target date",
      config.fields?.iteration ?? "Iteration",
      ...(metadata.featureGroup
        ? [config.fields?.featureGroup ?? "Feature group"]
        : []),
    ];
    const observed = new Map(
      (item.fieldValues?.nodes ?? []).map((value) => [
        value.field?.name,
        value.name ?? value.text ?? value.date ?? value.title,
      ]),
    );
    return requiredFields.some((fieldName) => !observed.get(fieldName))
      ? [item.content.number]
      : [];
  });
}

export async function loadProjectPages({ owner, ownerType, number, graphql }) {
  if (typeof graphql !== "function") throw new Error("graphql-required");
  const query = buildProjectQuery(ownerType);
  const nodes = [];
  let cursor = null;
  let project = null;
  while (true) {
    const data = await graphql(query, { owner, number, cursor });
    const pageProject = data?.[ownerType]?.projectV2;
    if (!pageProject) throw new Error("project-not-found");
    if (!Array.isArray(pageProject.items?.nodes)) throw new Error("project-items-not-found");
    project ??= pageProject;
    nodes.push(...pageProject.items.nodes);
    if (!pageProject.items.pageInfo?.hasNextPage) break;
    if (!pageProject.items.pageInfo.endCursor)
      throw new Error("project-pagination-cursor-missing");
    cursor = pageProject.items.pageInfo.endCursor;
  }
  return {
    ...project,
    items: {
      ...project.items,
      nodes,
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  };
}

/**
 * Pick a startDate that does not collide with existing iterations.
 * GitHub rejects or drops new iterations that reuse an occupied startDate.
 */
export function nextAvailableIterationStartDate(existingIterations, preferredStartDate) {
  const used = new Set(
    (existingIterations ?? []).map((iteration) => iteration.startDate).filter(Boolean),
  );
  let candidate = preferredStartDate;
  for (let i = 0; i < 366; i += 1) {
    if (!used.has(candidate)) return candidate;
    const date = new Date(`${candidate}T00:00:00Z`);
    if (Number.isNaN(date.valueOf())) throw new Error("invalid-issue-date");
    date.setUTCDate(date.getUTCDate() + 1);
    candidate = date.toISOString().slice(0, 10);
  }
  throw new Error("iteration-start-date-unavailable");
}

/**
 * Build ProjectV2IterationFieldConfigurationInput for adding one iteration.
 * Schema (current GitHub API): { startDate!, duration!, iterations! } where each
 * iteration is { title, startDate, duration } — no field-level startDay and no
 * per-iteration id on the input object.
 */
export function buildIterationConfiguration(iterationField, { title, startDate, duration = 1 }) {
  const configuration = iterationField?.configuration ?? {};
  const existing = configuration.iterations ?? [];
  const newStartDate = nextAvailableIterationStartDate(existing, startDate);
  const iterations = [
    ...existing.map((iteration) => ({
      title: iteration.title,
      startDate: iteration.startDate,
      duration: iteration.duration ?? duration,
    })),
    { title, startDate: newStartDate, duration },
  ];
  return {
    startDate: iterations[0]?.startDate ?? newStartDate,
    duration: configuration.duration ?? duration,
    iterations,
  };
}

function findIterationByTitle(iterations, title) {
  return (iterations ?? []).find((candidate) => candidate.title === title) ?? null;
}

/**
 * Fail-close Project configuration: every read and validation completes
 * before the first mutation, and a final readback confirms all fields
 * converged. Reruns reuse the existing item and exact-name iteration, so a
 * partial failure is recovered by executing the workflow again.
 */
export async function applyProjectDefaults({ issue, project, graphql, config = {} }) {
  if (!project) throw new Error("project-not-found");
  const metadata = parseProjectMetadata(issue.body);
  const projectName = classifyProject(issue, config.candidates ?? PROJECT_RULES);
  if (projectName && config.projectName && projectName !== config.projectName)
    throw new Error("project-classification-mismatch");
  if (!projectName && config.requireClassification) throw new Error("project-unclassified");
  const fields = new Map((project.fields?.nodes ?? []).map((field) => [field.name, field]));
  const choices = {
    priorities: fields.get(config.fields?.priority ?? "Priority")?.options?.map((option) => option.name),
    sizes: fields.get(config.fields?.size ?? "Size")?.options?.map((option) => option.name),
  };
  const resolved = resolveDefaults(metadata, choices);
  const dates = calculateIterationDates((issue.created_at ?? issue.createdAt ?? "").slice(0, 10));
  const priorityFieldName = config.fields?.priority ?? "Priority";
  const sizeFieldName = config.fields?.size ?? "Size";
  const startDateFieldName = config.fields?.startDate ?? "Start date";
  const targetDateFieldName = config.fields?.targetDate ?? "Target date";
  const iterationFieldName = config.fields?.iteration ?? "Iteration";
  const featureGroupFieldName = config.fields?.featureGroup ?? "Feature group";
  for (const [fieldName, value] of [
    [priorityFieldName, resolved.priority],
    [sizeFieldName, resolved.size],
  ]) {
    const field = fields.get(fieldName);
    if (!field) throw new Error(`project-field-not-found:${fieldName}`);
    if (field.dataType !== "SINGLE_SELECT")
      throw new Error(`project-field-type-mismatch:${fieldName}`);
    if (!field.options?.some((option) => option.name === value))
      throw new Error(`project-option-not-found:${fieldName}`);
  }
  for (const [fieldName, dataType] of [
    [startDateFieldName, "DATE"],
    [targetDateFieldName, "DATE"],
    [iterationFieldName, "ITERATION"],
  ]) {
    const field = fields.get(fieldName);
    if (!field) throw new Error(`project-field-not-found:${fieldName}`);
    if (field.dataType !== dataType) throw new Error(`project-field-type-mismatch:${fieldName}`);
  }
  if (metadata.featureGroup) {
    const featureGroupField = fields.get(featureGroupFieldName);
    if (!featureGroupField) throw new Error(`project-field-not-found:${featureGroupFieldName}`);
    if (featureGroupField.dataType !== "TEXT")
      throw new Error(`project-field-type-mismatch:${featureGroupFieldName}`);
  }
  const issueNodeId = issue.node_id;
  if (!issueNodeId) throw new Error("issue-node-id-required");
  const iterationField = fields.get(iterationFieldName);
  const iterationTitle = metadata.featureGroup || dates.name;

  // All reads and validations are complete; mutations start here.
  let iteration = findIterationByTitle(iterationField.configuration?.iterations, iterationTitle);
  if (!iteration) {
    // ProjectV2IterationFieldConfigurationInput requires duration + startDay (not
    // startDate at the field level). Preserve existing iteration ids so GitHub
    // updates rather than replacing the series.
    const configuration = buildIterationConfiguration(iterationField, {
      title: iterationTitle,
      startDate: dates.startDate,
      duration: 1,
    });
    const updateResult = await graphql(UPDATE_ITERATION_MUTATION, {
      fieldId: iterationField.id,
      configuration,
    });
    iteration = findIterationByTitle(
      updateResult?.updateProjectV2Field?.projectV2Field?.configuration?.iterations,
      iterationTitle,
    );
    if (!iteration) {
      const refreshed = await graphql(ITERATION_FIELD_QUERY, { fieldId: iterationField.id });
      iteration = findIterationByTitle(refreshed?.node?.configuration?.iterations, iterationTitle);
    }
    if (!iteration) throw new Error("iteration-create-not-confirmed");
  }
  const existing = project.items?.nodes?.find((item) => item.content?.id === issueNodeId);
  const itemId =
    existing?.id ??
    (await graphql(ADD_ITEM_MUTATION, { projectId: project.id, contentId: issueNodeId })).addProjectV2ItemById
      .item.id;
  const setSingle = async (fieldName, value) => {
    const field = fields.get(fieldName);
    const option = field?.options?.find((candidate) => candidate.name === value);
    if (!field || !option) throw new Error(`project-option-not-found:${fieldName}`);
    await graphql(UPDATE_ITEM_MUTATION, {
      projectId: project.id,
      itemId,
      fieldId: field.id,
      value: { singleSelectOptionId: option.id },
    });
  };
  await setSingle(priorityFieldName, resolved.priority);
  await setSingle(sizeFieldName, resolved.size);
  for (const [fieldName, value] of [
    [startDateFieldName, dates.startDate],
    [targetDateFieldName, dates.targetDate],
  ]) {
    const field = fields.get(fieldName);
    await graphql(UPDATE_ITEM_MUTATION, {
      projectId: project.id,
      itemId,
      fieldId: field.id,
      value: { date: value },
    });
  }
  await graphql(UPDATE_ITEM_MUTATION, {
    projectId: project.id,
    itemId,
    fieldId: iterationField.id,
    value: { iterationId: iteration.id },
  });
  if (metadata.featureGroup) {
    await graphql(UPDATE_ITEM_MUTATION, {
      projectId: project.id,
      itemId,
      fieldId: fields.get(featureGroupFieldName).id,
      value: { text: metadata.featureGroup },
    });
  }

  // Final readback: success only when every field converged. The error names
  // only Project field names — never Issue bodies, tokens, or diffs.
  const readback = await graphql(ITEM_FIELD_VALUES_QUERY, { itemId });
  if (!readback?.node || !Array.isArray(readback.node.fieldValues?.nodes))
    throw new Error("project-readback-unavailable");
  const observed = new Map(
    readback.node.fieldValues.nodes.map((value) => [
      value.field?.name,
      value.name ?? value.date ?? value.title ?? value.text,
    ]),
  );
  const expected = [
    [priorityFieldName, resolved.priority],
    [sizeFieldName, resolved.size],
    [startDateFieldName, dates.startDate],
    [targetDateFieldName, dates.targetDate],
    [iterationFieldName, iteration.title],
    ...(metadata.featureGroup ? [[featureGroupFieldName, metadata.featureGroup]] : []),
  ];
  const unconverged = expected
    .filter(([fieldName, value]) => observed.get(fieldName) !== value)
    .map(([fieldName]) => fieldName);
  if (unconverged.length) {
    const error = new Error(`project-fields-unconverged:${unconverged.join(",")}`);
    error.fields = unconverged;
    throw error;
  }
  return { itemId, projectName: project.title, iteration: iteration.title, reasons: resolved.reasons };
}

/**
 * Map GraphQL transport/API failures to stable retryable reasons.
 * Only uses error type/message codes from GitHub — never Issue bodies or tokens.
 */
export function reasonFromGraphqlFailure(responseOk, payload) {
  if (!responseOk) return "github-graphql-http-failed";
  const errors = payload?.errors;
  if (!Array.isArray(errors) || errors.length === 0) return null;
  const first = errors[0] ?? {};
  const message = String(first.message ?? "");
  const type = String(first.type ?? "");
  if (type === "FORBIDDEN" || /not accessible by integration/i.test(message))
    return "github-graphql-forbidden";
  if (type === "NOT_FOUND" || /could not resolve/i.test(message)) return "github-graphql-not-found";
  if (/rate limit/i.test(message)) return "github-graphql-rate-limited";
  return "github-graphql-failed";
}

async function githubGraphql(query, variables, token) {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "soroeru-project-issue-defaults",
    },
    body: JSON.stringify({ query, variables }),
  });
  const payload = await response.json();
  const reason = reasonFromGraphqlFailure(response.ok, payload);
  if (reason) throw new Error(reason);
  return payload.data;
}

export function toRetryableErrorPayload(error) {
  const [reason] = String(error.message).split(":");
  const payload = { status: "retryable-error", reason };
  // Project field names are the only detail safe to surface; they tell the
  // rerun which fields did not converge without echoing Issue contents.
  if (reason === "project-fields-unconverged" && Array.isArray(error.fields))
    payload.fields = error.fields;
  return payload;
}

/**
 * Shape a GitHub Issue (event or REST) into the closed form used by applyProjectDefaults.
 * Never logs body/title; callers must keep payloads out of Actions logs.
 */
export function shapeIssueRecord(issue) {
  if (issue == null || typeof issue !== "object") throw new Error("issue-event-required");
  if (issue.pull_request) throw new Error("pull-request-not-supported");
  if (issue.id == null || !issue.created_at) throw new Error("issue-event-required");
  if (!issue.node_id) throw new Error("issue-node-id-required");
  return {
    id: issue.id,
    node_id: issue.node_id,
    number: issue.number,
    title: issue.title ?? "",
    body: issue.body ?? "",
    labels: issue.labels ?? [],
    created_at: issue.created_at,
  };
}

export function parseIssueNumberInput(value) {
  const raw = String(value ?? "").trim();
  if (!/^[1-9]\d*$/.test(raw)) throw new Error("invalid-issue-number");
  const number = Number(raw);
  if (!Number.isSafeInteger(number)) throw new Error("invalid-issue-number");
  return number;
}

/**
 * Normalize issues.opened and workflow_dispatch(issue_number) into one Issue shape.
 * For workflow_dispatch, issueNumber is required and issue is loaded separately.
 */
export function normalizeProjectIssueEvent(event, { repositoryFullName } = {}) {
  if (event == null || typeof event !== "object") throw new Error("issue-event-required");

  const eventRepo = event.repository?.full_name;
  if (repositoryFullName && eventRepo && eventRepo !== repositoryFullName)
    throw new Error("repository-mismatch");

  const hasDispatchInput =
    event.inputs != null && Object.prototype.hasOwnProperty.call(event.inputs, "issue_number");

  if (hasDispatchInput && !event.issue) {
    return {
      source: "workflow_dispatch",
      issueNumber: parseIssueNumberInput(event.inputs.issue_number),
      issue: null,
    };
  }

  if (event.schedule && !event.issue) {
    return {
      source: "schedule",
      issueNumber: null,
      issue: null,
    };
  }

  if (event.issue) {
    return {
      source: "issues.opened",
      issueNumber: event.issue.number ?? null,
      issue: shapeIssueRecord(event.issue),
    };
  }

  throw new Error("issue-event-required");
}

export async function loadRepositoryIssue(
  { owner, repo, issueNumber, token },
  fetchImpl = globalThis.fetch,
) {
  if (!owner || !repo) throw new Error("repository-env-required");
  if (!token) throw new Error("project-token-required");
  const number = parseIssueNumberInput(issueNumber);
  const response = await fetchImpl(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "soroeru-project-issue-defaults",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (response.status === 404) throw new Error("issue-not-found");
  if (!response.ok) throw new Error("issue-fetch-failed");
  const payload = await response.json();
  if (payload.pull_request) throw new Error("pull-request-not-supported");
  if (payload.number !== number) throw new Error("issue-number-mismatch");
  return shapeIssueRecord(payload);
}

async function main() {
  const eventPath = process.argv[2] === "--event" ? process.argv[3] : process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error("event-path-required");
  const event = JSON.parse(await fs.readFile(eventPath, "utf8"));
  const config = JSON.parse(
    await fs.readFile(new URL("../config/github-projects.json", import.meta.url), "utf8"),
  );
  // Prefer the short-lived App installation token. Do not fall back to a PAT secret.
  const token = process.env.GH_PROJECT_TOKEN;
  if (!token) throw new Error("project-token-required");

  const repositoryFullName = process.env.GITHUB_REPOSITORY;
  const [repoOwner, repoName] = (repositoryFullName ?? "").split("/");
  if (!repoOwner || !repoName) throw new Error("repository-env-required");

  const normalized = normalizeProjectIssueEvent(event, { repositoryFullName });
  const loadProject = async (projectConfig) => {
    const projectOwner =
      projectConfig?.owner || process.env.GITHUB_REPOSITORY_OWNER || repoOwner;
    if (!projectOwner || !projectConfig?.number) throw new Error("project-config-incomplete");
    const ownerType = projectConfig.ownerType ?? "organization";
    return loadProjectPages({
      owner: projectOwner,
      ownerType,
      number: projectConfig.number,
      graphql: (query, variables) => githubGraphql(query, variables, token),
    });
  };
  const applyIssueNumber = async (issueNumber, source, issueRecord = null) => {
    const issue =
      issueRecord ??
      (await loadRepositoryIssue({
        owner: repoOwner,
        repo: repoName,
        issueNumber,
        token,
      }));
    const projectConfig = selectProjectConfig(issue, config.projects);
    if (!projectConfig) return null;
    const result = await applyProjectDefaults({
      issue,
      project: await loadProject(projectConfig),
      config: projectConfig,
      graphql: (query, variables) => githubGraphql(query, variables, token),
    });
    return { ...result, source };
  };

  if (normalized.source === "schedule") {
    if (config.projects.length !== 1) throw new Error("project-config-ambiguous");
    const projectConfig = { ...config.projects[0], requireClassification: false };
    const issueNumbers = selectReconciliationIssueNumbers(
      await loadProject(projectConfig),
      projectConfig,
    );
    const results = [];
    for (const issueNumber of issueNumbers) {
      const result = await applyIssueNumber(issueNumber, normalized.source);
      if (result) results.push(result);
    }
    console.log(
      JSON.stringify({
        status: "reconciled",
        updated: results.length,
        source: normalized.source,
      }),
    );
    return;
  }

  const result = await applyIssueNumber(
    normalized.issueNumber,
    normalized.source,
    normalized.issue,
  );
  if (!result) {
    console.log(JSON.stringify({ status: "not-configured", reason: "project-unclassified" }));
    return;
  }
  console.log(
    JSON.stringify({
      status: "updated",
      itemId: result.itemId,
      project: result.projectName,
      iteration: result.iteration,
      reasons: result.reasons,
      source: result.source,
    }),
  );
}

if (process.argv[1] === new URL(import.meta.url).pathname)
  main().catch((error) => {
    console.error(JSON.stringify(toRetryableErrorPayload(error)));
    process.exitCode = 1;
  });
