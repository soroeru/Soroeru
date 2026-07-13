# Local AI Review

This document owns the **local Git hook for AI review**: purpose, setup,
configuration, branch rules, review target, skip conditions, follow-up policy,
cleanup policy, output, waiting for completion, and troubleshooting.

Out of scope here: GitHub PR workflow expectations (see
[`github-operations.md`](github-operations.md)) and general development setup
(see [`development.md`](development.md)).

## 1. Purpose

The local AI review hook provides fast reviewer feedback near the point where
work is committed. It is intended to catch documentation, workflow, and code
review issues before or alongside PR review without depending on GitHub Actions.

The hook:

- runs after local commits on Issue branches with valid lifecycle metadata;
- reviews the branch-wide diff rather than only the latest commit;
- saves review output under local state;
- does not replace human judgment or final PR review;
- should not require generated review artifacts to be committed.

## 2. Setup

Run setup once after cloning, and again if hook files are refreshed:

```bash
bash scripts/setup-hooks.sh
```

This sets:

```bash
git config --local core.hooksPath .githooks
```

Required commands:

- `bash`
- `git`
- `jq`
- `shasum` on macOS or compatible checksum support

Reviewer CLIs:

- `claude` for Claude review
- `codex` for Codex review
- `grok` for Grok review
- `agy` for Gemini review

The setup script warns if reviewer CLIs are missing, but does not fail.

If the relevant reviewer CLI is missing or rate-limited, commits can still be
created, but review output may fail or be incomplete. In that case, inspect
`state/ai-reviews/last-error.log` before deciding whether to retry later.

## 3. Configuration

Edit `.githooks/config`.

Important settings:

- `LOCAL_AI_REVIEW_AUTHOR_PREFIX_*`: migration-only reviewer mappings for
  agent-prefixed branches created before Issue worktrees;
- `LOCAL_AI_REVIEW_BASE_REF`: base ref used to compute the branch-wide diff,
  usually `origin/main`;
- `LOCAL_AI_REVIEW_TARGET_PATHS`: pathspecs reviewed as the `code` unit with
  the reviewer-specific prompt;
- `LOCAL_AI_REVIEW_DOC_UNITS`: documents reviewed as their own unit with a
  dedicated review skill (`"<unit>|<pathspec>|<prompt path>"` entries);
- `LOCAL_AI_REVIEW_STATE_DIR`: local output and bookkeeping directory;
- `LOCAL_AI_REVIEW_LOCK_TIMEOUT_SEC`: stale lock timeout;
- `LOCAL_AI_REVIEW_REVIEWER_TIMEOUT_SEC`: reviewer CLI timeout;
- `LOCAL_AI_REVIEW_DIFF_WARN_BYTES`: diff size warning threshold.

Reviewer CLI invocations:

- `local_ai_review_run_claude`: Bash function that must `exec` the Claude
  reviewer command;
- `local_ai_review_run_codex`: Bash function that must `exec` the Codex
  reviewer command;
- `local_ai_review_run_grok`: Bash function that must `exec` the Grok
  reviewer command;
- `local_ai_review_run_gemini`: Bash function that must `exec` the Gemini
  (`agy`) reviewer command.

Prefer project-level changes in `.githooks/config` over editing hook library
scripts.

## 4. Branch Rules

For `issue-<number>-<slug>` branches, the hook reads the Issue lifecycle
metadata stored under the shared Git common directory. The current owner
selects Claude, Codex, Grok, or Gemini and the metadata supplies the handoff
epoch plus its used/limit review budget. Missing, corrupt, or branch-mismatched
metadata produces an explicit hook diagnostic instead of a silent skip.

Legacy `codex/*`, `claude/*`, `grok/*`, and `gemini/*` branches retain prefix
routing only during fixed-lane migration. Other branches are skipped. For the
`code` unit, prompt files remain reviewer-specific: `local-review-codex.md`
for Codex, `local-review-claude.md` for Claude, `local-review-grok.md`
for Grok, and `local-review-gemini.md` for Gemini. Documentation units use
their review skill's `SKILL.md` as the prompt, shared by all reviewers.

## 5. Review Target

The review is split into **units**, each covering its own pathspecs with its
own prompt:

| Unit | Pathspecs | Prompt |
| --- | --- | --- |
| `code` | `LOCAL_AI_REVIEW_TARGET_PATHS` (code paths) | `.githooks/prompts/local-review-<reviewer>.md` |
| `requirements` | `docs/requirements.md` | `skills/requirements-review/SKILL.md` |
| `architecture` | `docs/architecture.md` | `skills/architecture-review/SKILL.md` |
| `design` | `docs/design/` | `skills/design-doc-review/SKILL.md` |

Each unit reviews the branch-wide diff of its pathspecs:

```bash
git diff "$(git merge-base origin/main HEAD)" HEAD -- <unit-paths>
```

