---
name: issue-implementation-loop
description: Repeat GitHub Issue implementation work in order from explicit Issue number inputs such as "#139", "139", or "139 140". Use when the user asks Codex to implement one or more GitHub Issues, passes GitHub Issue numbers as arguments, or asks to follow the repository Issue Implementation Loop. The workflow refreshes main, creates issue-named branches, implements, commits, waits for local AI review until NIT_ONLY or PASS with at most three repair cycles, pushes PRs, fixes CI until green, completes or closes PRs according to the requested workflow, checks remaining session limit, and continues to the next Issue without asking to start it when under the limit.
---

# Issue Implementation Loop

Use this skill when implementing one or more GitHub Issues in sequence from
explicit Issue number inputs.

## Inputs

Accept Issue numbers from the user request as the skill arguments. Supported
forms include:

- `#139`
- `139`
- `139 140 141`
- `issues #139, #140`

Before starting, normalize the inputs into an ordered list of unique Issue
numbers. Preserve the user's order. If the user asks for this loop but gives no
Issue number, ask for the Issue number list before doing repository-changing
work. If an input could refer to something other than a GitHub Issue number,
confirm the intended Issue before starting.

For each Issue number, fetch the Issue body and comments first, then derive the
branch name and implementation scope from that Issue content.

## Workflow

For each normalized Issue number, follow this loop:

1. Fetch the latest `main` branch.
2. Create a new branch named from the Issue content.
3. Implement the Issue.
4. After committing, wait for local AI review and fix findings until the review
   status is `NIT_ONLY` or `PASS`. Repeat the fix-and-review cycle at most
   three times.
5. When local development is complete, push the branch to GitHub and create a
   PR. Include `Closes #<issue>` in the PR body so GitHub closes the Issue
   automatically when the PR is merged.
6. If PR CI fails, fetch the error logs, fix the failure, and push again.
   Repeat until CI succeeds.
7. After CI succeeds, complete the PR according to the user's requested
   workflow and the repository merge policy. Close the PR instead of merging
   only when the requested workflow explicitly says to close it.
8. Check session-limit usage and stop if it is 95% or higher.
9. If session-limit usage is below 95%, repeat steps 1-8 for the next Issue
   without asking for approval to start that next Issue.

## Boundaries

- Respect repository instructions, sandbox rules, external-network approval
  requirements, and destructive-command safety boundaries.
- Do not skip local AI review unless the repository instructions explicitly
  allow it.
- Do not count a review cycle as successful unless the saved review status is
  `NIT_ONLY` or `PASS`.
- Treat PR close as distinct from merge. Close a PR only when the user or the
  repository workflow explicitly asks to close it instead of merging it.
- If later Issues depend on earlier changes, merge or otherwise integrate those
  changes before starting the dependent Issue.
- Step 6 has no fixed CI retry count. Continue while there is meaningful
  progress and session-limit usage stays below 95%; stop on external blockers
  or when the session-limit rule requires stopping.
- Stop instead of starting another Issue when session-limit usage reaches 95%
  or higher.
