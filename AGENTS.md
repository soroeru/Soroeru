# AGENTS.md

This file provides working instructions for AI coding agents in this repository.

It is intentionally split into two parts:

1. **Shared Agent Instructions**: rules and project context that should apply to both Codex and Claude Code.
2. **Codex-Specific Instructions**: rules that are specific to Codex sessions.

When creating or updating `CLAUDE.md`, reuse the shared sections and replace the Codex-specific section with Claude Code-specific guidance.

---

# Shared Agent Instructions

## Project Overview

`formfill-assistant` is a local-first Chrome extension for user-confirmed form filling.

The extension detects form fields on the current web page, suggests values from locally managed profile data, and fills selected fields only after explicit user action.

The project starts as a personal tool for reducing repetitive form entry on websites and contract-related forms. It may later grow toward business and contract-form assistance, but the initial priority is to complete a small, usable Chrome extension.

## Product Principles

- Start with a small, working Chrome extension.
- Prefer user-confirmed assistance over autonomous automation.
- Do not auto-submit forms.
- Do not bypass CAPTCHA, bot detection, rate limits, or access controls.
- Do not store passwords in the initial version.
- Do not store credit card information in the initial version.
- Keep user data local in the initial version.
- Avoid backend services until they are clearly necessary.
- Prefer deterministic, inspectable form-matching logic before introducing AI.
- Treat personal information and contract-related information as sensitive by default.

## Initial Scope: v0.1

v0.1 is a local-first Chrome extension for personal use.

Planned features:

- Manage basic profile fields locally.
  - full name
  - email address
  - phone number
  - postal code
  - address
  - company name
  - department name
  - other manually defined fields
- Detect form fields on the current web page.
- Analyze `input`, `textarea`, and `select` elements.
- Infer field meaning from attributes and surrounding text.
  - `autocomplete`
  - `name`
  - `id`
  - `placeholder`
  - associated `label`
  - nearby text
- Show fill suggestions to the user.
- Fill fields only after explicit user action.
- Record which URL used which profile fields.
- Provide an extension options page for managing profile data and settings.

## Explicitly Out of Scope for v0.1

Do not implement these features unless the user explicitly changes the scope:

- automatic form submission
- automatic account registration
- automatic address changes across multiple websites
- automatic contract modification
- password manager functionality
- credit card storage
- cloud sync
- Google Drive / Dropbox integration
- backend API server
- mobile apps
- iOS app autofill
- Android Autofill Service
- BYOC deployment
- Terraform automation
- Cloudflare Browser Run integration
- autonomous browser AI agents

## Candidate Tech Stack

Prefer this stack unless the repository has already standardized on something else:

- TypeScript
- Chrome Extension Manifest V3
- HTML / CSS
- React or Vanilla TypeScript for extension UI
- `chrome.storage.local` or IndexedDB for local storage
- Web Crypto API for future local encryption
- Playwright for future end-to-end testing

If introducing a framework, build tool, package manager, or test runner, document the reason and update the relevant docs.

## Expected Architecture

```text
Chrome Extension
├── content script
│   ├── detect form elements
│   ├── infer field types
│   ├── render suggestion UI
│   └── fill selected values into the page
│
├── background service worker
│   ├── extension event handling
│   └── message passing
│
├── options page
│   ├── manage profile fields
│   ├── manage custom field definitions
│   └── view site-field history
│
└── local storage
    ├── profile data
    ├── field definitions
    └── site-field history
```

## Field Detection Strategy

Start with rule-based field detection. Do not introduce LLM-based classification for v0.1.

Examples:

- `autocomplete="email"` -> email address
- `autocomplete="tel"` -> phone number
- `name` or `id` contains `email` -> email address
- `name` or `id` contains `tel` / `phone` -> phone number
- `placeholder` contains `住所` -> address
- `label` contains `会社名` -> company name
- `label` contains `部署` -> department name
- `name` or `id` contains `zip` / `postal` -> postal code

The goal is not perfect automatic classification. The goal is useful suggestions while keeping the user in control.

## Dynamic Schema Direction

The long-term product direction includes dynamic schema management.

Different websites and business forms require different fields. The extension should eventually allow users to create custom field definitions when unknown fields are encountered.

Do not over-engineer this in v0.1. Prefer a simple data model that can evolve later.

## Security and Privacy Requirements

This project handles sensitive information. All agents must treat security and privacy as first-class constraints.

For v0.1:

