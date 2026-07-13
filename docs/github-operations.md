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
- Multiple agents may work in parallel on different Issues, each in that
  Issue's dedicated `git worktree` (see §2).
- **Primary working tree is human-only (MUST).** The main clone (the primary
  worktree that owns `.git/`) is for the Product Owner: review, merge,
  triage, and cross-lane inspection. **Agents must never commit** (or create
  branches, amend, or otherwise perform git writes) on the primary tree.
- **Agent git writes only in Issue worktrees (MUST).** Agents perform all
  implementation writes under `.worktrees/issue-<number>-<slug>`.

## 2. Starting Work

### 2.1 Issue worktrees (MUST for agents)

Each Issue owns one agent-independent path and branch:

- worktree: `.worktrees/issue-<number>-<short-english-slug>`
- branch: `issue-<number>-<short-english-slug>`

The Issue number is the identity key. Agent/session ownership lives in
versioned lifecycle metadata under the shared Git common directory, not in the
path or branch name. This lets another session or another AI agent resume the
same local WIP without copying it.

Use `scripts/issue-worktree.sh` for lifecycle operations. Do not reproduce its
Git mutations by hand:

```bash
bash scripts/issue-worktree.sh create 365 issue-worktree-handoff \
  --agent codex --session <non-sensitive-session-id>
bash scripts/issue-worktree.sh status 365 --json
```

#### Start-of-implementation gate (MUST)

Before any agent creates a branch or edits files for Issue work — including the
`issue-implementation` skill path — the agent **MUST**:

1. Read the Issue and run `git worktree list` plus
   `scripts/issue-worktree.sh status <issue> --json`.
2. If that Issue already has lifecycle state, branch, or worktree, stop the new
   work flow and use the `handoff-issue` skill. Never create a duplicate.
3. Otherwise use `issue-worktree.sh create` with the current agent and a
   non-sensitive session identifier.
4. Move every subsequent git and file operation to the absolute path printed by
   the helper. Do not continue on the primary clone or another Issue worktree.
5. If creation, metadata validation, or cwd transition fails: stop and report.
   There is no primary-tree fallback.

`issue-implementation` treats the Issue worktree as **MUST**, not optional.

### 2.2 Create the Issue branch and worktree

`issue-worktree.sh create` verifies the GitHub Issue, attempts to fetch
`origin/main`, rejects partial or duplicate state, creates the named
branch/worktree, and starts epoch 1 with a `0/2` review budget. If the fetch is
temporarily unavailable, it may use an existing local `origin/main`, then local
`main` as a last-resort base; creation fails when none is available. Do not
implement on detached HEAD or check out local `main` in an agent worktree.

### 2.3 Parallel multi-agent development (worktrees)

Codex, Claude, Grok, and Gemini may run Issue implementation at the same time.
The repository-local Issue implementation skill defers branch creation and the
worktree gate to this section.

Parallelism is across different Issue worktrees. The same Issue worktree is
single-owner and guarded by a session lease; simultaneous editing is forbidden.

Keep agent worktrees **inside** the primary repository root under `.worktrees/`,
so they stay within sandbox write roots (especially Codex). Avoid sibling paths
such as `../Soroeru-codex`; they are easy to misconfigure against the sandbox and
force avoidable approval requests.

Operational notes:

- `core.hooksPath` is set with `git config --local` (stored in the shared common
  git dir, not per-worktree), so running `scripts/setup-hooks.sh` once enables
  the local AI review hook in every worktree.
- `state/ai-reviews/` (the review lock and bookkeeping) lives inside each working
  tree, so worktrees do not contend for the same review lock. Wait for reviews
  only under the worktree where the commit was made.
- Issue lifecycle metadata selects the current reviewer and handoff epoch (see
  §8 and `local-ai-review.md`). Agent prefixes remain a migration fallback only
  for branches created before this policy.
- Each worktree needs its own `node_modules` / tool installs if you run quality
  gates there; they are not shared automatically.
- Never repurpose a dirty Issue worktree for another Issue. Never auto-stash,
  reset, clean, or copy inherited WIP during handoff.

Use Issues' `blocked_by` relationships to choose genuinely independent work for
parallel agents. Shared-file conflicts still require coordination.

If an Issue needs to change a repo-wide shared file that another Issue touches —
dependency manifests (`package.json` / `package-lock.json`), shared config
(`tsconfig.json`, `.githooks/config`), or this workflow doc — coordinate with
the other Issue first to avoid merge/lockfile conflicts.

### 2.4 Session handoff

