# CLAUDE.md

This file provides working instructions for Claude Code in this repository.

It mirrors the shared sections from `AGENTS.md` and replaces the Codex-specific
section with Claude Code-specific guidance. When the shared sections in
`AGENTS.md` change, update this file to match.

---

# Shared Agent Instructions

## Project Overview

`formfill-assistant` is a local-first Chrome extension for user-confirmed, human-in-the-loop form filling.

The extension detects form fields on the current web page, suggests values from locally managed profile data, and fills selected fields only after explicit user action.

The project starts as a personal tool for reducing repetitive form entry on websites and contract-related forms. It may later grow toward business and contract-form assistance, but the initial priority is to complete a small, usable Chrome extension.

## Product Principles

- Start with a small, working Chrome extension.
- Prefer user-confirmed assistance over autonomous automation.
- Design the product around human-in-the-loop interaction.
- Let the user handle any step that requires judgment, consent, identity verification, CAPTCHA, MFA, or manual confirmation.
- After the user completes a manual step, resume assistance by re-detecting the current form state.
- Do not auto-submit forms.
- Do not bypass CAPTCHA, bot detection, rate limits, MFA, paywalls, or access controls.
- Do not store passwords in the initial version.
- Do not store credit card information in the initial version.
- Keep user data local in the initial version.
- Avoid backend services until they are clearly necessary.
- Prefer deterministic, inspectable form-matching logic before introducing AI.
- Treat personal information and contract-related information as sensitive by default.

## Human-in-the-Loop Model

The product should assist the user without pretending to be the user or replacing required human actions.

When a web page requires a human step, such as CAPTCHA, MFA, terms confirmation, identity verification, file upload confirmation, or final submission, the extension should:

1. stop automated filling activity for that step;
2. clearly tell the user what action is needed;
3. wait for the user to complete the action;
4. re-scan the page after the user continues;
5. resume suggestions only for remaining fillable fields.

The extension must not attempt to solve, bypass, outsource, or obscure CAPTCHA and similar anti-abuse mechanisms.

Human-in-the-loop behavior is not a fallback; it is a core product design principle.

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
- Detect when the page likely requires a manual human step and prompt the user to complete it.
- Re-scan the form after user-driven page changes, CAPTCHA completion, MFA completion, or dynamic form updates.

## Explicitly Out of Scope for v0.1

Do not implement these features unless the user explicitly changes the scope:

- automatic form submission
- automatic account registration
- automatic address changes across multiple websites
- automatic contract modification
- CAPTCHA solving or CAPTCHA bypass
- MFA bypass
- bot detection bypass
- automatic acceptance of terms or contracts
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

Canonical Chrome extension architecture and component responsibilities live in [`docs/extension.md`](docs/extension.md). Repository file layout lives in [`docs/development.md`](docs/development.md).

In short, v0.1 is a Manifest V3 extension with four boundaries: content script, background service worker, options page, and a storage abstraction. Keep new code aligned with the boundaries defined in [`docs/extension.md`](docs/extension.md).

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

## Manual-Step Detection Strategy

For v0.1, manual-step detection should be conservative and UI-oriented.

The extension may recognize common signs that user action is needed, such as:

- CAPTCHA containers or visible CAPTCHA text
- MFA / one-time password fields
- confirmation checkboxes for terms or consent
- disabled fields or submit buttons waiting for user action
- page transitions after user action
- dynamically rendered follow-up forms

When such states are detected, the extension should guide the user instead of attempting to complete the step.

Avoid brittle or adversarial logic. This feature is for improving UX, not circumventing site protections.

## Dynamic Schema Direction

The long-term product direction includes dynamic schema management.

Different websites and business forms require different fields. The extension should eventually allow users to create custom field definitions when unknown fields are encountered.

Do not over-engineer this in v0.1. Prefer a simple data model that can evolve later.

## Security and Privacy Requirements

Canonical security and privacy decisions, threat model, sensitive data handling, and permission review rules live in [`docs/security.md`](docs/security.md). Non-functional security and privacy requirements live in [`docs/requirements.md`](docs/requirements.md) §7.

Non-negotiable rules for agent sessions:

- Store profile data locally only; do not send it to external services and do not add telemetry.
- Do not store passwords or credit card data.
- Do not auto-submit forms or auto-accept terms, policies, contracts, or consent checkboxes.
- Do not bypass CAPTCHA, MFA, bot detection, or access controls.
- Fill only fields the user has selected.
- Keep extension permissions as narrow as possible and document any permission added or changed in `manifest.json`.

## User-Facing Documentation Policy

`README.md` should be written primarily for users, not implementation agents.

Keep detailed development guidance, architecture notes, tech stack decisions, testing strategy, and implementation constraints in `AGENTS.md`, this file, and `docs/` files.

If a technical detail is useful only for development, prefer documenting it outside `README.md`.

## Repository Documents

Use these documents when present:

- `README.md`: user-facing product overview, usage, limitations, and security notes
- `docs/README.md`: documentation index and ownership guide
- `docs/requirements.md`: product requirements
- `docs/extension.md`: Chrome extension architecture and design notes
- `docs/development.md`: setup, commands, and workflow
- `docs/testing.md`: testing strategy
- `docs/security.md`: security review notes
- `docs/manual-test.md`: manual test checklist
- `docs/github-operations.md`: GitHub workflow rules
- `docs/local-ai-review.md`: local cross-AI review hook documentation
- `.github/ISSUE_TEMPLATE/implementation-plan.md`: GitHub Issue implementation plan template

