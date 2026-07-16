---
name: orchestrate-project-issues
description: Use when coordinating multiple Soroeru GitHub Project Issues whose implementation order, dependencies, run-time agent/model routing, worktrees, and interruption recovery must be managed together.
---

# Orchestrate Project Issues

Coordinate many Issues while keeping each Issue's implementation inside its assigned worker. The parent owns graph validation, run-time routing decisions, milestones, the integration quality gate, and exceptions. No agent/model assignment is stored in Issues or the Project; every routing decision is made at run time and recorded in run state.

## Inputs

Load `state/project-issue-orchestrator.yaml` automatically when it exists. The file is the
Git-ignored runtime copy of `config/project-issue-orchestrator.example.yaml` and contains
`project.owner`, `project.ownerType`, `project.name`, `run.maxParallel`,
`run.releasePolicy`, `run.unavailableModels`, and `run.unavailableAgents`. An unavailable list may
be `none` or a YAML list of exact runtime labels; both lists apply only to the current run.
Use `--config <path>` only for an intentional non-default file. Explicit CLI flags override YAML
values. If no YAML exists, require the Project owner/name, maximum parallel workers, and
dependency release policy (`pr-created` or `merged`) in the invocation; reject a missing policy
and never infer it.

Each minimal item contains `number`, `title`, `url`, `status`, `priority`, `size`, and
`dependencies`. Items carry **no** agent, model, or order assignment; legacy `AI Assignees` /
`AI Sub Assignees` Project fields and `implementation-assignment` body blocks are ignored, never
rejected. `Start date` is optional metadata only; do not pass `--run-date`.

Pass at least one target selector: `--issues`, `--priority`, `--iteration`, or `--size`. Repeat a
selector or use comma-separated values for OR within that selector. Different selectors are ANDed.
Selected Issues automatically include their recursive `Blocked by` dependencies, even when those
dependencies do not match the selector fields. A closed Blocked by Issue is treated as completed;
an open one stops the run with its Issue numbers in the reason. Dependency state is read from
GitHub deterministically.

## Start gate

1. Enumerate the current runtime's callable agents and models per [provider-routing.md](references/provider-routing.md) and write the verified records to a capabilities file. Capability records use `{agent, requestedModel, model, role, selector, selectable, verifiable, timeoutMs}`; `role` is `parent` for the orchestrating route and `worker` for every route a worker could run on.
2. Fetch and sanitize Project fields in one process with `node scripts/project-issue-orchestrator.mjs --dry-run --parent-agent <agent> --parent-model <model> --capabilities-file <verified-capabilities.json>`; the default YAML supplies the stable Project/run values. Issue bodies are never fetched by the planner — dependencies come from GitHub `blockedBy` relations and Priority/Size/Status from Project fields. A worker fetches its own Issue body and comments immediately before implementation.
3. Stop before any worktree mutation on unknown/cyclic `Blocked by` dependencies, open or unavailable dependency state, or an unverifiable parent route. Confirm the requested parent model can actually be selected; if exact selection cannot be verified, block that route and never relabel another model.
4. The dry-run returns `plan.runnable` (ordered by Priority then Issue number) and `workerRoutes` (the run-scoped pool of verified worker routes after `--unavailable-agent` / `--unavailable-model` exclusions). If Issues are runnable and the pool is empty, the run stops with `no-worker-route-available`.

## Dynamic assignment

The orchestrating agent assigns each runnable Issue to one route from `workerRoutes` at dispatch
time, considering the Issue's Size and content against each agent's strengths and the user's
run-scoped hints. Rules:

- Choose only from `workerRoutes`; never invent a selector, substitute a nearby model name, or
  relabel a canonical identifier as a different model.
- Record the chosen route (agent + model labels only) in run state and in the dispatch message.
- Exclusions are run-scoped: YAML `run.unavailableAgents` / `run.unavailableModels` and their
  `--unavailable-agent` / `--unavailable-model` CLI overrides affect only the current run, and
  availability is recomputed from fresh capability records on the next run.
- Budget snapshots are not an input to initial assignment; session limits are handled reactively
  at interruption time (below).

## Scheduling

- Dispatch only Issues returned in `plan.runnable`, in plan order, up to `maxParallel`.
- Release a dependency only on the configured milestone: `pr-created` or `merged`. Never invent a third release condition.
- Use completion notifications and milestone events. Do not short-poll workers, logs, review files, or model availability. A single bounded fallback wakeup may detect lost notifications.
- Supply run-scoped state explicitly with `--unavailable-agent`, `--unavailable-model`, `--state-path`, `--existing-worktree`, and `--milestone-json` or `--milestone-file`. Repeat the agent/model/worktree flags as needed.

## Worker contract

Send only the Issue number, the assigned agent/model route, release policy, and next milestone to a worker. The worker fetches its own body/comments.

- No worktree: worker uses `issue-implementation`.
- Existing Issue worktree/metadata: worker uses `handoff-issue` before editing.
- Session limit, CLI interruption, rate limit, or agent change: stop dispatching new work for that Issue, add the interrupted agent to the run's `--unavailable-agent` list, and choose the handoff recipient **at that moment** from the remaining `workerRoutes` (there is no preassigned sub assignee). Route the recipient through `handoff-issue` in the same worktree. Preserve inherited WIP; never stash, reset, clean, copy, or create a duplicate worktree.

Workers return only `started`, `blocked`, `commit`, `review-complete`, `pr-created`, `merged`, or `failed`, plus a concise reason and exact usage telemetry when exposed. Do not return implementation logs or Issue bodies.

## Integration quality gate

On each `pr-created` (or `merged`, per release policy) milestone the parent runs an
integration-scope review before releasing dependents. The gate checks only:

- conflicts with other Issues in the same run (same files, same contracts, incompatible edits);
- contract consistency with the Issues it depends on and the Issues that depend on it
  (interfaces, schemas, documented behavior);
- coverage of the Issue's stated acceptance criteria.

Full implementation review is out of scope here — it belongs to the local AI review hook and PR
review. If the gate finds a problem, return the Issue to its worker with a concise reason and do
not release dependents; otherwise record the milestone. The gate reads the PR diff and the
related Issues' acceptance criteria; it never copies Issue bodies or diffs into parent state.

## State and reporting

Store only non-sensitive Issue numbers, milestones, release policy, routing labels, timestamps, and exact usage values in ignored local state. Never store credentials, Issue bodies, prompts, diffs, or personal data.

Report input, cached-input, output tokens, tool/wait calls, wall-clock duration, and fetched byte counts only when the runtime provides exact values. Use `unavailable` for absent fields. Estimates must be separately labeled and never added to exact totals.

Use this concise summary shape:

```json
{
  "routing": { "parent": "verified|unavailable" },
  "runnable": [101],
  "assignments": [{ "number": 101, "agent": "Codex", "model": "gpt-5" }],
  "blocked": [{ "number": 102, "reason": "dependencies-incomplete:101" }],
  "skipped": [],
  "milestones": [{ "issue": 101, "type": "pr-created" }],
  "usage": { "issues": [{ "number": 101, "usage": "unavailable" }], "total": "unavailable" }
}
```

For provider and CLI capability checks, read [provider-routing.md](references/provider-routing.md).