Use the repository-local `handoff-issue` skill with exactly one Issue number.
It must diagnose the existing lifecycle state before mutation and then call:

```bash
bash scripts/issue-worktree.sh handoff <issue> \
  --agent <codex|claude|grok|gemini> --session <non-sensitive-session-id>
```

A successful different-session handoff increments `handoff_epoch`, selects the
new current reviewer, and resets that epoch's review budget to `0/2`. This also
applies when the agent name is unchanged after a session limit. Repeating the
command from the same session is idempotent and does not reset the budget.

Do not hand off while a Git operation or local AI review is active. Preserve a
dirty worktree in place; never auto-stash, auto-commit, reset, clean, or copy it.
Record the handoff epoch, agents, redacted session identifiers, HEAD, local
state, review usage, and next step in the Issue or PR.

### 2.5 Fixed-lane migration

`.worktrees/{codex,claude,grok,gemini}` and agent-prefixed branches may remain
while existing WIP is inventoried. They are not valid starts for new Issues.
`scripts/ensure-agent-worktree.sh` is diagnosis-only during migration and must
not create a missing fixed lane. Remove legacy worktrees only after their WIP,
push state, PR state, and review processes have been checked individually.

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

### Issue-level design vs. implementation-session design docs

Design lives at two levels, scoped differently:

- **Issue-level (always, in the Issue itself)**: when filing a new Issue, record
  only the design detail needed to *start* implementation — goal, scope,
  non-scope, approach, and open questions, per the `implementation-plan.md`
  template above. This stays in the Issue body/comments, not in a committed
  file.
- **Implementation-session-level (`docs/design/`, only when the design is
  non-trivial)**: when beginning implementation of an Issue, run Plan mode
  first; if the resulting plan is substantial enough to warrant a detailed
  design (multiple components, non-obvious interactions, several review
  rounds expected), write it to `docs/design/<slug>.md` with an `Issue: #<n>`
  reference near the top. This file is the detailed design record for that
  Issue's implementation and stays in the repo afterward as history — do not
  delete it once the Issue is done.

Detailed design docs under `docs/design/` are **session-scoped reading**, not
background context to preload: when implementing a given Issue, do not read
other Issues' `docs/design/*.md` files — doing so wastes context window on
unrelated detail. The one exception is when implementation is stuck on a
design or debugging problem; in that case, searching past `docs/design/`
files for applicable prior art is fine.

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
default, `codex/*` branches run Codex review, `claude/*` branches run Claude
review, `grok/*` branches run Grok review, and `gemini/*` branches run Gemini
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

### Cleaning up after merge

Delete the Issue branch once its PR is merged — leftover branches accumulate and
obscure which work is still in flight.

- **Remote branch**: deleted automatically on merge when the repository has
  `delete_branch_on_merge` enabled (the intended config here), so merging a PR
  removes its remote branch and no manual remote deletion is needed for the
  normal flow. If that setting is ever disabled, delete the remote branch
  manually (`git push origin --delete <branch>`).
- **Local branch + stale tracking refs**: clean these up yourself after merge.
  Squash merge (the preferred merge here) does not make the branch an ancestor of
  `main`, so confirm the PR is merged (`gh pr view <n> --json state,mergedAt`)
  and force-delete:

  ```bash
  git fetch origin --prune          # drop remote-tracking refs for deleted branches
  git branch -D issue-<n>-<slug>
  ```

  For a non-squash (true) merge the branch is a `main` ancestor, so plain
  `git branch -d` suffices.

- **Local AI review artifacts**: after the review cycle settles, clean up
  `state/ai-reviews/` per the cleanup policy in
  [`local-ai-review.md`](local-ai-review.md) §8 (delete the review `*.md` and
  logs; keep `last-reviewed.json`).

For Issue worktrees, prefer the guarded command below. It requires GitHub PR
state `MERGED`, a released lease, a clean tree, no in-progress Git operation,
no active review lock, and a PR head matching the worktree HEAD:

```bash
bash scripts/issue-worktree.sh cleanup <issue> --pr <pr-number>
```

`CLOSED`, a closed Issue, deleted remote branch, or branch ancestry alone is
not proof of merge. The normal cleanup flow never force-removes a worktree.

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

## 11. Issue Labels and Priority