- Store data locally only.
- Do not send profile data to external servers.
- Do not add telemetry unless explicitly requested.
- Do not store passwords.
- Do not store credit card information.
- Do not automatically click submit buttons.
- Fill only fields selected by the user.
- Keep extension permissions as narrow as possible.
- Avoid broad host permissions unless they are necessary and documented.

When adding or changing permissions in `manifest.json`, explain why they are needed.

## Repository Documents

Use these documents when present:

- `README.md`: product overview and roadmap
- `docs/requirements.md`: product requirements
- `docs/development.md`: setup, commands, and workflow
- `docs/testing.md`: testing strategy
- `docs/security.md`: security review notes
- `docs/manual-test.md`: manual test checklist
- `docs/lessons-learned.md`: project learning log
- `docs/github-operations.md`: GitHub workflow rules
- `docs/issue-implementation-plan-template.md`: issue planning template
- `docs/local-ai-review.md`: local cross-AI review hook documentation

Update docs when behavior, setup, commands, architecture, or security assumptions change.

## Development Workflow

- Keep changes small and reviewable.
- Prefer issue-driven work when a GitHub Issue exists.
- Keep the implementation plan in the GitHub Issue for issue-driven work.
- Use short-lived branches named `<agent>/issue-<number>-<short-slug>` when working from an issue.
- Run relevant quality gates before committing.
- Do not commit secrets, local state, generated caches, or AI review artifacts.
- Do not commit real personal information in fixtures, screenshots, tests, or docs.
- Use fake data for examples and tests.

## Local AI Review

This repository may use a local Git `post-commit` hook for cross-AI review.

Run once after cloning if the workflow is enabled:

```bash
bash scripts/setup-hooks.sh
```

Default behavior:

- commits on `codex/*` branches trigger Claude review
- commits on `claude/*` branches trigger Codex review
- review results are written to `state/ai-reviews/`
- `[skip-review]` in a commit message skips review

Configuration lives in `.githooks/config`.

Do not assume this hook has run unless you have explicitly verified it in the current environment.

## Quality Gates

The exact commands may change as the project is implemented. Prefer documented commands in `docs/development.md` and `package.json` when they exist.

Expected future checks:

```bash
# install dependencies
npm install

# run tests
npm test

# run typecheck
npm run typecheck

# run linter
npm run lint

# build extension
npm run build
```

If these commands do not exist yet, do not invent passing results. State what is missing and update docs when adding commands.

## Implementation Guidance

- Prefer simple, deterministic logic for v0.1.
- Keep DOM parsing logic isolated and testable.
- Keep storage access behind a small abstraction.
- Keep profile field definitions typed.
- Avoid coupling page content scripts directly to storage internals.
- Avoid broad global CSS that may break host pages.
- Be careful when injecting UI into arbitrary websites.
- Prefer explicit user actions for filling fields.
- Never implement hidden or automatic submission behavior.

## Manual Testing Expectations

When relevant, test against simple fixture pages before testing on real sites.

Useful manual cases:

- Japanese contact form
- English contact form
- form with `autocomplete` attributes
- form without labels
- form with labels wrapping inputs
- form with labels linked by `for` attributes
- dynamically rendered form
- textarea field
- select field

Use fake profile data during tests.

---

# Codex-Specific Instructions

## Role of Codex in This Repository

Codex should act as an implementation-focused coding agent.

Primary responsibilities:

- read the repository instructions before editing
- make small, coherent code changes
- keep implementation aligned with `README.md` and this file
- update documentation when behavior or commands change
- run available checks when feasible
- clearly report what was changed and what was not verified

## Codex Operating Rules

- Do not assume Claude Code hooks run inside Codex sessions.
- Run format, lint, test, and typecheck commands explicitly when needed and available.
- Respect sandbox and approval requirements for network, GUI, or destructive operations.
- Prefer repository-local patterns and documented commands over ad hoc tooling.
- Do not add new dependencies without a clear reason.
- Do not introduce backend services, AI agents, cloud sync, or browser automation services unless explicitly requested.
- Do not broaden Chrome extension permissions without documenting the need.
- Do not use real user data when creating examples, tests, or fixtures.

## Codex Response Expectations

When finishing a task, report:

- files changed
- important implementation choices
- tests or checks run
- checks not run and why
- any follow-up work that remains

Keep final summaries concise and factual.

## Codex Safety Notes

Codex must not implement features that silently perform high-impact actions, including:

- submitting forms
- accepting terms
- creating accounts
- changing account settings
- purchasing products or services
- modifying contracts
- uploading personal data to external services

If a requested change appears to move toward those behaviors, pause and clarify the safety boundary before implementing.
