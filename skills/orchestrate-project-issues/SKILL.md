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

1. Discover worker runtimes automatically per [provider-routing.md](references/provider-routing.md). The normal path is `node scripts/project-issue-capabilities.mjs` (or omit `--capabilities-file` so the orchestrator discovers for you). Adapters run in fixed order Codex → Claude → Grok → Gemini; only verified routes become capability records `{agent, requestedModel, model, role, selector, selectable, verifiable, timeoutMs}`. Do not hand-limit the pool to Codex with a handmade capabilities file.
2. Fetch and sanitize Project fields in one process with `node scripts/project-issue-orchestrator.mjs --dry-run --parent-agent <agent> --parent-model <model>` (optional `--capabilities-file` only for tests / intentional overrides). The default YAML supplies the stable Project/run values. The dry-run and Project planner never fetch Issue bodies — dependencies come from GitHub `blockedBy` relations and Priority/Size/Status from Project fields. In opt-in graph shadow mode, only the isolated Jev triage child fetches the currently dispatchable Issue's body; the parent graph receives closed, non-sensitive results. A worker fetches its own Issue body and comments immediately before implementation.
3. Stop before any worktree mutation on unknown/cyclic `Blocked by` dependencies, open or unavailable dependency state, or an unverifiable parent route. Confirm the requested parent model can actually be selected; if exact selection cannot be verified, block that route and never relabel another model.
4. The dry-run returns `plan.runnable` (ordered by Priority then Issue number) and `workerRoutes` (the run-scoped pool of verified worker routes after excluding the Parent agent runtime and applying `--unavailable-agent` / `--unavailable-model` exclusions). Every model and selector belonging to the Parent agent is excluded: if Codex is the Parent, no Codex route may be a worker. If Issues are runnable and the remaining pool is empty, the run stops with `no-worker-route-available`; otherwise the run may proceed with fewer workers than `maxParallel`.

## Role programs

One Issue is implemented by a *sequence* of workers, not one. The plan gives every runnable
Issue a deterministic execution mode (`scripts/project-issue-modes.mjs`) and the role program
that follows from it:

| Execution mode | Selected when | Role program |
| --- | --- | --- |
| `direct-review` | **low** risk, size XS–M, shallow dependencies | implementer → reviewer |
| `plan-implement-review` | any risk above low, size L–XL, depth ≥ 2, or wide change scope | planner → implementer → reviewer |

Risk above `low` always buys a planner: `direct-review` stays eligible for medium-risk Issues,
so ranking is conditioned on risk rather than always taking the cheapest eligible mode.

Each role runs as its own CLI process on its own verified route, so a reviewer structurally
cannot see the implementer's conversation or reasoning — it reads the Issue, the worktree, and
the diff itself. `implementer` and `reviewer` take distinct routes whenever the pool holds more
than one, in both directions and across handoffs; when no distinct route remains the run
continues on a shared route and records `same-route-reviewer:*`. The first implementation role
to enter an Issue creates the worktree via `issue-implementation`; later implementation roles
resume it via `handoff-issue`. **A reviewer runs no skill at all** — both implementation skills
commit, so it enters the existing worktree read-only.

Review is bounded: a `NEEDS_REVISION` verdict buys one implementer fix pass, `REJECTED` blocks
immediately, and at most two review passes ever run. An integration-gate rejection reopens the
program at the implementer on its **own** single allowance, separate from the review passes; a
second gate rejection blocks the Issue (`integration-gate-rejected-twice`), and a reopen is
refused outright when no review pass is left to check the fix. Pass `--single-worker` to fall
back to one worker owning the whole Issue.

`parallel-analysis-implement-review` has no role program yet and is never selected.

## Dynamic assignment

The orchestrating agent assigns each runnable Issue's current role to one route from
`workerRoutes` at dispatch time, considering the Issue's Size and content against each agent's
strengths and the user's run-scoped hints. Rules:

- Choose only from `workerRoutes`; never invent a selector, substitute a nearby model name, or
  relabel a canonical identifier as a different model.
- A reviewer proposal equal to that Issue's implementer route is rejected while another route
  exists; independent review means a different runtime.
- The Parent agent runtime is never a worker route. This exclusion is by `agent`, not by model:
  a different model or selector from the same agent is still excluded. Only a different verified
  agent may receive an Issue.
- Record the chosen route (agent + model labels only) in run state and in the dispatch message.
- Exclusions are run-scoped: YAML `run.unavailableAgents` / `run.unavailableModels` and their
  `--unavailable-agent` / `--unavailable-model` CLI overrides affect only the current run, and
  availability is recomputed from fresh capability records on the next run.
- Budget snapshots are not an input to initial assignment; session limits are handled reactively
  at interruption time (below).

## Scheduling

- Dispatch only Issues returned in `plan.runnable`, in plan order, up to `maxParallel` and the
  number of remaining verified worker routes. A smaller worker pool is valid.
- Release a dependency only on the configured milestone: `pr-created` or `merged`. Never invent a third release condition.
- Use completion notifications and milestone events. Do not short-poll workers, logs, review files, or model availability. A single bounded fallback wakeup may detect lost notifications.
- Supply run-scoped state explicitly with `--unavailable-agent`, `--unavailable-model`, `--state-path`, `--existing-worktree`, and `--milestone-json` or `--milestone-file`. Repeat the agent/model/worktree flags as needed.

## Worker contract

Send only the Issue number, the role, the assigned agent/model route, the skill, release policy,
and next milestone to a worker. The worker fetches its own body/comments, diff, and test results.
Never pass Issue bodies, diffs, plans, or another role's output through the dispatch payload.