Units are configured in `.githooks/config`. Documentation outside the three
doc units (for example `docs/security.md` or `README.md`) is not reviewed.

A commit touching several units triggers one reviewer run per unit,
sequentially under the same lock: `code` first, then the doc units in config
order. Units whose diff is empty, or whose diff already matches
`last-reviewed.json`, are skipped individually — so a docs-only commit does
not re-run the code review and vice versa.

Branch-wide review keeps follow-up commits in context. If only files outside
every unit's pathspecs changed, the hook skips review.

## 6. Skip Conditions

The hook skips when:

- `LOCAL_AI_REVIEW_RUNNING=1`
- branch is neither a valid Issue lifecycle branch nor a legacy configured prefix
- the current handoff epoch has consumed its two-review budget
- the commit is a merge commit
- rebase or cherry-pick is in progress
- commit message contains `[skip-review]`
- every unit's pathspec diff is empty
- merge-base cannot be resolved
- (per unit) the same branch / merge-base / handoff epoch / diff hash has
  already been reviewed for that unit

`LOCAL_AI_REVIEW_RUNNING=1` is normally reserved for hook recursion prevention.
Do not use it manually to suppress review for ordinary commits; use
`[skip-review]` when the skip should be visible in Git history.

The repository's single-Issue implementation workflow is capped at **two**
local AI review runs per handoff epoch (never open-ended within an epoch): after the
first review, commit a fix pass for its actionable findings *without*
`LOCAL_AI_REVIEW_RUNNING=1`, so the hook reviews that fix commit too (a
confirming second review). If that second review still has actionable
findings, commit one more fix pass *with* `LOCAL_AI_REVIEW_RUNNING=1` so the
hook does not start a third review — the cap holds regardless of what the
second review finds. If the first review already comes back with nothing
actionable, no second review is needed. Record the review status, findings,
and fixes in the PR body instead of extending the loop further.

A successful handoff from a different session starts a new monotonically
increasing epoch with a `0/2` budget, including same-agent recovery after a
session limit. Review artifacts from earlier epochs remain audit history. A
same-session repeated handoff is idempotent and does not create another epoch
or restore budget. Artifact bodies and `last-reviewed.json` record the epoch;
the established artifact filename shape remains unchanged for wait-script
compatibility.

The post-commit hook reserves an Issue epoch budget slot atomically before
launching its background worker, so rapid commits cannot over-queue reviews.
The launcher must create a startup handshake after validating its repository
and orchestrator; if startup is not confirmed, the hook refunds that epoch's
reservation atomically.

### Temporarily disabling the hook (e.g. during acceptance testing)

For a session where the hook should not fire **at all** (such as the Product
Owner's manual acceptance testing, where many small commits would otherwise
queue reviews), disable it locally instead of editing the tracked
`.githooks/post-commit`:

```bash
# Disable: drop the local-only hooksPath. Git falls back to .git/hooks/, which
# has no post-commit, so no review is queued. This is local config only — it is
# not committed and does not affect other clones.
git config --unset core.hooksPath

# Re-enable when done (idempotent; either works):
git config core.hooksPath .githooks
# or:
bash scripts/setup-hooks.sh
```

Prefer this over commenting out or deleting `.githooks/post-commit`, which is
tracked in git and shared across machines. Per-commit skips should still use
`[skip-review]` so the skip is visible in history; the `core.hooksPath` toggle is
for a whole working session.

## 7. Review Follow-Up Policy

If a review result is `NIT_ONLY`, a follow-up commit or amend that only
addresses those nits may include `[skip-review]` in the commit message. This
prevents repeated review cycles for low-risk wording, formatting, or
consistency fixes.

Do not use `[skip-review]` for fixes to `NEEDS_CHANGES`, `major`, or higher-risk
findings unless there is a separate reason to skip review. Those changes should
normally be reviewed again.

If a commit mixes nit fixes with unrelated content changes, do not use
`[skip-review]`.

## 8. Cleanup Policy

A good cleanup point is after the review result reaches `NIT_ONLY` and the
follow-up commit or amend that addresses those nits has been committed with
`[skip-review]`. At that point, the review cycle is considered settled and old
review artifacts can be removed to keep local state small.

Files that can be deleted:

- `state/ai-reviews/*.md`
- `state/ai-reviews/last-run.log`
- `state/ai-reviews/last-error.log`
- `state/ai-reviews/.review-*`
- `state/ai-reviews/.payload.*`
- `state/ai-reviews/.diff.*`

Files to keep by default:

- `state/ai-reviews/last-reviewed.json`

Keep `last-reviewed.json` because it may be used for duplicate-review
prevention. Delete it only when intentionally resetting review state and
accepting that the same diff may be reviewed again.

## 9. Output

Review output is written under:

```text
state/ai-reviews/
```

This directory should stay out of Git.

Useful files:

