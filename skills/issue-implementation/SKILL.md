---
name: issue-implementation
description: Implement exactly one explicit GitHub Issue in its dedicated worktree, including reviewer-role dispatch, push, and PR creation. Use for a new single-Issue implementation; use handoff-issue when its worktree already exists.
argument-hint: "[issue-number]"
---

# Issue Implementation

Use this skill when implementing exactly one GitHub Issue from an explicit Issue
number.

## Inputs

Accept one Issue number from `$ARGUMENTS` or the user request as the skill argument. Supported
forms include:

- `#139`
- `139`

If the user asks for this workflow but gives no Issue number, ask for one Issue
number before doing repository-changing work. If the request includes multiple
Issue numbers, ask the user to choose exactly one before starting. If an input
could refer to something other than a GitHub Issue number, confirm the intended
Issue before starting.

Fetch the Issue body and comments first, then derive the branch name and
implementation scope from that Issue content.

## Issue worktree (MUST)

Canonical rules: [`docs/github-operations.md`](../../docs/github-operations.md)
§2.

- **One dedicated Issue worktree is MUST** on this skill path. Never implement,
  create a branch, or commit on the primary clone.
- **Primary clone is human-only.** Agents must not perform git writes there.
- Worktree: `.worktrees/issue-<number>-<short-english-slug>`.
- Branch: `issue-<number>-<short-english-slug>`.
- Agent identity is lifecycle metadata, not part of the path or branch.

### Start gate (before any implementation write)

1. Run `git worktree list` and inspect `scripts/issue-worktree.sh status <issue> --json`.
2. If lifecycle metadata, an Issue worktree, or an Issue branch already exists,
   do not create another. Use `handoff-issue`.
3. Create and acquire the Issue worktree with the lifecycle helper, passing the
   current agent and a non-sensitive stable session identifier:
   `bash scripts/issue-worktree.sh create <issue> <slug> --agent <agent> --session <session-id>`.
4. Move **all** subsequent operations to the absolute path printed by the helper.
5. If creation or validation fails: stop and report. No primary-tree fallback.

Keep both skill copies in sync when editing this file:

- `skills/issue-implementation/SKILL.md`
- `.agents/skills/issue-implementation/SKILL.md`

## Workflow

Follow this workflow:

1. **Issue worktree start gate** (MUST — see above). Do not skip.
2. The lifecycle helper attempts to fetch `origin/main` and atomically creates
   the named Issue branch/worktree. During a temporary fetch failure it may use
   an existing local `origin/main`, then local `main`; do not create either one
   with ad hoc Git commands.
3. Implement the Issue (all edits and commits stay in the Issue worktree).
4. Push the branch to GitHub and create a PR. Include `Closes #<issue>` in the
   PR body so GitHub closes the Issue automatically when the PR is merged.
5. Dispatch a reviewer role from a **different** verified route using
   `node scripts/project-issue-dispatch.mjs --role reviewer
   --execution-mode direct-review --review-pass 1` (plus the route, issue, release
   policy, and next-milestone flags). The reviewer works read-only in the existing
   Issue worktree: it reads the Issue acceptance criteria, the PR diff, changed
   file paths, and the test summary, then posts one PR comment whose first line is
   `role=reviewer pass=1 verdict=<PASS|NEEDS_REVISION|REJECTED>`.
   - **`PASS`**: review is complete. Include the verdict in the PR description.
   - **`NEEDS_REVISION`**: apply one implementer fix pass — push to the same
     branch and post a `role=implementer fix-cycle=1` PR comment stating what
     changed per finding. The fix pass is **not** re-reviewed. Include the
     verdict, findings, and fix summary in the PR description.
   - **`REJECTED`**: block and report. Do not apply a fix pass.

   If no distinct route is available, run on a shared route and record
   `same-route-reviewer:*` in the PR description. If route discovery fails,
   state that clearly and proceed without a reviewer pass.

## Boundaries

- Respect repository instructions, sandbox rules, external-network approval
  requirements, and destructive-command safety boundaries.
- Do not skip the Issue worktree start gate. Do not commit on the primary clone.
- Do not run an open-ended reviewer loop. This workflow allows one review pass
  and at most one implementer fix cycle; the fix pass is never re-reviewed.
- Treat PR close as distinct from merge. Close a PR only when the user or the
  repository workflow explicitly asks to close it instead of merging it.