Structure every non-trivial dispatch prompt with four short labeled sections:

- **Goal:** the single role outcome.
- **Context:** Issue number, role, verified route, skill, release policy, and next milestone only.
- **Constraints:** state/privacy limits, worktree ownership, and role-specific boundaries.
- **Done when:** the observable milestone and exact concise event shape to return.

Do not embed hidden rationale or repeat repository-wide instructions that the worker loads itself.

- Launch the selected route with the same exact `selector` / `model` from discovery — for external CLIs use `node scripts/project-issue-dispatch.mjs` (or `dispatchWorker`) so non-Codex routes start through their adapter, not a Codex-only path. Role-based launches add `--role`, `--skill`, `--execution-mode`, and (for a reviewer) `--review-pass`.
- No worktree: worker uses `issue-implementation`.
- Existing Issue worktree/metadata: worker uses `handoff-issue` before editing.
- A reviewer is dispatched without `--skill` and must not run `issue-implementation` or
  `handoff-issue`; it works read-only inside the existing Issue worktree. It consults the
  Issue's acceptance criteria, the pull request body, the changed file paths, the branch diff,
  and the test summary, and returns a `PASS` / `NEEDS_REVISION` / `REJECTED` verdict.
- **Findings live on the pull request, not in run state.** The reviewer posts one PR comment
  (`gh pr comment`) whose first line is `role=reviewer pass=<N> verdict=<…>`, and the verdict
  also comes back as the `role-complete` event. GitHub's review feature is unusable here: one
  account owns both the PR and the review, so `gh pr review` is forbidden.
- **A fix pass never opens a second PR.** An implementer re-dispatched after `NEEDS_REVISION`
  receives `--fix-cycle <N>`, is told a PR already exists, reads the findings with
  `gh pr view --comments`, pushes to the same branch, and posts its own PR comment headed
  `role=implementer fix-cycle=<N>` stating what it changed per finding.
- Session limit, CLI interruption, rate limit, or agent change: stop dispatching new work for that Issue, terminate only that worker process tree, add the interrupted agent to the run's `--unavailable-agent` list, and choose the handoff recipient **at that moment** from the remaining `workerRoutes` (which never includes the Parent agent; there is no preassigned sub assignee). Route the recipient through `handoff-issue` in the same worktree. Preserve inherited WIP; never stash, reset, clean, copy, or create a duplicate worktree.
- A route that fails at actual dispatch (not just at discovery) is a signal the cached capability record no longer reflects reality. Pass `--invalidate-agent <name>` on the *next* orchestrator invocation (in addition to this run's `--unavailable-agent`) so that agent is dropped from the capability cache and re-probed instead of being trusted as "ok" indefinitely.

Workers return only `started`, `blocked`, `role-complete`, `pr-created`, `merged`, or `failed`,
plus a concise reason and exact usage telemetry when exposed. `role-complete` carries the role
and, for a reviewer, the verdict. Do not return implementation logs or Issue bodies.

Under a role program the `pr-created` milestone is reached by finishing the program — the
reviewer's `PASS` opens the gate. Reporting that milestone directly while roles are still
running is rejected (`role-program-active`), so dependents never release on unreviewed work.
Under `--release-policy merged` the program ends at `pr-created` and the run keeps waiting for
the external `merged` milestone, which is reported as an ordinary milestone event.

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

## Optional: LangGraph StateGraph runner

`node scripts/project-issue-graph.mjs --thread-id <id> …` runs this same workflow as an
explicit checkpointed state machine (see `docs/development.md` §3.1): it pauses for route
assignment, worker events, and every integration-gate verdict, and resumes with
`--resume-json`. Resume payloads are validated against the verified route pool — the rules
above (choose only from `workerRoutes`, fail closed on exhaustion, release only on the
configured milestone, preserve worktrees on handoff) are enforced by the graph itself.
The classic `project-issue-orchestrator.mjs` dry-run remains the default planning path.
With `--triage shadow`, the graph refreshes each CLI model before building the Jev
candidate pool. The assignment interrupt shows the recommendation and existing mode;
it does not adopt Jev's risk, Size, mode, or route. A fallback requires manual route
assignment even with `--auto-assign`. `--triage assisted` is unavailable until the
separate adoption Issue. The classic dry-run never fetches Issue text or calls Jev.

## State and reporting

Store only non-sensitive Issue numbers, milestones, release policy, routing labels, timestamps, and exact usage values in ignored local state. Never store credentials, Issue bodies, prompts, diffs, or personal data.

Report input, cached-input, output tokens, tool/wait calls, wall-clock duration, and fetched byte counts only when the runtime provides exact values. Use `unavailable` for absent fields. Estimates must be separately labeled and never added to exact totals.

Use this concise summary shape:

```json
{
  "routing": { "parent": "verified|unavailable" },
  "runnable": [101],
  "assignments": [{ "number": 101, "agent": "Codex", "model": "gpt-5" }],
  "roles": [{ "issue": 101, "executionMode": "direct-review", "role": "reviewer", "status": "active", "reviewPasses": 0 }],
  "blocked": [{ "number": 102, "reason": "dependencies-incomplete:101" }],
  "skipped": [],
  "milestones": [{ "issue": 101, "type": "pr-created" }],
  "usage": { "issues": [{ "number": 101, "usage": "unavailable" }], "total": "unavailable" }
}
```

For provider and CLI capability checks, read [provider-routing.md](references/provider-routing.md).
