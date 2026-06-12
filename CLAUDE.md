# CLAUDE.md

This file provides working instructions for Claude Code in this repository.

It mirrors the shared sections from `AGENTS.md` and replaces the Codex-specific
section with Claude Code-specific guidance. When the shared sections in
`AGENTS.md` change, update this file to match.

> **Direction change (2026-06-12).** The project has pivoted from a Chrome-extension,
> human-in-the-loop form *assistant* to **`autofill`**: a local-first, **autonomous
> AI agent** that stores the user's full personal data and registers / updates the
> user's accounts on their behalf. The canonical design is
> [`docs/rfc/rfc-001-chrome-autofill-pivot.md`](docs/rfc/rfc-001-chrome-autofill-pivot.md)
> (RFC-001 v3). This file reflects that direction. Sections that previously described
> an MV3 extension, human-in-the-loop filling, or "do not store passwords / cards"
> have been intentionally replaced; their history is in git.

---

# Shared Agent Instructions

## Project Overview

`autofill` is a **local-first, autonomous form-filling agent** for personal use.

The user stores their personal data locally (encrypted). When the user gives a URL,
the agent finds the registration page on that site, fills the form, and completes the
registration on the user's behalf after a single review-and-confirm step. The agent
also keeps a per-site inventory of what was submitted and can update the user's
information across many sites when their data changes.

The project starts as a personal tool. Browser automation is performed with
**Playwright** so the agent is not tied to one browser engine (Chromium / Firefox /
WebKit).

## Product Principles

- Build a small, working autonomous agent the user can run locally.
- Keep the user's personal data **local and encrypted**; the user owns and manages it.
- Give the AI agent maximum autonomy; minimize required human intervention.
- The agent may auto-fill and auto-submit registrations after the user approves a
  single review-and-confirm gate; it may accept terms and complete the final submit
  on the user's behalf within that approval.
- **Never bypass CAPTCHA, MFA, bot detection, rate limits, paywalls, or access
  controls.** These are the unavoidable hand-off points to the human (see below).
- Do not perform checkout / payment. Exception: a free-trial-that-becomes-a-paid-
  subscription is surfaced as a high-risk item, and the card is filled only on the
  user's explicit approval.
- Prefer deterministic, inspectable form-matching logic; also evaluate an AI-driven
  variant and compare accuracy.
- Limit network egress to the target sites the user acts on and the user's own AI
  provider; no telemetry, no cloud sync, no other external services; never upload the
  data store.
- Treat all stored personal data (including card data and per-site credentials) as
  sensitive by default.

## Autonomy and Human Hand-off Model

Human-in-the-loop is **no longer the core model**. The agent acts autonomously. Human
intervention is limited to two cases:

1. **Missing data**: when a form needs information not in the store, prompt the user
   for that value and save it as a new field for reuse.
2. **Walls that cannot be automated**: CAPTCHA, MFA / OTP, identity verification, and
   email/SMS verification links. The agent **detects but never bypasses** these. It
   hands off to the user in the **same headed Playwright session**, waits for the user
   to resolve the step, then resumes automation from where it paused.

Registration uses a **review-and-confirm gate**: after the agent analyzes the form
(but before submitting), it shows what will be submitted, the terms links, and any
detected high-risk clauses. On the user's single approval, the agent fills, accepts
ordinary terms, and submits.

## Three Guards (registration safety)

When delegating terms acceptance and final submit, the agent applies:

1. **High-risk clause escalation**: detect clauses such as auto-renewing subscriptions,
   mandatory arbitration, third-party data sharing/sale, or content licenses; surface
   them in the gate and stop auto-acceptance for the user to decide. This also lowers
   the cognitive load of long terms users would otherwise skip.
2. **Payment stop (with one exception)**: if a registration form contains card /
   payment fields, stop and hand off — except free-trial→subscription, which is shown
   as a high-risk item and, only on approval, the card is auto-filled.
3. **No auto-attestation**: do not auto-check eligibility/identity statements
   ("I am 18+", residency, "I am authorized"); present them for the user to decide.

**Sites whose terms prohibit automated account creation**: fill the data only, do not
auto-submit; explain the restriction and let the user press the final button.

## Initial Scope

Planned capabilities:

- Local, encrypted store of the user's personal data:
  - full name (incl. phonetic / romanized)
  - email address
  - phone number
  - postal code and address (home / work / shipping / billing)
  - company name, department name
  - **credit card number, expiry, holder, security code (CVV)**
  - **per-site login ID and password**
  - other dynamically added fields
- Given a URL: find the registration page, map fields, fill, run the review-and-
  confirm gate, and submit (subject to the three guards).
- Per-site inventory of what was submitted (references + hashes, not duplicated raw
  values) and an authorization record (mandate) of what the user approved.
- Bulk update: select sites, diff against the latest stored values, and update the
  changed fields on each site.
- Settings, including the user's own AI provider API key.
- Detect CAPTCHA / MFA / verification walls and hand off / resume seamlessly.

## Explicitly Out of Scope

Do not implement these unless the user explicitly changes the scope:

