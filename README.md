# AI Coding Template

Template repository for projects developed with Codex, Claude Code, and
local cross-AI review.

This template provides:

- `AGENTS.md` and `CLAUDE.md` as AI-tool entry documents
- reusable GitHub / Issue / PR operating rules under `docs/`
- a local Git `post-commit` hook that asks the other AI tool to review
  branch diffs
- `shellcheck` CI for hook scripts

After creating a repository from this template, fill in the project-specific
sections before asking an AI coding tool to implement features.

## First Edits

Update these files first:

1. `README.md`: project name, setup, and usage
2. `AGENTS.md`: Codex-facing project instructions
3. `CLAUDE.md`: Claude Code-facing project instructions
4. `docs/requirements.md`: product requirements
5. `docs/development.md`: development commands and workflow
6. `.githooks/config`: branch prefixes, base ref, and review target paths

## Local AI Review

Install the hook after cloning:

```bash
bash scripts/setup-hooks.sh
```

The hook sets:

```bash
git config --local core.hooksPath .githooks
```

Default behavior:

- commits on `codex/*` branches are reviewed by Claude CLI
- commits on `claude/*` branches are reviewed by Codex CLI
- other branches are skipped
- review output is saved under `state/ai-reviews/`
- commits are not blocked by reviewer failures

Required commands:

- `bash`
- `git`
- `jq` for `last-reviewed.json` bookkeeping

Recommended commands:

- `claude`
- `codex`
- `shellcheck`

Review target paths and reviewer commands are configured in `.githooks/config`.

## Verification

Run:

```bash
shellcheck .githooks/post-commit .githooks/lib/*.sh scripts/*.sh
bash scripts/setup-hooks.sh
```

Then create a small commit on a `codex/*` or `claude/*` branch and check
`state/ai-reviews/`.

## Documents

- `AGENTS.md`: Codex-facing instructions
- `CLAUDE.md`: Claude Code-facing instructions
- `docs/github-operations.md`: shared GitHub workflow
- `docs/issue-implementation-plan-template.md`: Issue planning template
- `docs/local-ai-review.md`: hook setup and operations
- `docs/requirements.md`: requirement template
- `docs/development.md`: development template
- `docs/testing.md`: testing template
- `docs/security.md`: security review template
- `docs/manual-test.md`: manual testing template
- `docs/lessons-learned.md`: learning log template

GitHub Actions based cross-AI review is intentionally not included as a
default workflow. If needed, document and add it as an optional fallback.

