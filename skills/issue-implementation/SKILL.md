---
name: issue-implementation
description: >-
  Implement exactly one GitHub Issue from an explicit Issue number such as
  "#139" or "139". Use when the user asks Codex to implement a single Issue or
  asks to follow the repository Issue Implementation workflow. The workflow
  refreshes main, creates an issue-named branch, implements and commits the
  change, then waits for local AI review results (up to two review runs total:
  an initial review and one confirming re-review after a fix pass), applying
  a fix pass after each review that has actionable findings and suppressing
  any review beyond the second, then pushes the branch and opens a PR whose
  body records the local AI review status, findings, and fixes.
---

# Issue Implementation

Use this skill when implementing exactly one GitHub Issue from an explicit Issue
number.

## Inputs

Accept one Issue number from the user request as the skill argument. Supported
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

## Workflow

Follow this workflow:

1. Fetch the latest `main` branch.
2. Create a new branch named from the Issue content.
3. Implement the Issue.
4. After committing, check the commit command's own output for
   `[local-ai-review] queued ...`. If present, wait for that result by
   running `scripts/wait-for-local-ai-review.sh --unit <unit[,unit...]>` via a
   single backgrounded shell command (Claude Code: `Bash` with
   `run_in_background: true`) so its one completion notification replaces
   manual re-checking — never a chain of short-interval wakeups or ad hoc
   `ls`/`ps`/`cat` checks against `state/ai-reviews/` in between. Pair it with
   exactly one long fallback wakeup (comfortably above the script's
   `--timeout`) as a dead-man's switch only, not a second poll loop. See
   `docs/local-ai-review.md` §10 for the script's flags and matching
   mechanics. This workflow allows **up to two local AI review runs total**
   (never open-ended, see `docs/local-ai-review.md` §6): apply a fix pass for
   the first review's actionable findings and commit it *without*
   `LOCAL_AI_REVIEW_RUNNING=1`, so the hook reviews that fix commit too (a
   confirming second review). If that second review still has actionable
   findings, apply one more fix pass and commit it *with*
   `LOCAL_AI_REVIEW_RUNNING=1` so the hook does not start a third review — the
   cap holds regardless of what the second review finds. If the first review
   already comes back with nothing actionable (`PASS`, or `NIT_ONLY` handled
   per `docs/local-ai-review.md` §7), no second review is needed.
5. When local development is complete, push the branch to GitHub and create a
   PR. Include `Closes #<issue>` in the PR body so GitHub closes the Issue
   automatically when the PR is merged. Also include the local AI review status
   for each run, the actionable findings, and what was fixed. If a review did
   not run or residual risk remains once the two-review cap is reached, state
   that clearly.

## Boundaries

- Respect repository instructions, sandbox rules, external-network approval
  requirements, and destructive-command safety boundaries.
- Do not skip local AI review unless the repository instructions explicitly
  allow it.
- Do not run an open-ended local AI review loop. This workflow allows at most
  two local AI review runs total (an initial review and one confirming
  re-review after a fix pass) — the second follow-up commit always suppresses
  further review with `LOCAL_AI_REVIEW_RUNNING=1`.
- Treat PR close as distinct from merge. Close a PR only when the user or the
  repository workflow explicitly asks to close it instead of merging it.
