# Issue Worktree Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace persistent agent lanes with one guarded worktree per Issue, add safe session handoff, reset the local-review allowance per handoff epoch, and remove worktrees only after confirmed PR merge.

**Architecture:** `scripts/issue-worktree.sh` owns lifecycle mutations and stores versioned metadata beneath the shared Git common directory so every linked worktree sees one atomic lease. The post-commit hook resolves reviewer and epoch from that metadata, retaining prefix routing only for branches created before migration. Repository-local skills describe when to invoke the deterministic helper and when to stop.

**Tech Stack:** Bash 3.2-compatible shell, Git worktrees, `gh`, `jq`, existing local AI review hooks and smoke-test style.

## Global Constraints

- Primary clone remains human-only for implementation writes.
- One Issue maps to one `.worktrees/issue-<number>-<slug>` and one `issue-<number>-<slug>` branch.
- Never auto-stash, auto-commit, reset, clean, force-remove, or infer merge from branch ancestry.
- Handoff is session-scoped; a new session starts a new epoch with two review runs, while a repeated same-session handoff is idempotent.
- Cleanup requires GitHub PR state `MERGED` plus a clean, pushed, idle worktree.

---

### Task 1: Lifecycle helper and integration tests

**Files:**
- Create: `scripts/issue-worktree.sh`
- Create: `scripts/test-issue-worktree.sh`

**Interfaces:**
- Produces: `create`, `status`, `acquire`, `handoff`, `release`, and `cleanup` subcommands; versioned JSON metadata under the Git common directory.

- [ ] Write failing shell tests for creation, duplicate/partial state, lease conflict, same/new session epochs, dirty preservation, review-lock rejection, and merge-only cleanup.
- [ ] Run `bash scripts/test-issue-worktree.sh` and confirm failure because the helper is absent.
- [ ] Implement input validation, repository/worktree discovery, atomic metadata locking and updates, safety diagnostics, and idempotent cleanup.
- [ ] Re-run `bash scripts/test-issue-worktree.sh` and confirm all scenarios pass.

### Task 2: Metadata-based local AI review routing and epoch budget

**Files:**
- Modify: `.githooks/lib/reviewer-selection.sh`
- Modify: `.githooks/post-commit`
- Modify: `.githooks/lib/local-ai-review.sh`
- Modify: `.githooks/lib/last-reviewed.sh`
- Modify: `scripts/smoke-local-ai-review-branch-mapping.sh`

**Interfaces:**
- Consumes: lifecycle metadata selected by Issue branch number.
- Produces: reviewer, Issue number, epoch, two-review budget, and epoch-bearing artifacts/bookkeeping.

- [ ] Extend the smoke test first for Issue metadata routing, prefix migration fallback, corrupt/missing metadata diagnostics, and exhausted epoch budget.
- [ ] Run the smoke test and confirm the new cases fail.
- [ ] Implement metadata resolution and epoch propagation without weakening branch-wide diff review.
- [ ] Run branch mapping, review orchestrator, and wait-script smoke tests.

### Task 3: New and existing workflow skills

**Files:**
- Create: `skills/handoff-issue/SKILL.md`
- Create: `skills/handoff-issue/agents/openai.yaml`
- Add symlinks: `.agents/skills/handoff-issue`, `.claude/skills/handoff-issue`
- Modify: `skills/issue-implementation/SKILL.md`
- Modify: `skills/issue-implementation/agents/openai.yaml`

**Interfaces:**
- Consumes: explicit single Issue number and `scripts/issue-worktree.sh`.
- Produces: safe new-work and takeover workflows with hard stop conditions.

- [ ] Record baseline pressure scenarios showing unsafe behavior without the handoff skill.
- [ ] Write the minimal handoff skill that invokes helper diagnostics before lease mutation and requires GitHub audit context.
- [ ] Update issue implementation to create Issue worktrees and route existing work to handoff.
- [ ] Validate skill frontmatter, links, symlinks, and pressure scenarios.

### Task 4: Canonical workflow documentation and migration

**Files:**
- Modify: `docs/github-operations.md`
- Modify: `docs/local-ai-review.md`
- Modify: `docs/development.md`
- Modify: `AGENTS.md`
- Modify: `CLAUDE.md`
- Modify: `scripts/ensure-agent-worktree.sh`

**Interfaces:**
- Produces: one consistent lifecycle contract across agent instructions, workflows, hooks, and skills.

- [ ] Replace fixed-lane requirements for new Issues with Issue-scoped paths and helper commands.
- [ ] Document handoff epochs, reviewer selection, merge-only cleanup, migration fallback, and failure recovery.
- [ ] Retain `ensure-agent-worktree.sh` as a migration diagnostic that refuses new lane bootstrap.
- [ ] Search for contradictory persistent-lane instructions and remove them.

### Task 5: Verification, commit, local review, and publication

**Files:** all files above.

- [ ] Run focused shell/smoke tests and skill validation.
- [ ] Run canonical formatting, lint, typecheck, and test gates appropriate to the changed paths.
- [ ] Inspect the diff for secrets, local state, generated artifacts, and unintended user changes.
- [ ] Commit, wait for at most two local AI review runs, apply bounded fixes, push, and open a PR with `Closes #365` and epoch-aware review status.

## Skill Pressure-Test Evidence

- RED, without `handoff-issue`: the baseline agent preserved dirty WIP and
  rejected unsafe cleanup, but incorrectly carried the prior session's
  remaining review allowance forward instead of starting a new `0/2` epoch.
- GREEN, with `handoff-issue`: the agent stopped on the active review lock,
  preserved the existing worktree, required explicit takeover evidence,
  incremented the epoch for a new session even with the same agent, restored
  `0/2`, kept same-session invocation idempotent, and refused to treat `CLOSED`
  as `MERGED`.
