---
name: orchestrate-project-issues
description: Use when coordinating multiple Soroeru GitHub Project Issues whose implementation order, dependencies, assigned AI/model, worktrees, and interruption recovery must be managed together.
---

# Orchestrate Project Issues

Coordinate many Issues while keeping each Issue's implementation inside its assigned worker. The parent owns only graph validation, routing, milestones, and exceptions.

## Inputs

Load `state/project-issue-orchestrator.yaml` automatically when it exists. The file is the
Git-ignored runtime copy of `config/project-issue-orchestrator.example.yaml` and contains
`project.owner`, `project.ownerType`, `project.number`, `run.maxParallel`,
`run.releasePolicy`, and `run.unavailableModels`. `unavailableModels: none` means an empty list.
Use `--config <path>` only for an intentional non-default file. Explicit CLI flags override YAML
values. If no YAML exists, require the Project owner/number, maximum parallel workers,
dependency release policy (`pr-created` or `merged`), and run-scoped unavailable-model list in
the invocation; reject a missing policy or assignment and never infer it.

Each minimal item must contain `number`, `title`, `url`, `status`, `startDate`, `primary`, `sub`, `model`, `order`, and `dependencies`. The primary and sub assignees must match the configured Project mapping.

Pass at least one target selector: `--issues`, `--priority`, `--iteration`, or `--size`. Repeat a
selector or use comma-separated values for OR within that selector. Different selectors are ANDed.
Selected Issues automatically include their recursive dependencies, even when those dependencies
do not match the selector fields. `Start date` is metadata only; do not pass `--run-date`.

## Start gate

1. Fetch and sanitize Project fields in one process with `node scripts/project-issue-orchestrator.mjs --dry-run --parent-agent <agent> --parent-model <model> --capabilities-file <verified-capabilities.json>`; the default YAML supplies the six stable Project/run values. Add explicit CLI flags for a one-off override, or `--config <path>` to select another YAML. Capability records use `{agent, model, role, selector, selectable, verifiable, timeoutMs}` where `agent` is the AI assignee runtime (Codex/Claude/…), not an API vendor name. Dry-run never writes state and never applies milestones unless `--simulate-milestone` is also set. Assignment metadata is parsed by the shared `project-issue-assignment` module (project-metadata and implementation-assignment blocks share one field vocabulary). GitHub cannot return a substring of an Issue body, so the mapper receives each body, counts its bytes, extracts only bounded assignment fields, and never returns or stores the body in parent state. Fetch body/comments again only inside its worker immediately before implementation.
2. For an offline fixture, use the same flags with `--input <sanitized-plan.json>`; its `options.aiSubAssignees` must come from `config/github-projects.json`.
3. Stop before any worktree or Project mutation on unknown dependencies, cycles, missing assignment fields, missing AI Sub Assignee mappings, or unavailable routing capabilities.
4. Confirm the requested parent and worker models can actually be selected. Claude Fable is a normal parent/worker candidate when the runtime exposes it. If exact selection cannot be verified, block that route; never relabel another model as Fable.

## Scheduling

- Dispatch only Issues returned in `plan.runnable`, ordered by `order` then Issue number, up to `maxParallel`.
- A run-scoped unavailable model blocks only that Issue and its dependents. Do not substitute a model or make the unavailability permanent. Recompute on the next run.
- Release a dependency only on the configured milestone: `pr-created` or `merged`. Never invent a third release condition.
- Use completion notifications and milestone events. Do not short-poll workers, logs, review files, or model availability. A single bounded fallback wakeup may detect lost notifications.
- Supply run-scoped state explicitly with `--unavailable-model`, `--state-path`, `--existing-worktree`, and `--milestone-json` or `--milestone-file`. Repeat the model/worktree flags as needed.

## Worker contract

Send only the Issue number, assigned AI/model, release policy, and next milestone to a worker. The worker fetches its own body/comments.

- No worktree: worker uses `issue-implementation`.
- Existing Issue worktree/metadata: worker uses `handoff-issue` before editing.
- Session limit, CLI interruption, rate limit, or agent change: stop dispatching new work for that Issue and route the preassigned AI Sub Assignee through `handoff-issue` in the same worktree. Preserve inherited WIP; never stash, reset, clean, copy, or create a duplicate worktree.

Workers return only `started`, `blocked`, `commit`, `review-complete`, `pr-created`, `merged`, or `failed`, plus a concise reason and exact usage telemetry when exposed. Do not return implementation logs or Issue bodies.

## State and reporting

Store only non-sensitive Issue numbers, milestones, release policy, routing labels, timestamps, and exact usage values in ignored local state. Never store credentials, Issue bodies, prompts, diffs, or personal data.

Report input, cached-input, output tokens, tool/wait calls, wall-clock duration, and fetched byte counts only when the runtime provides exact values. Use `unavailable` for absent fields. Estimates must be separately labeled and never added to exact totals.

Use this concise summary shape:

```json
{
  "routing": { "parent": "verified|unavailable" },
  "runnable": [101],
  "blocked": [{ "number": 102, "reason": "model-unavailable:Fable" }],
  "skipped": [],
  "milestones": [{ "issue": 101, "type": "pr-created" }],
  "usage": { "issues": [{ "number": 101, "usage": "unavailable" }], "total": "unavailable" }
}
```

For provider and CLI capability checks, read [provider-routing.md](references/provider-routing.md).
