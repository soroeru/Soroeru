# AGENTS.md

This file provides working instructions for AI coding agents in this repository.

It is intentionally split into two parts:

1. **Shared Agent Instructions**: rules and project context that should apply to both Codex and Claude Code.
2. **Codex-Specific Instructions**: rules that are specific to Codex sessions.

When creating or updating `CLAUDE.md`, reuse the shared sections and replace the Codex-specific section with Claude Code-specific guidance.

> **Direction change (2026-06-25).** The product is renamed and re-founded from
> `Catashiro` to **Soroeru（揃える）**: a local-first **agency engine** for the domain of
> personal information, online accounts, and online contracts. Soroeru is *not* framed as
> an "autonomous form-filling agent"; its purpose is to help the user **acquire and grow
> their own agency (free will)** in this domain — turning formally-possible choices into
> practically-exercisable ones. The canonical product direction is
> [`docs/requirements.md`](docs/requirements.md), which fully supersedes the prior
> Catashiro direction (history in git).
>
> The **repository / codebase identifier remains `catashiro`** (code is not renamed);
> **Soroeru** is the product name. Target architecture / technology selection is owned by
> [`docs/rfc/rfc-002-soroeru-architecture.md`](docs/rfc/rfc-002-soroeru-architecture.md).
> The first capability slice is **Visibility (building the disclosure ledger)**, not
> registration; the slice order is A Visibility → B Bulk Update → C Withdrawal → D
> Registration.

---

# Shared Agent Instructions

## Project Overview

**Soroeru** is a **local-first agency engine** for personal use, in the domain of personal
information, online accounts, and online contractual relationships.

The product's reason for being is that these decisions are *formally* possible but
*practically* impossible for a person alone (too tedious / complex / time-consuming /
unmemorable). Soroeru turns that **formal choosability into practical choosability**, and —
crucially — helps the user **acquire free will (agency) in this domain over time**. It must
never become a *delegation of will* ("it did it for me"); the success mode is "I can do
this." Soroeru automates *toil* (form filling, navigation, propagation) but keeps *judgment*
(what to disclose, to whom, under what terms, when to revoke) with the user, growing it
through repetition.

The first capability is **Visibility**: import the user's Google/Chrome Password Manager
CSV, auto-log in to each site, collect what is registered there, and build a **disclosure
ledger** so the user can see "what was given, where, and when," with stale values flagged.
Browser automation uses **Playwright** (browser-engine independence) in the target
architecture selected by RFC-002.

## Product Principles

- **Never become a delegation of will.** Success is "I can do this," not "it did it for
  me." Soroeru is an environment in which the user's will is *formed*, not a tool that
  executes a finished will.
- **Separate toil from judgment.** Toil (filling, navigation, propagation) may be fully
  automated; judgment (what/whom/terms/revocation) stays with the user and is grown.
- **Graduation / independence is success.** Over time the user should decide even when
  Soroeru's prompting is faint; dependence should go *down*, not up.
- **Default → understanding → self-selection.** Settings start at safe defaults; concise,
  low-frequency, repeated suggestions let the user understand each option and choose it.
- Keep the user's personal data **local and encrypted**; the user owns and manages it.
- Provide Soroeru as OSS so the code managing the user's single source of truth is
  inspectable, self-buildable, and portable.
- Do not operate a hosted vault; the encrypted vault lives on local disk by default and may
  later sync through user-owned cloud storage as encrypted bytes only.
- AI is optional: deterministic mode must be the default usable experience; AI mode is an
  API Provider enhancement for ambiguous or unsupported cases.
- **Never bypass CAPTCHA, MFA, bot detection, rate limits, paywalls, or access controls.**
  These are the unavoidable hand-off points to the human (see below).
- Do not perform checkout / payment. Exception: a free-trial-that-becomes-a-paid-
  subscription is surfaced as a high-risk item, and the card is filled only on the user's
  explicit approval.
- Prefer deterministic, inspectable matching logic; also evaluate an AI-driven variant.
- Limit network egress to the target sites the user acts on, the user's own AI provider,
  and future user-owned encrypted-vault storage; no telemetry or other external services;
  never upload decrypted data or raw personal values.
- Treat all stored personal data (including card data and per-site credentials) as
  sensitive by default.

## Autonomy and Human Hand-off Model

Only **toil** is delegated; **judgment** is not. Delegation is governed by an explicit
**Delegation Boundary**:

- **L0 confirm-required** (default for new users / high-risk operations): each execution is
  shown at the gate for approval.
- **L1 in-policy automatic** (MVP main mode): actions within the user's Policy run
  automatically; deviations, unknowns, and high-risk items are confirmed.
- **L2 fully automatic**: **out of scope for the MVP** (closest to delegation of will).

Expansion (L0 → L1) is **user-initiated and gated by a light understanding check**, opened
per operation type; reduction is **unconditional and immediate**. No implicit expansion.

