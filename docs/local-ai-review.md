# Local AI Review

This document owns the local Git hook used for cross-AI review.

GitHub PR workflow expectations belong in
[`github-operations.md`](github-operations.md). General development setup
belongs in [`development.md`](development.md).

## 1. Purpose

This section should describe why the hook exists and what kind of feedback it is
expected to provide.

- Run review near the point where work is committed.
- Avoid depending on GitHub Actions for fast local feedback.
- Keep the mechanism language-agnostic.
- Save review output locally without blocking commits.

## 2. Setup

This section should describe setup commands and local configuration
requirements.

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

## 3. Configuration

This section should describe `.githooks/config` settings and how they affect
review behavior.

Edit `.githooks/config`.

Important settings:

- branch prefixes
- base ref, usually `origin/main`
- target paths
- state directory
- lock timeout
- reviewer timeout
- reviewer CLI invocation functions

## 4. Branch Rules

This section should describe the branch prefix rules that choose the reviewer.

Default reviewer mapping:

- `codex/*` branches trigger Claude review
- `claude/*` branches trigger Codex review
- other branches are skipped

## 5. Review Target

This section should describe how the branch diff is selected for review.

The reviewer sees a branch-wide diff:

```bash
git diff "$(git merge-base origin/main HEAD)" HEAD -- <target-paths>
```

Target paths are configured in `.githooks/config`.

## 6. Skip Conditions

This section should describe when the hook intentionally skips a review.

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

## 7. Review Follow-Up Policy

This section should describe how to avoid unnecessary review loops while still
rerunning review for substantive changes.

If a review result is `NIT_ONLY`, a follow-up commit or amend that only
addresses those nits may include `[skip-review]` in the commit message. This
prevents repeated review cycles for low-risk wording, formatting, or
consistency fixes.

Do not use `[skip-review]` for fixes to `NEEDS_CHANGES`, `major`, or higher-risk
findings unless there is a separate reason to skip review. Those changes should
normally be reviewed again.

## 8. Cleanup Policy

This section should describe when local review output can be deleted and which
state should be preserved.

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

This section should describe where review output is stored and which files are
useful for inspection.

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

## 10. Troubleshooting

This section should describe common symptoms and likely checks.

| Symptom | Check |
| --- | --- |
| No review runs | Branch prefix, `core.hooksPath`, and target path diff |
| Reviewer exits immediately | CLI login status and PATH |
| Repeated reviews | `last-reviewed.json` and diff hash changes |
| Hook blocks unexpectedly | `last-run.log`, lock file age, reviewer timeout |
| Shellcheck fails | Bash 3.2 compatibility and quoted path handling |

## 11. Optional GitHub Actions Fallback

This section should describe where future GitHub Actions fallback details should
live if the project adds them.

GitHub Actions based cross-AI review is intentionally outside the default
template. If a project adds it, keep these details in a separate optional
document:

- required API keys
- PAT or GitHub App requirements
- recursion prevention
- branch guards
- when to use local review vs Actions fallback
