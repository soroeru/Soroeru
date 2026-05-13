# AGENTS.md

This file provides guidance to Codex when working with code in this
repository.

## Project Overview

<!-- Describe the problem this project solves, target users, and key constraints. -->

## Tech Stack

- **Language**:
- **Package manager**:
- **Main framework**:
- **Runtime environment**:

## Core Features

1.
2.
3.

## Commands

```bash
# Install dependencies

# Run development server

# Run tests

# Run formatter / linter

# Run typecheck
```

## Authentication And External Services

<!-- Document required accounts, API keys, local credentials, and safe setup steps. -->

## Local AI Review

Run once after cloning:

```bash
bash scripts/setup-hooks.sh
```

The Git `post-commit` hook reviews branch diffs with the other AI tool:

- `codex/*` branches trigger Claude review
- `claude/*` branches trigger Codex review
- review results are written to `state/ai-reviews/`
- `[skip-review]` in a commit message skips review

Configuration lives in `.githooks/config`.

## Directory Structure

```text
.
├── src/
├── tests/
├── docs/
├── scripts/
└── .githooks/
```

## Related Documents

- `docs/github-operations.md`
- `docs/issue-implementation-plan-template.md`
- `docs/local-ai-review.md`
- `docs/requirements.md`
- `docs/development.md`
- `docs/testing.md`
- `docs/security.md`
- `docs/manual-test.md`
- `docs/lessons-learned.md`

## Development Rules

1. Keep the implementation plan in the GitHub Issue when work is issue-driven.
2. Use short-lived branches named `<agent>/issue-<number>-<short-slug>`.
3. Run the relevant quality gates before committing.
4. Update documentation when behavior, setup, or operations change.
5. Do not commit secrets, local state, generated caches, or review artifacts.

## Codex Notes

- Do not assume Claude Code hooks run in Codex sessions.
- Run format / lint / test commands explicitly when needed.
- Respect sandbox and approval requirements for network, GUI, or destructive operations.
- Prefer repository-local patterns and documented commands over ad hoc tooling.

## Cautions

<!-- Document destructive operations, production risks, data handling, and recovery steps. -->