- checkout / purchase / payment (except the free-trial→subscription card case above)
- **bypassing** CAPTCHA, MFA, bot detection, rate limits, paywalls, or access controls
- multi-locale form detection in the PoC (PoC is Japanese-only; multi-locale is later)
- cloud sync, backend API servers, telemetry
- mobile apps, iOS app autofill, Android Autofill Service
- using any AI provider other than the user's configured one

## Tech Stack

Prefer this stack unless the repository has already standardized on something else:

- TypeScript
- **Playwright** for browser automation (agent runtime) **and** end-to-end tests —
  chosen for browser-engine independence (Chromium / Firefox / WebKit).
- Local encrypted storage (see Security below): Web Crypto API (AES-256-GCM) with a
  memory-hard KDF (Argon2id; PBKDF2-HMAC-SHA-512 as a Web-Crypto-only fallback).
- AI providers: **Anthropic** (Claude Opus / Sonnet / Haiku) and **OpenAI**
  (GPT-5.4 / GPT-5.4-mini / GPT-5.3-Codex), behind a provider-abstraction layer.
- HTML / CSS and TypeScript (Vanilla or a framework) for the local UI.

If introducing a framework, build tool, package manager, or test runner, document the
reason and update the relevant docs.

## Expected Architecture

Canonical architecture lives in [`docs/extension.md`](docs/extension.md) and the RFC.
In short, `autofill` is a **local Playwright-based application** with four layers:

- **store layer**: encrypted personal data, per-site records, mandates;
- **agent layer**: the user's AI (form discovery, field mapping, high-risk clause
  detection) — receives form structure, not raw values;
- **automation layer**: Playwright drives a (headed) browser to navigate, fill, submit,
  observe, and hand off / resume across Chromium / Firefox / WebKit;
- **UI layer**: personal-data management, per-site inventory, the review-and-confirm
  gate, and settings (API key).

## Field Detection Strategy

Two variants are built and compared (see RFC §8):

1. **Deterministic**: reuse the existing scanner (`scanFields`) and rule-based
   classifier to map fields (`autocomplete`, `name`, `id`, `placeholder`, `label`,
   nearby text). Examples: `autocomplete="email"` → email; `住所` label → address.
2. **AI-driven**: the model receives the form structure and returns a mapping plan;
   the automation layer fills the values locally.

The PoC measures success rate and mis-mapping rate of both, Japanese-only.

## Wall Detection Strategy (CAPTCHA / MFA / verification)