Human intervention also occurs for **missing data** (prompt and save a new reusable field)
and at **walls that cannot be automated** — CAPTCHA, MFA / OTP, identity verification,
email/SMS verification. The agent **detects but never bypasses** these; it hands off in the
**same headed browser session**, waits, then resumes from where it paused.

Actions that touch the world (e.g., a registration submit) use a **review-and-confirm gate**:
before acting, it shows what will be submitted, terms links, and any detected high-risk
clauses. The gate is treated as the **moment of agency**, designed to cultivate the user's
own judgment, not to be rubber-stamped.

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

A **fourth absolute boundary** (always confirmed, even at L1): **deleting data stored inside
Soroeru** — an irreversible destruction of the user's own source of truth.

Explicitly *not* absolute boundaries: **withdrawing from a site** (may execute within the
delegated range) and a **first-seen site** (the three guards suffice).

**Sites whose terms prohibit automated account creation**: a detected automation-prohibiting
clause is **surfaced as a Constraint / high-risk item for the user to decide** — not silently
hard-blocked and not unilaterally executed (the agency principle: inform; the user decides).
The user may then choose to proceed (within the review-and-confirm gate and the three guards)
or to stop. What is **never** done is bypassing controls a site **actively enforces** —
CAPTCHA / MFA / bot detection — which are always detected and handed off.

## Initial Scope

Slice order: **A Visibility → B Bulk Update → C Withdrawal cleanup → D New registration
(last).** See [`docs/requirements.md`](docs/requirements.md) for the full requirements.

- Local, encrypted store of the user's **Personal Attributes** (canonical values): name
  (incl. phonetic/romanized), email, phone, postal code & addresses, company/department,
  **credit card (number, expiry, holder, CVV)**, **per-site login ID/password**, and
  dynamically added fields.
- **A — Visibility (first slice)**: import the Google/Chrome Password Manager CSV
  (`name, url, username, password, note`), auto-log in to each site, collect registered
  personal info, and build the **Disclosure ledger** (references + hashes, not duplicated
  raw values). Flag stale values (Disclosure ≠ canonical). Track **Account Relationship**
  (newsletter / recurring billing / last-used) and provide filtered lists.
- **B — Bulk update**: diff Disclosures against canonical values (cross-site by attribute)
  and update changed fields.
- **C — Withdrawal cleanup**: stop newsletters, cancel unused subscriptions, withdraw from
  unused services; irreversible final actions and Soroeru-internal deletion stay gated.
- **D — New registration (last)**: URL-driven registration with the review-and-confirm gate
  and three guards.
- Two-layer **Reflection** (initial footprint + post-action change) and **Policy/Preference**
  formation (suggest after 3 consistent observations, ≤1/day; promote only on explicit
  user confirmation).
- Settings, including the user's own AI provider API key.
- Shared definitions for deterministic and AI modes; local candidate definitions stored
  encrypted, shared only after explicit opt-in sanitization/review.
- Detect CAPTCHA / MFA / verification walls and hand off / resume seamlessly.

## Explicitly Out of Scope

Do not implement these unless the user explicitly changes the scope:

- **L2 full automation** (MVP); delegation of judgment of any kind
- checkout / purchase / payment (except the free-trial→subscription card case above)
- **bypassing** CAPTCHA, MFA, bot detection, rate limits, paywalls, or access controls
- collecting other people's data (only the user's own accounts, with the user's own
  credentials)
- multi-locale form detection (Japanese-only for now; multi-locale is later)
- Soroeru-operated hosted vaults, backend API servers, telemetry, analytics, or crash
  reporting
- app-embedded terminals, CLI Provider integration, or using Claude Code / Codex CLI as
  the primary AI integration path
- MCP server support in the MVP; a strictly permissioned local MCP server may be added
  later for advanced users, but it must not expose raw personal values or bypass
  Soroeru's approval gates
- mobile apps, iOS app, Android Autofill Service
- using any AI provider other than the user's configured one

## Tech Stack

Target stack is defined in
[`docs/rfc/rfc-002-soroeru-architecture.md`](docs/rfc/rfc-002-soroeru-architecture.md):

- Electron desktop app, TypeScript / Node.js, React + Vite renderer.
- Playwright Library for headed browser automation, run behind a narrow automation service.
- Versioned encrypted record vault using AES-256-GCM with Argon2id
  (PBKDF2-HMAC-SHA-512 fallback), derived key in memory only.
- Deterministic-first analysis; optional user-configured Anthropic/OpenAI providers only,
  structure-only disclosure, no raw PII to the model.
- Unsigned macOS DMG for MVP; signing/notarization and auto-update are later.

Do not introduce a framework, build tool, package manager, test runner, or backend service
outside RFC-002's target stack without a new Issue/RFC explaining the requirements reason.