Labels exist so the Product Owner and AI agents can scan the backlog and quickly
judge **what kind** of Issue it is, **how risky** it is (via the `security` label,
see 11.3), and **when** to do it — and so agents can choose sensible Issue
order. Keep the scheme small: more axes mean more authoring cost
per Issue. Soroeru uses **two ordering axes** — *type* and *priority* — plus a
`security` risk marker (§11.3), a few other stackable modifier labels, and the
existing GitHub standard labels. The modifier labels (`security`, `discussion`,
`acceptance-test`) already exist in the repo; only the `priority:*` labels are new
(creation tracked as a follow-up, see 11.5).

### 11.1 Type (what kind of Issue) — reuse existing labels

Apply **exactly one** type label to every Issue. No new type labels are
introduced.

| Label           | Use for                                          |
| --------------- | ------------------------------------------------ |
| `enhancement`   | New feature or request (default for slice work)  |
| `bug`           | Defect in existing behavior                      |
| `documentation` | Docs-only changes                                |

**Modifier labels (stack freely on top of the one type label):**

| Label             | Use for                                                            |
| ----------------- | ----------------------------------------------------------------- |
| `security`        | Security / privacy work — **also the high-risk marker** (see 11.3) |
| `discussion`      | Direction must be decided through dialogue before implementation  |
| `acceptance-test` | Surfaced during Product Owner acceptance testing                  |

GitHub standard labels (`question`, `duplicate`, `invalid`, `wontfix`,
`help wanted`, `good first issue`) keep their conventional meaning.

### 11.2 Priority (when to do it) — `priority:*`

Apply **at most one** `priority:*` label. Priority is **optional**: an Issue with
no `priority:*` label is simply not yet triaged. Priority expresses *urgency /
ordering only*, not how carefully the work must be handled (see 11.3).

| Label         | Meaning                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------- |
| `priority:P0` | Do now — release blocker; active security / data-loss / privacy harm; broken main flow      |
| `priority:P1` | Soon — important for the current slice; notable UX friction; non-urgent hardening |
| `priority:P2` | Later — valuable but deferrable, typically the next slice                                    |
| `priority:P3` | Someday — nice-to-have, cleanup, or tech debt without pressing impact                        |

We use `priority:P0..P3` rather than `level:L0..L3` deliberately: Soroeru's
product model already uses **L0/L1/L2** for the Delegation Boundary
([`requirements.md`](requirements.md)), and reusing `L*` for Issue urgency would conflate the
two. Slice order (A Visibility → B Bulk Update → C Withdrawal → D Registration)
informs priority but does not replace it; the final ordering is the Product
Owner's call.

### 11.3 Priority is not risk

The `security` label — not the priority — drives **how conservatively** an Issue
is handled. A `security` Issue may be `priority:P1` (not urgent) yet still require
careful review under the Three Guards and [`security.md`](security.md). Keep the
two separate so "must be handled carefully" is never collapsed into "must be done
right now."

Tag an Issue `security` whenever it touches any of: raw-PII leakage, encryption /
key handling, network egress beyond the allowed targets, the never-bypass walls
(CAPTCHA / MFA / bot detection / access controls), or irreversible deletion of
data stored inside Soroeru.

### 11.4 Authoring rule

For each new Issue: **one type label, optionally one `priority:*`**, then add
`security` / `discussion` / `acceptance-test` if they apply.

### 11.5 Legacy title-prefix or tag mapping

Early Issues encoded type and level in title prefixes or ad-hoc tags rather than
labels (some rows below, e.g. `MVP` / `workflow` / `RFC`, are tags, not `-*`
prefixes). When triaging or relabeling them, map as follows. Every Issue still gets
**exactly one type label** (§11.1); where the table maps a prefix to a modifier
(`security` / `discussion`) or a `priority:*` label, that label **stacks on top of
a type label** — usually `enhancement` unless the Issue is clearly a `bug` or
`documentation`.

| Prefix                | Type           | Modifier / priority                     |
| --------------------- | -------------- | --------------------------------------- |
| `REQ-*`               | `enhancement`  | `priority:*` by slice                   |
| `SEC-*`, `PRIV-*`     | `enhancement`  | `security`                              |
| `SAFE-*`              | `enhancement`  | `security` or `discussion`              |
| `UI-*`, `PERF-*`      | `enhancement`  | —                                       |
| `MVP`                 | `enhancement`  | `priority:P0` / `priority:P1`           |
| `workflow`, `ci`      | `enhancement` or `documentation` | —                     |
| `RFC`, `Discovery`    | `documentation` | `discussion`                           |

Creating the `priority:*` GitHub labels and relabeling existing open Issues is
tracked as a separate follow-up so this convention can be reviewed without mixing
in a bulk migration.
