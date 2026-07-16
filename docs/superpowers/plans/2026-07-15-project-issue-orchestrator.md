# Project Issue Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add deterministic, resumable orchestration of Project Issues with primary/sub AI assignment, dependency-safe scheduling, dry runs, and honest usage reporting.

**Architecture:** Keep `SKILL.md` as the orchestration contract. Put Project metadata parsing, DAG validation, runnable selection, state transitions, and report generation in a side-effect-free Node module with a thin CLI. Extend the existing Project defaults automation so every Issue has a validated AI Sub Assignee before any Project mutation.

**Tech Stack:** Node.js 22 ESM, `node:test`, JSON configuration, Markdown Codex skills, GitHub Projects V2 GraphQL.

## Global Constraints

- Existing Issue worktrees must be resumed only with `handoff-issue`; inherited WIP must not be reset, cleaned, stashed, or copied.
- Missing/unknown AI Sub Assignee metadata, field, option, dependency, or model assignment blocks execution before mutation.
- Model unavailability is per run and never causes an implicit fallback.
- Dry-run performs no GitHub, git, worktree, PR, or state mutation.
- Exact token usage is reported only when supplied by a runtime; otherwise it is `unavailable`.
- Parent orchestration consumes only minimal Issue/assignment metadata and milestone events, never full Issue bodies or implementation logs.

---

### Task 1: AI Sub Assignee defaults

**Files:**

- Modify: `config/github-projects.json`
- Modify: `scripts/project-issue-defaults.mjs`
- Modify: `tests/unit/project-issue-defaults.test.mjs`
- Modify: `skills/create-issue/SKILL.md`
- Modify: `skills/create-issue/agents/openai.yaml`

**Interfaces:**

- Consumes: project metadata block and `projectConfig.aiSubAssignees` mapping.
- Produces: `parseProjectMetadata().aiSubAssignee`, `resolveDefaults(...).aiSubAssignee`, and an atomic Project update for `AI Sub Assignees`.

- [ ] Add failing tests for parsing, deterministic primary-to-sub mapping, missing Project field/option with zero mutations, and the extra single-select update.
- [ ] Run `node --test tests/unit/project-issue-defaults.test.mjs` and confirm failures are caused by missing sub-assignee support.
- [ ] Add `fields.aiSubAssignee`, a complete primary-to-sub mapping, metadata parsing/resolution, preflight validation, and the extra mutation.
- [ ] Update `create-issue` examples and contract to require the mapped sub-assignee and `handoff-issue` on session interruption.
- [ ] Run the unit test and `uv run python "$HOME/.codex/skills/.system/skill-creator/scripts/quick_validate.py" skills/create-issue`.

### Task 2: Deterministic orchestration engine

**Files:**

- Create: `scripts/project-issue-orchestrator.mjs`
- Create: `tests/unit/project-issue-orchestrator.test.mjs`
- Create: `tests/fixtures/project-issue-orchestrator/*.json`

**Interfaces:**

- Consumes: sanitized minimal Project items with number/title/url/status/startDate/primary/sub/model/order/dependencies and run options.
- Produces: validated DAG, runnable groups, blocked/skipped reasons, milestone-driven state, and usage report.

- [ ] Add failing tests for A→B→C, A→B/C, cycle/unknown dependency, missing assignment/sub-assignee, temporary unavailable model and recovery, existing-worktree handoff routing, telemetry available/unavailable, and mutation-free dry-run.
- [ ] Run `node --test tests/unit/project-issue-orchestrator.test.mjs` and confirm the module-not-found RED state.
- [ ] Implement pure parsing/validation/scheduling/report functions and a JSON-in/JSON-out CLI that writes state only outside dry-run.
- [ ] Run both orchestrator and Project defaults unit tests.

### Task 3: Orchestrator skill and verification

**Files:**

- Create: `skills/orchestrate-project-issues/SKILL.md`
- Create: `skills/orchestrate-project-issues/agents/openai.yaml`
- Create: `skills/orchestrate-project-issues/references/provider-routing.md`
- Modify: `docs/development.md`

**Interfaces:**

- Consumes: Task 2 CLI dry-run/execute plans and milestone events.
- Produces: concise operator workflow enforcing assignment, handoff, model, worktree, polling, and reporting boundaries.

- [x] Record the pre-skill pressure-scenario gaps in the orchestrator test names/results, then write the minimal skill contract that closes them.
- [x] Document provider/runtime capability detection separately and prohibit silent fallback, short polling, and full-body parent fetches.
- [x] Generate `agents/openai.yaml` and validate both skills with `quick_validate.py`.
- [x] Run format, targeted tests, and repository quality gates appropriate to scripts/skills.
- [x] Self-review the complete branch against every Issue #396 acceptance criterion.

## Pressure comparison evidence

The pre-skill static baseline had no shared contract for DAG validation, run-scoped model outages, Fable verification, parent-context minimization, milestone waiting, or unavailable usage. Existing single-Issue skills already partially protected worktrees and local-review waiting. A general-agent pressure run also invented its own dependency release condition and bounded polling cadence, demonstrating the missing orchestration contract.

After applying `orchestrate-project-issues`, the same combined scenario failed closed before mutation: unknown dependency `#999`, unverified Fable parent/worker routes, and a run-scoped unavailable Gemini model were reported separately; the dirty worktree routed only through `handoff-issue`; `merged` was the only release milestone; waiting became notification-driven; and all absent usage stayed `unavailable`. The capability interface was unavailable in that evaluation runtime, so Fable correctly remained blocked instead of being silently substituted.