## Expected Architecture

Target architecture is RFC-002. [`docs/extension.md`](docs/extension.md) and
[`docs/development.md`](docs/development.md) still describe the *previous* Catashiro
architecture/workflow and are retained only as reference until implementation docs are
rewritten.

Conceptually and architecturally, Soroeru separates: a **store/vault service** of canonical
Personal Attributes, Site Accounts, Disclosures, Account Relationships, Mandates, Evidence,
Policies, and Reflections; a **domain service** that owns Policy and Delegation Boundary
decisions; a **definition/agent** layer (deterministic by default, optional AI analysis
that receives structure, not raw values); an **automation** layer that drives a headed
browser to log in, collect, update, withdraw, and hand off / resume; and a **UI** that is a
*place of self-understanding* (the ledger, filtered lists, Reflection, the gate, Delegation
Boundary, settings).

## Field Detection Strategy

Two variants are built and compared (see RFC-002 §7):

1. **Deterministic**: reuse the scanner (`src/agent/scan.ts`) and rule-based classifier
   (`src/agent/classifier.ts`) to map fields (`autocomplete`, `name`, `id`,
   `placeholder`, `label`, nearby text). Examples: `autocomplete="email"` → email;
   `住所` label → address.
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
Requirement-level statements live in [`docs/requirements.md`](docs/requirements.md) §8.

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
  the three guards; surface a detected automation-prohibiting ToS clause as a Constraint
  for the user to decide (never silently block, never bypass actively-enforced controls).
- Do not auto-attest eligibility/identity statements.
- Do not commit secrets, local state, real personal data, or AI review artifacts.

## User-Facing Documentation Policy

`README.md` should be written primarily for users, not implementation agents. Keep
detailed development guidance, architecture, tech-stack decisions, testing strategy, and
implementation constraints in `AGENTS.md`, `CLAUDE.md`, and `docs/`.

## Repository Documents

Use these documents when present:

- `README.md`: user-facing product overview, usage, limitations, and security notes
- `docs/README.md`: documentation index and ownership guide
- `docs/requirements.md`: **canonical product direction** and product requirements (Soroeru)
- `docs/rfc/rfc-002-soroeru-architecture.md`: target Soroeru architecture and technology selection
- `docs/extension.md`: previous Catashiro architecture (**superseded**, reference only)
- `docs/development.md`: setup, commands, and workflow (previous Catashiro; **in flux** until RFC-002 implementation docs land)
- `docs/testing.md`: testing strategy
- `docs/security.md`: security review notes
- `docs/manual-test.md`: manual test checklist
- `docs/github-operations.md`: GitHub workflow rules
- `docs/local-ai-review.md`: local AI review hook documentation
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

This repository may use a local Git `post-commit` hook for AI review. Setup,
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

# Codex-Specific Instructions

## Role of Codex in This Repository

Codex should act as an implementation-focused coding agent for Soroeru, respecting the
local-first, encrypted-storage, and never-bypass-walls principles
above.

Primary responsibilities:

- read the repository instructions before editing
- make small, coherent code changes aligned with the shared sections and RFC-002
- update documentation when behavior or commands change
- run available checks when feasible
- clearly report what was changed and what was not verified

## Codex Operating Rules

- Do not assume Claude Code hooks run inside Codex sessions.
- Run format, lint, test, and typecheck commands explicitly when needed and available.
- Respect sandbox and approval requirements for network, GUI, or destructive operations.
- Prefer repository-local patterns and documented commands over ad hoc tooling.
- Do not add new dependencies without a clear reason.
- Do not add AI providers beyond the user's configured set, telemetry, backend servers,
  hosted vaults, or user-owned cloud-sync implementations unless explicitly requested.
- Do not weaken encryption, log decrypted values, or send raw personal data to the model.
- Do not use real user data when creating examples, tests, or fixtures.

## Codex Response Expectations

When finishing a task, report: files changed, important implementation choices, tests or
checks run, checks not run and why, and any follow-up work. Keep summaries concise.

## Codex Safety Notes

The product intentionally automates registration on the user's behalf. Codex **may**
implement: auto-fill, the review-and-confirm gate, delegated terms acceptance and final
submit after that approval, encrypted storage of personal data including card data and
credentials, and seamless wall hand-off / resume.

Codex **must not** implement, even here:

- bypassing or solving CAPTCHA, MFA, bot detection, rate limits, or access controls;
- checkout / payment beyond the approved free-trial→subscription card case;
- silently proceeding past a detected automation-prohibiting ToS clause instead of
  surfacing it as a Constraint / high-risk item for the user to decide;
- auto-attesting eligibility/identity statements;
- sending raw personal values to the AI model or any non-provider service;
- storing data unencrypted or logging decrypted values.

If a requested change moves toward those behaviors, pause and clarify the safety boundary
before implementing.