Update docs when behavior, setup, commands, architecture, or security assumptions change.

## Development Workflow

Branch naming, Issue workflow, commit conventions, PR descriptions, review expectations, and merge policy live in [`docs/github-operations.md`](docs/github-operations.md). The implementation plan template is `.github/ISSUE_TEMPLATE/implementation-plan.md`.

Quick reminders for agent sessions:

- Keep changes small and reviewable, and prefer issue-driven work when a GitHub Issue exists.
- Use short-lived branches named `<agent>/issue-<number>-<short-slug>`.
- Do not commit secrets, local state, generated caches, or AI review artifacts.
- Do not commit real personal information in fixtures, screenshots, tests, or docs.

## Local AI Review

This repository may use a local Git `post-commit` hook for cross-AI review.

Setup, branch rules, skip conditions, follow-up policy, cleanup policy, and troubleshooting live in [`docs/local-ai-review.md`](docs/local-ai-review.md).

Key points for agent sessions:

- The hook is opt-in. Do not assume it has run unless you have verified it in the current environment.
- Use `[skip-review]` in a commit message only when [`docs/local-ai-review.md`](docs/local-ai-review.md) allows it.
- Treat hook output under `state/ai-reviews/` as local state. Do not commit it.

## Quality Gates

The canonical quality gate definitions live in [`docs/development.md`](docs/development.md).

Rules:

- Run the gates documented there before committing code changes.
- Documentation-only changes may skip code-level gates when no generated output is affected.
- Do not invent passing results for commands that do not exist yet. State what is missing in PR notes.

## Implementation Guidance

- Prefer simple, deterministic logic for v0.1.
- Keep DOM parsing logic isolated and testable.
- Keep manual-step detection separate from field classification.
- Keep storage access behind a small abstraction.
- Keep profile field definitions typed.
- Avoid coupling page content scripts directly to storage internals.
- Avoid broad global CSS that may break host pages.
- Be careful when injecting UI into arbitrary websites.
- Prefer explicit user actions for filling fields.
- Never implement hidden or automatic submission behavior.
- Never implement CAPTCHA solving, CAPTCHA bypass, or MFA bypass.
- After user-driven page changes, support re-scanning rather than forcing a full reload when feasible.

## Manual Testing Expectations

Test strategy and test-type matrix live in [`docs/testing.md`](docs/testing.md).
The browser-based manual checklist lives in [`docs/manual-test.md`](docs/manual-test.md).

When a change affects extension loading, content script DOM interaction, injected UI, selected filling, manual-step prompts, permissions, or observable storage behavior, run the relevant items from [`docs/manual-test.md`](docs/manual-test.md) against fixtures.

Use fake profile data during tests.

---

# Claude Code-Specific Instructions

## Role of Claude Code in This Repository

Claude Code should act as an implementation-focused coding agent that respects
this project's human-in-the-loop and local-first principles.

Primary responsibilities:

- read `README.md` and `AGENTS.md` before non-trivial edits
- make small, coherent code changes aligned with the shared instructions above
- update documentation when behavior, commands, architecture, or security
  assumptions change
- run available quality gates when feasible and report results honestly
- clearly state what was changed, what was verified, and what was not

## Claude Code Operating Rules

- Do not assume Codex-specific automation runs in Claude Code sessions.
- Run format, lint, test, and typecheck commands explicitly when they exist;
  do not rely on hooks unless their presence has been verified in this session.
- Confirm before destructive or hard-to-reverse actions (force pushes, branch
  deletion, large file rewrites, dependency removal, CI changes).
- Prefer the dedicated `Read`, `Edit`, and `Write` tools over `cat`, `sed`, or
  `echo`-based file operations.
- Use parallel tool calls only for independent operations.
- Do not add new dependencies, frameworks, or build tools without a clear,
  documented reason.
- Do not introduce backend services, cloud sync, AI-based field classification,
  or browser automation services unless the user explicitly requests them.
- Do not broaden Chrome extension permissions without documenting the need in
  `manifest.json` context and relevant docs.
- Do not use real user data when creating examples, tests, or fixtures.
- Keep Claude Code-specific hook behavior documented if it is enabled in
  `.claude/settings.local.json` or similar configuration.

## Claude Code Response Expectations

When finishing a task, keep the summary concise and factual. Include:

- files changed
- important implementation choices
- quality gates run (and their outcomes)
- checks not run and why
- any follow-up work that remains

Avoid trailing recaps when a diff is sufficient. Prefer one or two sentences
covering what changed and what is next.

## Claude Code Safety Notes

Claude Code must not implement features that silently perform high-impact
actions, including:

- submitting forms
- accepting terms, policies, or contracts
- creating accounts
- changing account settings
- purchasing products or services
- modifying contracts
- uploading personal data to external services
- solving or bypassing CAPTCHA
- bypassing MFA, bot detection, or access controls

If a requested change appears to move toward those behaviors, pause and
clarify the safety boundary with the user before implementing.

Claude Code may implement human-in-the-loop UX that pauses automated filling,
prompts the user with clear guidance, and resumes assistance after the user
completes a required manual step.