- `<timestamp>-claude-<unit>-<pid>.md`
- `<timestamp>-codex-<unit>-<pid>.md`
- `<timestamp>-grok-<unit>-<pid>.md`
- `<timestamp>-gemini-<unit>-<pid>.md`
- `last-run.log`
- `last-error.log`
- `last-reviewed.json` (per-unit diff hashes under `units`)

Review artifacts are local state and should not be committed.

## 10. Waiting for Completion

The hook runs asynchronously in the background (`launchctl`/`nohup`), so
`git commit` returns immediately — before the reviewer CLI has produced a
result. Waiting for that result by repeatedly re-checking `state/ai-reviews/`
turn-by-turn (e.g. an agent re-polling every minute or two) is expensive: each
check re-enters a full conversation turn, and a naive `ps aux | grep` check
can re-dump the entire reviewer prompt (including the branch diff) into that
turn's output every single time.

Two things make this cheap to wait for correctly instead:

- **Whether anything was queued at all is known immediately, for free.** The
  commit's own stdout prints
  `[local-ai-review] queued <reviewer> review for <branch> (commit=<short-sha>)`
  synchronously when `git commit` returns (`.githooks/post-commit`). If that
  line is absent, no review was queued (disabled, branch prefix mismatch,
  merge commit, `[skip-review]`, or empty diff) and there is nothing to wait
  for.
- **Completion is a pure file-existence condition**: every requested review
  unit (§5) has a `state/ai-reviews/<timestamp>-<reviewer>-<unit>-<pid>.md`
  file whose `` - commit: `<sha>` `` line matches the target commit, **and**
  `state/ai-reviews/.lock` is gone (a single commit can trigger several units
  sequentially under one lock, so the lock clears only once all of them are
  done).

`scripts/wait-for-local-ai-review.sh` encodes both of the above:

```bash
scripts/wait-for-local-ai-review.sh --unit <name>[,<name>...] \
  [--commit <sha>] [--timeout <seconds>] [--poll <seconds>]
```

- `--unit` (required): one or more of `code`, `requirements`, `architecture`,
  `design` — whichever units the commit's diff actually touches.
- `--commit` defaults to `git rev-parse HEAD` and must be a full 40-character
  SHA if passed explicitly — an abbreviated SHA never matches the output
  template's `` - commit: `<sha>` `` line and is rejected as a usage error
  rather than silently running out the full timeout.
- `--timeout` defaults to 540 seconds for one unit; pass a larger value
  explicitly for a commit that triggers several units, since they run
  sequentially under one lock.
- `--poll` defaults to 10 seconds.

Exit codes: `0` once every requested unit's commit-confirmed output exists and
the lock is gone, `1` on timeout, `2` on a usage error.

This section documents the mechanism only; *which tool* invokes the script is
harness-specific and belongs in that harness's own operating instructions (for
Claude Code: `CLAUDE.md`'s "Fable 5 Session Conventions → Tooling"; the
`issue-implementation` skill's workflow step also points here).

## 11. Troubleshooting

| Symptom | Check |
| --- | --- |
| No review runs | Issue lifecycle metadata (or legacy prefix), epoch budget, `core.hooksPath`, and target path diff |
| Reviewer exits immediately | CLI login status and PATH |
| Repeated reviews | `last-reviewed.json` and diff hash changes |
| Hook blocks unexpectedly | `last-run.log`, lock file age, reviewer timeout |
| Shellcheck fails | Bash 3.2 compatibility and quoted path handling |
| `wait-for-local-ai-review.sh` times out | `last-run.log`/`last-error.log`, whether the commit's stdout actually printed `queued`, and whether `--timeout` covers all requested units |

For branch-mapping changes, run:

```bash
bash scripts/smoke-local-ai-review-branch-mapping.sh
```

This checks the shared reviewer-selection helper without launching reviewer
CLIs.

For Issue epoch accounting changes, run:

```bash
bash scripts/smoke-local-ai-review-issue-epoch.sh
```

This uses a throwaway repository and stub reviewer to verify epoch-bearing
artifacts, budget consumption, and idempotent same-diff re-entry.

For review-unit dispatch changes (which document triggers which review
skill), run:

```bash
bash scripts/smoke-local-ai-review-doc-units.sh
```

This runs the orchestrator in a throwaway repository with a stubbed reviewer
and asserts unit selection, prompt selection, per-unit idempotency, and the
multi-unit-per-commit behavior.

For changes to the completion-waiting script (§10), run:

```bash
bash scripts/smoke-wait-for-local-ai-review.sh
```

This checks the commit-SHA matching guard, the lock-wait, and the timeout
path against fixture `state/ai-reviews/` artifacts, without invoking a real
reviewer CLI.

## 12. Optional GitHub Actions Fallback

GitHub Actions based AI review is intentionally outside the default template.
If a project adds it, keep these details in a separate optional document:

- required API keys
- PAT or GitHub App requirements
- recursion prevention
- branch guards
- when to use local review vs Actions fallback
