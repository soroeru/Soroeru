# Local AI Review

This template includes a Git `post-commit` hook that asks the other AI coding
tool to review the branch diff.

## Purpose

- Run review near the point where work is committed.
- Avoid depending on GitHub Actions for fast local feedback.
- Keep the mechanism language-agnostic.
- Save review output locally without blocking commits.

## Setup

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

## Configuration

Edit `.githooks/config`.

Important settings:

- branch prefixes
- base ref, usually `origin/main`
- target paths
- state directory
- lock timeout
- reviewer timeout
- reviewer CLI invocation functions

## Branch Rules

Default reviewer mapping:

- `codex/*` branches trigger Claude review
- `claude/*` branches trigger Codex review
- other branches are skipped

## Review Target

The reviewer sees a branch-wide diff:

```bash
git diff "$(git merge-base origin/main HEAD)" HEAD -- <target-paths>
```

Target paths are configured in `.githooks/config`.

## Skip Conditions

The hook skips when:

- `LOCAL_AI_REVIEW_RUNNING=1`
- branch prefix does not match the configured AI prefixes
- the commit is a merge commit
- rebase or cherry-pick is in progress
- commit message contains `[skip-review]`
- target path diff is empty
- merge-base cannot be resolved
- the same branch / merge-base / diff hash has already been reviewed

## Output

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

## Troubleshooting

| Symptom | Check |
| --- | --- |
| No review runs | Branch prefix, `core.hooksPath`, and target path diff |
| Reviewer exits immediately | CLI login status and PATH |
| Repeated reviews | `last-reviewed.json` and diff hash changes |
| Hook blocks unexpectedly | `last-run.log`, lock file age, reviewer timeout |
| Shellcheck fails | Bash 3.2 compatibility and quoted path handling |

## Optional GitHub Actions Fallback

GitHub Actions based cross-AI review is intentionally outside the default
template. If a project adds it, keep these details in a separate optional
document:

- required API keys
- PAT or GitHub App requirements
- recursion prevention
- branch guards
- when to use local review vs Actions fallback

