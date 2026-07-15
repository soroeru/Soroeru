import fs from "node:fs/promises";

import {
  AI_ASSIGNEES,
  normalize,
  parseProjectMetadata,
  toAiAssignee,
} from "./project-issue-assignment.mjs";

export const DEFAULTS = Object.freeze({
  aiAssignee: "未記載",
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
 * Resolve Project field defaults. Sub-assignee reasons are distinct:
 * - missing-ai-sub-assignee-mapping: config has no entry for the primary
 * - unknown-ai-sub-assignee: supplied or mapped name is not a known assignee
 * - ai-sub-assignee-mismatch: body sub differs from the configured map
 * - ai-sub-assignee-option-missing: map target not in Project field options
 */
export function resolveDefaults(metadata, choices = {}, aiSubAssignees = {}) {
  const aiChoices = new Set(choices.aiAssignees ?? [...AI_ASSIGNEES.values()]);
  const subOptionChoices =
    choices.aiSubAssignees === undefined ? null : new Set(choices.aiSubAssignees);
  const priorityChoices = new Set(choices.priorities ?? ["P0", "P1", "P2", "P3"]);
  const sizeChoices = new Set(choices.sizes ?? ["XS", "S", "M", "L", "XL"]);
  const reasons = [];
  const suppliedAiAssignee = normalize(metadata.aiAssignee || DEFAULTS.aiAssignee);
  const aiAssignee = toAiAssignee(suppliedAiAssignee);
  if (!AI_ASSIGNEES.has(suppliedAiAssignee.toLowerCase()) || !aiChoices.has(aiAssignee))
    reasons.push("unknown-ai-assignee");

  const mappedSub = aiSubAssignees[aiAssignee];
  const suppliedAiSubAssignee = normalize(metadata.aiSubAssignee);
  let aiSubAssignee;

  if (!Object.hasOwn(aiSubAssignees, aiAssignee)) {
    reasons.push("missing-ai-sub-assignee-mapping");
    aiSubAssignee = undefined;
  } else if (!mappedSub || !AI_ASSIGNEES.has(normalize(mappedSub).toLowerCase())) {
    reasons.push("unknown-ai-sub-assignee");
    aiSubAssignee = undefined;
  } else {
    aiSubAssignee = toAiAssignee(mappedSub);
    if (suppliedAiSubAssignee) {
      if (!AI_ASSIGNEES.has(suppliedAiSubAssignee.toLowerCase()))
        reasons.push("unknown-ai-sub-assignee");
      else if (toAiAssignee(suppliedAiSubAssignee) !== aiSubAssignee)
        reasons.push("ai-sub-assignee-mismatch");
    }
    if (subOptionChoices && !subOptionChoices.has(aiSubAssignee))
      reasons.push("ai-sub-assignee-option-missing");
  }

  const priority = priorityChoices.has(metadata.priority) ? metadata.priority : DEFAULTS.priority;
  if (priority !== metadata.priority) reasons.push("invalid-priority");
  const size = sizeChoices.has(metadata.size) ? metadata.size : DEFAULTS.size;
  if (size !== metadata.size) reasons.push("invalid-size");
  return {
    aiAssignee: aiChoices.has(aiAssignee) ? aiAssignee : DEFAULTS.aiAssignee,
    aiSubAssignee,
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

export function calculateIterationDates(issueDate) {
  const date = new Date(`${issueDate}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issueDate) || Number.isNaN(date.valueOf()))
    throw new Error("invalid-issue-date");
  date.setUTCDate(date.getUTCDate() + 1);
  const next = date.toISOString().slice(0, 10);
  return { startDate: next, targetDate: next, name: next };
}

export function buildProjectQuery(ownerType) {
  const root = ownerType === "organization" ? "organization" : "user";
  return `query Project($owner: String!, $number: Int!) { ${root}(login: $owner) { projectsV2(number: $number) { id title fields(first: 100) { nodes { ... on ProjectV2Field { id name dataType } ... on ProjectV2SingleSelectField { id name dataType options { id name } } ... on ProjectV2IterationField { id name dataType configuration { duration startDay iterations { id title startDate duration } } } } } items(first: 100) { nodes { id content { ... on Issue { id number } } } } } } }`;
}

export const ADD_ITEM_MUTATION = `mutation AddItem($projectId: ID!, $contentId: ID!) { addProjectV2ItemById(input: { projectId: $projectId contentId: $contentId }) { item { id } } }`;
export const UPDATE_ITEM_MUTATION = `mutation UpdateItem($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: ProjectV2FieldValue!) { updateProjectV2ItemFieldValue(input: { projectId: $projectId itemId: $itemId fieldId: $fieldId value: $value }) { projectV2Item { id } } }`;
export const UPDATE_ITERATION_MUTATION = `mutation UpdateIteration($fieldId: ID!, $configuration: ProjectV2IterationFieldConfigurationInput!) { updateProjectV2Field(input: { fieldId: $fieldId iterationConfiguration: $configuration }) { projectV2Field { ... on ProjectV2IterationField { id configuration { iterations { id title startDate duration } } } } } }`;

export async function applyProjectDefaults({ issue, project, graphql, config = {} }) {
  if (!project) throw new Error("project-not-found");
  const metadata = parseProjectMetadata(issue.body);
  const projectName = classifyProject(issue, config.candidates ?? PROJECT_RULES);
  if (projectName && config.projectName && projectName !== config.projectName)
    throw new Error("project-classification-mismatch");
  if (!projectName && config.requireClassification) throw new Error("project-unclassified");
  const fields = new Map((project.fields?.nodes ?? []).map((field) => [field.name, field]));
  const choices = {
    aiAssignees: fields
      .get(config.fields?.aiAssignee ?? "AI Assignees")
      ?.options?.map((option) => option.name),
    aiSubAssignees: fields
      .get(config.fields?.aiSubAssignee ?? "AI Sub Assignees")
      ?.options?.map((option) => option.name),
    priorities: fields.get(config.fields?.priority ?? "Priority")?.options?.map((option) => option.name),
    sizes: fields.get(config.fields?.size ?? "Size")?.options?.map((option) => option.name),
  };
  const resolved = resolveDefaults(metadata, choices, config.aiSubAssignees ?? {});
  const invalidSubAssignee = resolved.reasons.find(
    (reason) =>
      reason === "missing-ai-sub-assignee-mapping" ||
      reason === "unknown-ai-sub-assignee" ||
      reason === "ai-sub-assignee-mismatch" ||
      reason === "ai-sub-assignee-option-missing",
  );
  if (invalidSubAssignee) throw new Error(invalidSubAssignee);
  if (!resolved.aiSubAssignee) throw new Error("missing-ai-sub-assignee-mapping");
  const dates = calculateIterationDates((issue.created_at ?? issue.createdAt ?? "").slice(0, 10));
  const aiFieldName = config.fields?.aiAssignee ?? "AI Assignees";
  const aiSubFieldName = config.fields?.aiSubAssignee ?? "AI Sub Assignees";
  const priorityFieldName = config.fields?.priority ?? "Priority";
  const sizeFieldName = config.fields?.size ?? "Size";
  const iterationFieldName = config.fields?.iteration ?? "Iteration";
  for (const [fieldName, value] of [
    [aiFieldName, resolved.aiAssignee],
    [aiSubFieldName, resolved.aiSubAssignee],
    [priorityFieldName, resolved.priority],
    [sizeFieldName, resolved.size],
  ]) {
    const field = fields.get(fieldName);
    if (!field) throw new Error(`project-field-not-found:${fieldName}`);
    if (!field.options?.some((option) => option.name === value))
      throw new Error(`project-option-not-found:${fieldName}`);
  }
  for (const fieldName of [
    config.fields?.startDate ?? "Start date",
    config.fields?.targetDate ?? "Target date",
    iterationFieldName,
  ]) {
    if (!fields.has(fieldName)) throw new Error(`project-field-not-found:${fieldName}`);
  }
  const iterationField = fields.get(iterationFieldName);
  const currentIteration = iterationField?.configuration?.iterations?.find(
    (iteration) => iteration.title === (metadata.featureGroup || dates.name),
  );
  let iteration = currentIteration;
  if (!iterationField) throw new Error("project-field-not-found:Iteration");
  if (!iteration) {
    const title = metadata.featureGroup || dates.name;
    const iterations = iterationField.configuration?.iterations ?? [];
    const updateResult = await graphql(UPDATE_ITERATION_MUTATION, {
      fieldId: iterationField.id,
      configuration: {
        duration: 1,
        startDate: iterationField.configuration?.iterations?.[0]?.startDate ?? dates.startDate,
        iterations: [
          ...iterations.map(({ title: existingTitle, startDate, duration }) => ({
            title: existingTitle,
            startDate,
            duration,
          })),
          { title, startDate: dates.startDate, duration: 1 },
        ],
      },
    });
    iteration = updateResult.updateProjectV2Field.projectV2Field.configuration.iterations.find(
      (candidate) => candidate.title === title,
    );
    if (!iteration) throw new Error("iteration-create-not-confirmed");
  }
  const issueNodeId = issue.node_id;
  if (!issueNodeId) throw new Error("issue-node-id-required");
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
  await setSingle(aiFieldName, resolved.aiAssignee);
  await setSingle(aiSubFieldName, resolved.aiSubAssignee);
  await setSingle(priorityFieldName, resolved.priority);
  await setSingle(sizeFieldName, resolved.size);
  for (const [fieldName, value] of [
    [config.fields?.startDate ?? "Start date", dates.startDate],
    [config.fields?.targetDate ?? "Target date", dates.targetDate],
  ]) {
    const field = fields.get(fieldName);
    if (!field) throw new Error(`project-field-not-found:${fieldName}`);
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
  return { itemId, projectName: project.title, iteration: iteration.title, reasons: resolved.reasons };
}

async function githubGraphql(query, variables, token) {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "soroeru-project-issue-defaults",
    },
    body: JSON.stringify({ query, variables }),
  });
  const payload = await response.json();
  if (!response.ok || payload.errors?.length) throw new Error("github-graphql-failed");
  return payload.data;
}

async function main() {
  const eventPath = process.argv[2] === "--event" ? process.argv[3] : process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error("event-path-required");
  const event = JSON.parse(await fs.readFile(eventPath, "utf8"));
  const issue = event.issue;
  if (!issue?.id || !issue.created_at) throw new Error("issue-event-required");
  const config = JSON.parse(
    await fs.readFile(new URL("../config/github-projects.json", import.meta.url), "utf8"),
  );
  const token = process.env.GH_PROJECT_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) throw new Error("project-token-required");
  const owner = process.env.GITHUB_REPOSITORY_OWNER;
  const projectName = classifyProject(
    issue,
    config.projects
      .filter((candidate) => candidate.number)
      .flatMap((candidate) => candidate.candidates ?? []),
  );
  if (!projectName) {
    console.log(JSON.stringify({ status: "not-configured", reason: "project-unclassified" }));
    return;
  }
  const projectConfig = config.projects.find((candidate) => candidate.name === projectName);
  if (!owner || !projectConfig?.number) throw new Error("project-config-incomplete");
  const ownerType = projectConfig.ownerType ?? "user";
  const data = await githubGraphql(buildProjectQuery(ownerType), { owner, number: projectConfig.number });
  const project = data[ownerType]?.projectsV2;
  const result = await applyProjectDefaults({
    issue,
    project,
    config: projectConfig,
    graphql: (query, variables) => githubGraphql(query, variables, token),
  });
  console.log(
    JSON.stringify({
      status: "updated",
      itemId: result.itemId,
      project: result.projectName,
      iteration: result.iteration,
      reasons: result.reasons,
    }),
  );
}

if (process.argv[1] === new URL(import.meta.url).pathname)
  main().catch((error) => {
    console.error(JSON.stringify({ status: "retryable-error", reason: error.message.split(":")[0] }));
    process.exitCode = 1;
  });
