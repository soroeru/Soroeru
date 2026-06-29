# GitHub Operations

This document owns **GitHub workflow rules**: trunk-based development, branch
naming, Issue workflow, commit conventions, PR descriptions, review
expectations, and merge policy.

Out of scope here: local setup and quality gate commands (see
[`development.md`](development.md)) and local AI review hook details (see
[`local-ai-review.md`](local-ai-review.md)).

## 1. Development Model

- Use trunk-based development.
- Treat `main` as the only trunk.
- Create one short-lived branch per Issue.
- Avoid direct pushes to `main`.
- Use feature flags or safe incremental changes for unfinished work that must
  merge early.
- Multiple agents may work in parallel, each in its own `git worktree` (see §2,
  *Parallel multi-agent development*).

## 2. Starting Work

Create the Issue branch directly from the latest `origin/main`, without checking
out local `main`:

```bash
git fetch origin
git switch -c <agent>/issue-<number>-<short-english-slug> origin/main
```

Do not check out local `main` to start work. Git refuses to check out the same
`main` in two working trees at once, and a `git switch main` in a shared working
tree would disrupt another agent working in parallel (see "Parallel multi-agent
development" below). The recipe above is also fully backward compatible for
single-working-tree work.

Branch examples:

- `codex/issue-123-add-user-settings`
- `claude/issue-124-fix-login-timeout`

Rules:

- Use `codex/` or `claude/` when work is performed by those tools.
- Include the Issue number.
- Keep the English slug short and descriptive.
- Record the branch name in the GitHub Issue when useful.

### Parallel multi-agent development (worktrees)

Claude and Codex can run the Issue Implementation Loop at the same time. The
loop defers branch creation to this section, so the recipe above is all the loop
needs; the loop skill itself is not modified.

Give each agent its own working tree with `git worktree` so branch switches and
working-tree state never collide:

```bash
git fetch origin
git worktree add ../Soroeru-codex  origin/main
git worktree add ../Soroeru-claude origin/main
```

Each worktree starts in detached HEAD at `origin/main` (Git prints a "detached
HEAD" notice — this is expected); the §2 recipe then creates the per-Issue
branch inside that worktree. The worktree is a persistent home for the agent
across many Issues, so it is not pinned to any single Issue branch — for the
next Issue, re-run the §2 recipe (`git fetch origin && git switch -c <new-branch>
origin/main`) from the same worktree.

- `core.hooksPath` is set with `git config --local` (stored in the shared common
  git dir, not per-worktree), so running `scripts/setup-hooks.sh` once enables
  the local AI review hook in every worktree.
- `state/ai-reviews/` (the review lock and bookkeeping) lives inside each working
  tree, so worktrees do not contend for the same review lock.
- Branch-prefix routing already separates reviewers (see §8): keep the Codex CLI
  on a `codex/*` worktree and the Claude CLI on a `claude/*` worktree, and each
  commit is reviewed by the matching reviewer automatically.

Partition the backlog into **lanes with no cross-lane dependencies**, and hand
each loop an ordered, dependency-respecting Issue list. The loop integrates a
dependency before starting a dependent Issue, so a cross-lane dependency would
serialize the two agents — zero cross-lane dependencies is what keeps them truly
parallel. Use the Issues' `blocked_by` relationships to find disjoint lanes; the
dependency-ordered list within a lane is then safe because each blocker merges
before its dependent.

If a lane needs to change a repo-wide shared file that both lanes touch —
dependency manifests (`package.json` / `package-lock.json`), shared config
(`tsconfig.json`, `.githooks/config`), or this workflow doc — coordinate with
the other lane first to avoid merge/lockfile conflicts.

## 3. Issue Workflow

Use Issues to define the goal, scope, non-scope, implementation direction, and
acceptance criteria before starting non-trivial work.

Issue templates live under `../.github/ISSUE_TEMPLATE/`.

The canonical implementation planning template is
`../.github/ISSUE_TEMPLATE/implementation-plan.md`.

Use these sections as follows:

- Goal: what the Issue should solve
- Scope: work included in the Issue
- Non-Scope: work intentionally left out
- Approach: layers, modules, documents, or workflow rules expected to change
- Files / Directories: main files or directories expected to change
- Verification: automated and manual checks
- Risks: expected regressions or hard parts
- Open Questions: decisions still needed before implementation

For small issues, remove sections that do not apply from the implementation
plan template. Keep at least Goal, Scope, Approach, Verification, and Open
Questions.

Keep implementation plans in the GitHub Issue for issue-driven work. If a PR
changes the plan materially, update the Issue or explain the change in the PR
description.

## 4. Implementation Size

- Keep each PR small enough to explain the goal, main changes, and risks.
- Separate renames, refactors, and behavior changes when practical.
- Update docs before or alongside behavior changes.
- Split broad UI / API / state changes when review quality would otherwise
  degrade.

## 5. Quality Gates

Canonical quality gate commands belong in [`development.md`](development.md).

Rules:

- Run relevant checks before committing code.
- Documentation-only changes may skip code checks if no generated output is
  affected.
- State any skipped or unavailable checks in PR notes.

## 6. Commits

- Commit meaningful, reviewable units.
- Avoid noisy generated commits.
- Use messages that explain intent.

Recommended format:

```text
<type>: <summary>
```

Examples:

- `feat: add user settings`
- `fix: handle expired sessions`
- `docs: define github workflow`

## 7. Pull Requests

PR descriptions should include:

- what changed
- why it is needed
- how it was verified
- remaining risks or skipped checks

See §8 for the local AI review convention.

## 8. Local AI Review

Setup, branch rules, skip conditions, follow-up policy, cleanup policy, output,
and troubleshooting live in [`local-ai-review.md`](local-ai-review.md). By
default, `codex/*` branches run Codex review and `claude/*` branches run Claude
review when the matching CLI is available. Local AI review output under
`state/ai-reviews/` is fast feedback, not a replacement for final judgment.

GitHub Actions based AI review is not enabled by default. If a project adds it
as fallback automation, keep PAT / secret requirements in that fallback
documentation rather than mixing them into the core workflow.

## 9. Merge Policy

- Prefer squash merge into `main`.
- Merge only after required checks pass.
- Re-run relevant checks after addressing review feedback.
- Let `Closes #<issue>` close Issues automatically when possible.
- When agents work in parallel, integrate `origin/main` before merging: `git
  fetch origin` then `git merge origin/main` (or rebase) and re-run the relevant
  checks. Keep PRs small and merge frequently so a lane does not drift far from
  `origin/main`.

## 10. Learned Operational Notes

Record durable lessons inline near the relevant workflow, Issue, or PR instead
of creating a separate learning log without a clear owner.

Examples:

- A lesson about branch naming belongs in this document.
- A lesson about local review hooks belongs in [`local-ai-review.md`](local-ai-review.md).
- A lesson about manual testing belongs in [`manual-test.md`](manual-test.md).
- A one-off decision for a specific task may stay in that Issue or PR.

Reintroduce a separate lessons document only after ownership and update
frequency are clear.
