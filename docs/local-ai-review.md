# Local AI Review

This document owns the **local Git hook for AI review**: purpose, setup,
configuration, branch rules, review target, skip conditions, follow-up policy,
cleanup policy, output, and troubleshooting.

Out of scope here: GitHub PR workflow expectations (see
[`github-operations.md`](github-operations.md)) and general development setup
(see [`development.md`](development.md)).

## 1. Purpose

The local AI review hook provides fast reviewer feedback near the point where
work is committed. It is intended to catch documentation, workflow, and code
review issues before or alongside PR review without depending on GitHub Actions.

The hook:

- runs after local commits on configured branch prefixes;
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

The setup script warns if reviewer CLIs are missing, but does not fail.

If the relevant reviewer CLI is missing or rate-limited, commits can still be
created, but review output may fail or be incomplete. In that case, inspect
`state/ai-reviews/last-error.log` before deciding whether to retry later.

## 3. Configuration

Edit `.githooks/config`.

Important settings:

- `LOCAL_AI_REVIEW_AUTHOR_PREFIX_CLAUDE`: branch prefix for Claude-authored
  work;
- `LOCAL_AI_REVIEW_AUTHOR_PREFIX_CODEX`: branch prefix for Codex-authored work;
- `LOCAL_AI_REVIEW_BASE_REF`: base ref used to compute the branch-wide diff,
  usually `origin/main`;
- `LOCAL_AI_REVIEW_TARGET_PATHS`: pathspecs included in the review diff;
- `LOCAL_AI_REVIEW_STATE_DIR`: local output and bookkeeping directory;
- `LOCAL_AI_REVIEW_LOCK_TIMEOUT_SEC`: stale lock timeout;
- `LOCAL_AI_REVIEW_REVIEWER_TIMEOUT_SEC`: reviewer CLI timeout;
- `LOCAL_AI_REVIEW_DIFF_WARN_BYTES`: diff size warning threshold.

Reviewer CLI invocations:

- `local_ai_review_run_claude`: Bash function that must `exec` the Claude
  reviewer command;
- `local_ai_review_run_codex`: Bash function that must `exec` the Codex
  reviewer command.

Prefer project-level changes in `.githooks/config` over editing hook library
scripts.

## 4. Branch Rules

Default reviewer mapping:

- `codex/*` branches trigger Codex review
- `claude/*` branches trigger Claude review
- other branches are skipped

This mapping keeps the branch agent prefix and reviewer CLI aligned. Prompt
files remain reviewer-specific: `local-review-codex.md` is used for Codex
review and `local-review-claude.md` is used for Claude review.

## 5. Review Target

The reviewer sees a branch-wide diff:

```bash
git diff "$(git merge-base origin/main HEAD)" HEAD -- <target-paths>
```

Target paths are configured in `.githooks/config`.

Branch-wide review keeps follow-up commits in context. If only files outside
the configured target paths changed, the hook skips review.

## 6. Skip Conditions

The hook skips when:

- `LOCAL_AI_REVIEW_RUNNING=1`
- branch prefix does not match the configured AI prefixes
- the commit is a merge commit
- rebase or cherry-pick is in progress
- commit message contains `[skip-review]`
- target path diff is empty
- merge-base cannot be resolved
- the same branch / merge-base / diff hash has already been reviewed

`LOCAL_AI_REVIEW_RUNNING=1` is reserved for hook recursion prevention. Do not
use it manually to suppress review for ordinary commits; use `[skip-review]`
when the skip should be visible in Git history.

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

- `<timestamp>-claude.md`
- `<timestamp>-codex.md`
- `last-run.log`
- `last-error.log`
- `last-reviewed.json`

Review artifacts are local state and should not be committed.

## 10. Troubleshooting

| Symptom | Check |
| --- | --- |
| No review runs | Branch prefix, `core.hooksPath`, and target path diff |
| Reviewer exits immediately | CLI login status and PATH |
| Repeated reviews | `last-reviewed.json` and diff hash changes |
| Hook blocks unexpectedly | `last-run.log`, lock file age, reviewer timeout |
| Shellcheck fails | Bash 3.2 compatibility and quoted path handling |

For branch-mapping changes, run:

```bash
bash scripts/smoke-local-ai-review-branch-mapping.sh
```

This checks the shared reviewer-selection helper without launching reviewer
CLIs.

## 11. Optional GitHub Actions Fallback

GitHub Actions based AI review is intentionally outside the default template.
If a project adds it, keep these details in a separate optional document:

- required API keys
- PAT or GitHub App requirements
- recursion prevention
- branch guards
- when to use local review vs Actions fallback