Detection is conservative and never adversarial — it exists to hand off to the human,
not to circumvent anything. Signals: known CAPTCHA widgets (reCAPTCHA / hCaptcha /
Turnstile DOM markers and visible text), OTP/MFA field traits
(`autocomplete="one-time-code"`, single-digit boxes, "認証コード" / "verification
code"), and verification-page wording. When in doubt, stop and ask the human. The
agent must never solve, bypass, outsource, or obscure these mechanisms.

## Dynamic Schema Direction

Different sites need different fields. When a form needs a field not in the store,
prompt the user and add it as a new field for reuse. Keep field definitions typed and
behind a small abstraction; do not over-engineer a schema engine early.

## Security and Privacy Requirements

Canonical security and privacy decisions live in [`docs/security.md`](docs/security.md).
Requirement-level statements live in [`docs/requirements.md`](docs/requirements.md) §7.

Non-negotiable rules for agent sessions:

- Store all personal data **locally and encrypted**. It leaves the machine only as form
  submissions to the target sites the user acts on, and never as raw values to anything
  else; do not upload the data store; add no telemetry.
- **Minimize disclosure to the AI model**: send form structure / terms text, not raw
  personal values; do not use provider stateful features (prompt caching of PII, stored
  threads, memory).
- Encrypt at rest with AES-256-GCM under a key derived from a master passphrase
  (Argon2id / PBKDF2-SHA-512). The derived key stays in memory only. Treat the card
  security code (CVV) as the most sensitive field.
- **Never bypass CAPTCHA, MFA, bot detection, or access controls.** Detect and hand off.
- Only submit a registration after the user approves the review-and-confirm gate; apply
  the three guards; do not auto-submit on auto-creation-prohibited sites.
- Do not auto-attest eligibility/identity statements.
- Do not commit secrets, local state, real personal data, or AI review artifacts.

## User-Facing Documentation Policy

`README.md` should be written primarily for users, not implementation agents. Keep
detailed development guidance, architecture, tech-stack decisions, testing strategy, and
implementation constraints in `AGENTS.md`, this file, and `docs/`.

## Repository Documents

Use these documents when present:

- `README.md`: user-facing product overview, usage, limitations, and security notes
- `docs/README.md`: documentation index and ownership guide
- `docs/rfc/rfc-001-chrome-autofill-pivot.md`: **canonical product direction (RFC-001 v3)**
- `docs/requirements.md`: product requirements
- `docs/extension.md`: application architecture and design notes
- `docs/development.md`: setup, commands, and workflow
- `docs/testing.md`: testing strategy
- `docs/security.md`: security review notes
- `docs/manual-test.md`: manual test checklist
- `docs/github-operations.md`: GitHub workflow rules
- `docs/local-ai-review.md`: local cross-AI review hook documentation
- `.github/ISSUE_TEMPLATE/implementation-plan.md`: GitHub Issue implementation plan template

Update docs when behavior, setup, commands, architecture, or security assumptions change.

## Development Workflow

Branch naming, Issue workflow, commit conventions, PR descriptions, review expectations,
and merge policy live in [`docs/github-operations.md`](docs/github-operations.md).

Quick reminders for agent sessions:

- Keep changes small and reviewable, and prefer issue-driven work when a GitHub Issue exists.
- Use short-lived branches named `<agent>/issue-<number>-<short-slug>`.
- Do not commit secrets, local state, generated caches, or AI review artifacts.
- Do not commit real personal information in fixtures, screenshots, tests, or docs.

## Local AI Review

This repository may use a local Git `post-commit` hook for cross-AI review. Setup,
branch rules, skip conditions, and cleanup live in
[`docs/local-ai-review.md`](docs/local-ai-review.md).

- The hook is opt-in. Do not assume it has run unless verified in the current environment.
- Use `[skip-review]` only when [`docs/local-ai-review.md`](docs/local-ai-review.md) allows it.
- Treat hook output under `state/ai-reviews/` as local state. Do not commit it.

## Quality Gates

The canonical quality gate definitions live in [`docs/development.md`](docs/development.md).

- Run the gates documented there before committing code changes.
- Documentation-only changes may skip code-level gates when no generated output is affected.
- Do not invent passing results for commands that do not exist yet. State what is missing in PR notes.

## Implementation Guidance

- Prefer simple, deterministic logic where it suffices; reserve AI for form understanding.
- Keep DOM parsing / field classification isolated and testable.
- Keep wall detection (CAPTCHA / MFA) separate from field classification.
- Keep storage access behind a small, encrypted abstraction; never log decrypted values.
- Keep personal-data field definitions typed.
- Keep raw personal values out of AI requests; pass structure and substitute locally.
- Never implement CAPTCHA solving / bypass, MFA bypass, or bot-detection evasion.
- Make the review-and-confirm gate and the three guards explicit and testable.
- Support pausing on a wall and resuming in the same browser session.

## Manual Testing Expectations

Test strategy lives in [`docs/testing.md`](docs/testing.md); the manual checklist in
[`docs/manual-test.md`](docs/manual-test.md). When a change affects form detection,
filling, submission, the review-and-confirm gate, the three guards, wall hand-off, or
storage/encryption behavior, run the relevant items against the local test sites. Use
**fake data only**.

---

# Claude Code-Specific Instructions

## Role of Claude Code in This Repository

Claude Code should act as an implementation-focused coding agent that respects this
project's local-first, encrypted-storage, autonomous-agent, and never-bypass-walls
principles.

Primary responsibilities:

- read `README.md` and `AGENTS.md` before non-trivial edits
- make small, coherent code changes aligned with the shared instructions above and
  RFC-001 v3
- update documentation when behavior, commands, architecture, or security
  assumptions change
- run available quality gates when feasible and report results honestly
- clearly state what was changed, what was verified, and what was not

## Claude Code Operating Rules

- Do not assume Codex-specific automation runs in Claude Code sessions.
- Run format, lint, test, and typecheck commands explicitly when they exist; do not
  rely on hooks unless verified in this session.
- Confirm before destructive or hard-to-reverse actions (force pushes, branch deletion,
  large file rewrites, dependency removal, CI changes).
- Prefer the dedicated `Read`, `Edit`, and `Write` tools over `cat`, `sed`, or `echo`.
- Use parallel tool calls only for independent operations.
- Do not add new dependencies, frameworks, or build tools without a clear, documented reason.
- Do not add AI providers beyond the user's configured set, cloud sync, telemetry, or a
  backend server unless the user explicitly requests them.
- Do not weaken encryption, log decrypted values, or send raw personal data to the model.
- Do not use real user data when creating examples, tests, or fixtures.

## Claude Code Response Expectations

When finishing a task, keep the summary concise and factual: files changed, important
implementation choices, quality gates run (and outcomes), checks not run and why, and any
follow-up work. Avoid trailing recaps when a diff is sufficient.

## Claude Code Safety Notes

The product intentionally automates registration on the user's behalf. Claude Code
**may** implement: auto-fill, the review-and-confirm gate, delegated terms acceptance and
final submit after that approval, encrypted storage of personal data including card data
and credentials, and seamless wall hand-off / resume.

Claude Code **must not** implement, even here:

- bypassing or solving CAPTCHA, MFA, bot detection, rate limits, or access controls;
- checkout / payment beyond the approved free-trial→subscription card case;
- auto-submitting on sites whose terms prohibit automated account creation;
- auto-attesting eligibility/identity statements;
- sending raw personal values to the AI model or any non-provider service;
- storing data unencrypted or logging decrypted values.

If a requested change moves toward those behaviors, pause and clarify the safety boundary
with the user before implementing.
