# Requirements

This document owns the **product requirements** for `Catashiro`: scope, non-scope,
the autonomy / hand-off model, use cases, and non-functional requirements.

Canonical product direction is
[`rfc-001-chrome-autofill-pivot.md`](rfc/rfc-001-chrome-autofill-pivot.md) (RFC-001 v3).
Out of scope here: application architecture (see [`extension.md`](extension.md)),
security rationale (see [`security.md`](security.md)), and agent operating rules (see
`../AGENTS.md` and `../CLAUDE.md`).

> **Direction change (2026-06-12).** `Catashiro` is no longer a human-in-the-loop Chrome
> extension. It is a local-first, autonomous agent that stores the user's full personal
> data (encrypted) and registers / updates the user's accounts on their behalf via
> Playwright. This document reflects that direction.

## 1. Background

People register the same personal information across many sites and must keep it current
when it changes (moving, new phone number, new card). Doing this by hand is repetitive.

`Catashiro` keeps the user's personal data **locally and encrypted** and uses Playwright
browser automation to register on new sites, update existing accounts, and help the user
withdraw from services they no longer use. Keeping the data local means the user owns and
manages their own information rather than handing it to a third-party service.

The core product is a **personal-data ledger and per-site account-state manager**: the
user can see which sites hold which classes of personal information, what was approved,
which records are stale, and which services are candidates for withdrawal. Form filling is
an important automation capability, but it is a means to keep that ledger current rather
than the product's only purpose.

Browser automation uses Playwright so the agent works across browser engines (Chromium /
Firefox / WebKit) rather than depending on one browser's built-in autofill.

## 1.1 MVP And Private Beta Target

The MVP target is a **Mac-only desktop private beta for about 10 known users**. This is a
scope boundary for the first usable release, not a permanent product limitation.

MVP platform and support boundaries:

- Supported OS: macOS 14 Sonoma and macOS 15 Sequoia on Apple Silicon Macs.
- Distribution: a downloadable Mac desktop app for invited beta users.
- Install path: the user installs the app in `/Applications`; development builds may run
  from the checkout during testing.
- Data location: the encrypted vault lives on local disk by default under the user's app
  support directory; the user may choose another local folder. User-owned cloud storage is
  post-MVP unless a later issue explicitly enables it as encrypted bytes only.
- Browser engines: Playwright-driven Chromium, Firefox, and WebKit remain the automation
  target. The beta app must at least verify the default packaged engine path, with the
  cross-engine matrix kept as development coverage.
- Support model: invited users report issues directly to the maintainer using fake data
  screenshots where possible; support bundles must be local-only and must not include raw
  personal values.
- Signing/notarization: desirable before wider distribution, but not required to start the
  first 10-user private beta if the install instructions clearly explain the limitation.

Minimum beta workflows:

1. First-run onboarding, vault setup, lock/unlock, and recovery key flow.
2. Personal-data management for required fields, card fields, credentials, custom fields,
   and AI provider settings.
3. Add Site flow that can branch between new registration and existing-account import.
4. Autonomous new registration with the review-and-confirm gate, three guards, wall
   hand-off/resume, and per-site inventory recording.
5. Existing-account import sufficient to seed the inventory for sites the user already
   uses.
6. Bulk update for stale personal data across selected sites.
7. Withdrawal task preparation with irreversible final actions behind explicit user
   confirmation.
8. Local-only diagnostics and a user manual / landing page suitable for the invited beta.

Private beta success means at least 8 of the 10 invited users can complete onboarding,
add or import at least one site, inspect what Catashiro recorded, and understand the
safety boundaries without maintainer intervention. At least 3 users should complete a
bulk-update or withdrawal-preparation flow using fake or low-risk test accounts before
the beta expands.

## 2. Product Principles

- The user's personal data stays local and encrypted; the user owns it.
- `Catashiro` should be provided as OSS so the code managing the user's personal-data
  single source of truth is inspectable, self-buildable, and portable.
- The app should be a local-first desktop application; `Catashiro` must not operate a
  hosted vault that stores users' personal data.
- The user should be able to choose where the encrypted vault lives: local disk by
  default, and later a user-owned cloud-storage folder/provider for encrypted sync.
- The AI agent acts autonomously; required human intervention is minimized.
- AI must be optional. The default experience must work in deterministic mode without an
  AI API key; AI mode is an enhancement for ambiguous or unsupported cases.
- Registration auto-submits only after the user approves a review-and-confirm gate.
- Never bypass CAPTCHA, MFA, bot detection, or access controls — detect and hand off.
- No checkout / payment, except a free-trial→subscription card case approved by the user.
- Prefer deterministic, inspectable matching; also evaluate an AI-driven variant.
- Network egress only to the target sites the user acts on, the user's configured AI
  provider, and future user-owned encrypted vault storage (encrypted bytes only); no
  telemetry; never upload the decrypted data store or raw personal values.
- Treat all stored data (including card data and credentials) as sensitive.

## 3. Autonomy and Human Hand-off Model

The agent acts on the user's behalf. Human intervention is limited to:

1. **Missing data** — the agent prompts the user for a value not in the store and saves
   it for reuse.
2. **Unautomatable walls** — CAPTCHA, MFA / OTP, identity verification, email/SMS
   verification. The agent detects (never bypasses) these and hands off in the same
   headed browser session, then resumes from where it paused.

Registration flow:

1. the user gives a URL;
2. the agent finds the registration page and analyzes the form;
3. the agent prompts for any missing field and saves it;
4. the agent shows a **review-and-confirm gate** (what will be submitted, terms links,
   high-risk clauses);
5. on the user's single approval, the agent fills, accepts ordinary terms, and submits,
   applying the **three guards**;
6. the agent records a per-site entry and an authorization record (mandate).

## 4. Scope

- Local, encrypted store of the user's personal data: name (incl. phonetic / romanized),
  email, phone, postal code, addresses (home / work / shipping / billing), company,
  department, **credit card (number, expiry, holder, CVV)**, **per-site login ID /
  password**, and dynamically added fields.
- Per-site account-state inventory: registration state, submitted-field references,
  mandates, stale fields, update status, withdrawal status, and service-use status.
- URL-driven autonomous registration with the review-and-confirm gate and three guards.
- Per-site inventory of submitted fields (references + hashes, not duplicated raw values)
  and authorization records.
- Bulk update across selected sites by diffing against the latest stored values.
- Withdrawal assistance for services the user no longer uses, subject to the same wall
  hand-off and final-confirmation boundaries.
- Settings, including the user's own AI provider API key when AI mode is enabled.
- Optional user-owned encrypted cloud-storage sync for the vault, after a dedicated
  design/implementation issue defines provider support and egress controls.
- CAPTCHA / MFA / verification wall detection with seamless hand-off and resume.
- Shared site/form/field/withdrawal/wall definitions used by deterministic mode and AI
  mode.
- Local AI-generated candidate definitions that can be reused by the same user and, only
  after explicit opt-in sanitization/review, proposed for shared official definitions.
- Mac desktop private beta distribution, docs, manual QA, and support workflow for the
  first invited users.

## 5. Non-Scope

- Windows, Linux, mobile apps, and browser-extension distribution for the MVP;
- checkout / purchase / payment (except the approved free-trial→subscription card case);
- **bypassing** CAPTCHA, MFA, bot detection, rate limits, paywalls, or access controls;
- auto-submitting on sites whose terms prohibit automated account creation (fill only);
- auto-attesting eligibility / identity statements;
- multi-locale form detection in the PoC (PoC is Japanese-only);
- `Catashiro`-operated hosted vaults, backend API servers, telemetry, analytics, or crash
  reporting;
- app-embedded terminals, CLI Provider integration, or using Claude Code / Codex CLI as
  the primary AI integration path;
- MCP server support in the MVP; a strictly permissioned local MCP server may be added
  later for advanced users, but it must not expose raw personal values or bypass
  `Catashiro`'s approval gates;
- mobile apps, iOS app Catashiro, Android Autofill Service;
- using any AI provider other than the user's configured one.

## 6. Functional Requirements

| ID | Requirement | Priority | Status |
| --- | --- | --- | --- |
| REQ-001 | Store and edit the user's personal data locally, **encrypted at rest**. | Must | Planned |
| REQ-002 | Store credit card data (incl. CVV) and per-site credentials, encrypted, with CVV treated as most sensitive. | Must | Planned |
| REQ-003 | Given a URL, find the registration page and analyze the form (Playwright). | Must | Planned |
| REQ-004 | Map form fields to stored data (deterministic and AI-driven variants). | Must | Planned |
| REQ-005 | Prompt for missing fields and save them as new reusable fields. | Must | Planned |
| REQ-006 | Show a review-and-confirm gate before submitting; submit only on user approval. | Must | Planned |
| REQ-007 | Apply the three guards (high-risk clause escalation, payment stop with free-trial exception, no auto-attestation). | Must | Planned |
| REQ-008 | On auto-creation-prohibited sites, fill only and let the user submit. | Must | Planned |
| REQ-009 | Detect CAPTCHA / MFA / verification walls; never bypass; hand off and resume in the same session. | Must | Planned |
| REQ-010 | Keep a per-site inventory and an authorization record (mandate) per registration. | Must | Planned |
| REQ-011 | Bulk-update selected sites by diffing against the latest stored values. | Must | Planned |
| REQ-012 | Use the user's configured AI provider only; never send raw personal values to the model. | Must | Planned |
| REQ-013 | Work without AI by default through deterministic definitions and classifiers. | Must | Planned |
| REQ-014 | Use AI mode only as an optional enhancement for ambiguous or unsupported cases, via API Provider integration. | Should | Planned |
| REQ-015 | Store AI-generated candidate definitions locally and encrypted; never treat them as official until reviewed/promoted. | Should | Planned |
| REQ-016 | Support withdrawal management so the user can identify and leave services they no longer use. | Should | Planned |
| REQ-017 | Allow the user to place the encrypted vault in a user-owned storage location, including future cloud-storage sync, without giving `Catashiro` a hosted copy. | Could | Planned |

### 6.1 Per-Site Account-State Model

Each site in the inventory has an `accountState` separate from the latest operation
result. The state drives the next user-visible action:

| State | Meaning | Next action |
| --- | --- | --- |
| `unknown` | Catashiro has seen the site but has no account evidence yet. | Start registration |
| `notRegistered` | The user declined or confirmed there is no account. | Start registration |
| `registrationPending` | The agent filled data or hit a wall, but account creation is not complete. | Resume registration |
| `registered` | Catashiro registered the account and has submitted-field hashes. | Review inventory |
| `imported` | Catashiro imported an existing account into the inventory. | Review inventory |
| `updateNeeded` | Stored field hashes are stale against current profile values. | Run update |
| `updateFailed` | The last update attempt failed or could not confirm completion. | Retry update |
| `withdrawalCandidate` | The user or diagnostics marked the service as a withdrawal candidate. | Prepare withdrawal |

Inventory records store references and hashes for submitted/imported fields, never raw
personal values. `lastCheckedAt`, `lastUpdatedAt`, mandates, stale-field labels, and the
next action are safe inventory metadata and may be shown in the UI.

## 7. Non-Functional Requirements

Detailed security and privacy decisions live in [`security.md`](security.md). This
section records requirement-level statements.

| ID | Category | Requirement | Target |
| --- | --- | --- | --- |
| SEC-001 | Security | Personal data (incl. card data and credentials) is encrypted at rest with AES-256-GCM under a master-passphrase-derived key. | No plaintext at rest; derived key in memory only. |
| SEC-002 | Security | Never bypass CAPTCHA, MFA, bot detection, or access controls. | Detect and hand off to the user. |
| SEC-003 | Security | Raw personal values are not sent to the AI model; only form structure / terms text. | Structure to model, values local. |
| PRIV-001 | Privacy | Network egress only to the target sites the user acts on, the user's configured AI provider, and future user-owned encrypted vault storage (encrypted bytes only); no telemetry; the decrypted data store is never uploaded. | Local-first. |
| PRIV-002 | Privacy | No provider stateful features (prompt caching of PII, stored threads, memory). | Stateless requests; zero-retention where available. |
| PRIV-003 | Privacy | Local candidate definitions and per-site activity metadata are treated as private, even when they do not contain raw profile values. | Encrypted with the vault. |
| SAFE-001 | Safety | Registrations submit only after the user approves the review-and-confirm gate. | No blind auto-submit. |
| PERF-001 | Performance | Form analysis and filling should complete without excessive delay on ordinary forms. | Usable per-site latency. |
| MAINT-001 | Maintainability | Field classification, wall detection, and storage/encryption are isolated and testable. | No scattered DOM or crypto logic. |
| PORT-001 | Portability | Automation works across Chromium / Firefox / WebKit via Playwright. | No single-engine dependency. |

## 8. Use Cases

### UC-001: Register on a New Site

The user gives a URL. The agent finds the registration page, fills the form from the
store, prompts for anything missing, shows the review-and-confirm gate, and on approval
submits and records the result.

### UC-002: High-Risk Terms Surfaced

A registration's terms include an auto-renewing subscription. The agent surfaces it in
the gate; the user decides. If approved (free-trial→subscription), the card is auto-filled.

### UC-003: Site Prohibits Automated Account Creation

The agent fills the data but does not submit; it explains the restriction and the user
presses the final button.

### UC-004: Hand-off at a Wall

Registration reaches a CAPTCHA or MFA step. The agent pauses, the user resolves it in the
same browser window, and the agent resumes automatically.

### UC-005: Bulk Update After a Change

The user updates their address in the store, selects affected sites, and runs the bulk
update; the agent diffs and updates the changed field on each site, handing off at any
walls.

### UC-006: Manage Personal Data

The user opens the data-management UI to add, edit, or delete fields (including card data
and credentials) and set the AI provider API key.

### UC-007: Track and Withdraw from Unused Services

The user reviews their per-site inventory, identifies services they no longer use, and
asks `Catashiro` to help find the withdrawal flow. The app prepares a withdrawal task and
hands off at walls; irreversible account deletion or final withdrawal confirmation must
remain gated by the user.

### UC-008: Use AI Only When Needed

The user normally runs deterministic mode. When a form or withdrawal flow is unsupported
or ambiguous and the user has enabled AI mode with their own API key, the app sends only
the sanitized form/flow structure and relevant candidate definitions to the configured AI
provider, then validates the returned candidate before reuse.

### UC-009: Sync an Encrypted Vault Through User-Owned Storage

The user chooses a local folder or supported cloud-storage folder for the encrypted vault.
The storage provider receives only encrypted vault bytes and never receives the passphrase,
derived key, decrypted records, or raw personal values from `Catashiro`.

## 9. Field Detection Requirements

Two variants share the same site/form definition format and are compared (RFC §8):

1. **Deterministic** — reuse the scanner and rule-based classifier, inspecting
   `autocomplete`, `name`, `id`, `placeholder`, associated and wrapping `label` text, and
   safely collectible nearby text. Examples: `autocomplete="email"` → email; `住所` →
   address; `会社名` → company.
2. **AI-driven** — the model receives form structure and returns a mapping plan; values
   are filled locally. AI mode is used for unsupported or ambiguous cases, not as a
   requirement for the standard experience.

The PoC measures success and mis-mapping rates for both, Japanese-only. Ambiguous fields
should be low-confidence, resolved by AI mode if configured, or deferred to the user, not
guessed with false confidence.

AI-generated local candidate definitions are private user state. They may improve that
user's later runs immediately, but they become shared official definitions only after
explicit user opt-in, sanitization, review, and tests.

## 10. Wall Detection Requirements

Wall detection is conservative and exists only to hand off, never to circumvent. It may
recognize CAPTCHA widgets / text, OTP / MFA fields, and verification wording. It must not
solve, bypass, obscure, or outsource any anti-abuse mechanism; when uncertain, it stops
and asks the user.

## 11. Dynamic Schema Direction

When a form needs a field not in the store, the agent prompts the user and adds it as a
new reusable field. Keep field definitions typed and behind a small abstraction; do not
build a heavy schema engine early.

## 12. Mac Private Beta Scope Completion (#97)

All implementation issues for the first private beta have been completed as of 2026-06-16.
The table below records each issue and its outcome.

| Issue | Title | Status |
| ----- | ----- | ------ |
| #74 | Mac-only MVP scope and beta success criteria | ✅ Done |
| #75 | Package Catashiro as a downloadable Mac desktop app | ✅ Done |
| #76 | Per-site inventory and account-state model | ✅ Done |
| #77 | Encrypted vault storage, migrations, export, and import | ✅ Done |
| #78 | Personal data management UI | ✅ Done |
| #79 | First-run onboarding, vault setup, and recovery | ✅ Done |
| #80 | Shared site definitions and encrypted local candidate definitions | ✅ Done |
| #81 | Autonomous new-registration flow in the Mac app UI | ✅ Done |
| #82 | Review-and-confirm gate with the three guards | ✅ Done |
| #83 | Add Site branching: new registration vs existing-account import | ✅ Done |
| #84 | Existing-account personal-data import | ✅ Done |
| #85 | Wall hand-off and resume UX | ✅ Done |
| #86 | Optional AI Provider mode | ✅ Done |
| #87 | Release checklist and manual QA | ✅ Done |
| #88 | Bulk update flow | ✅ Done |
| #89 | Privacy and security hardening gates | ✅ Done |
| #90 | Local-only diagnostics and support bundle | ✅ Done |
| #91 | Withdrawal task support | ✅ Done |
| #92 | User manual for initial Mac beta users | ✅ Done |
| #93 | Local test sites and E2E coverage | ✅ Done |
| #94 | Task progress UI for long-running automation flows | ✅ Done |
| #95 | Landing page for Mac app download | ✅ Done |
| #96 | Private beta feedback workflow for about 10 initial users | ✅ Done |

**Nothing was deferred from the first beta scope.** The next phase is to invite the initial
10 users and collect feedback through the workflow described in
[`beta-feedback.md`](beta-feedback.md).

## 13. Glossary

| Term | Definition |
| --- | --- |
| Personal data field | A locally stored, encrypted value (name, address, phone, email, card data, per-site credential, or a custom field). |
| Field detection | Finding form controls and collecting metadata about them. |
| Field classification | Mapping a detected control to a stored field type (deterministic or AI-driven). |
| Deterministic Mode | The default mode that uses official definitions, local candidate definitions, and rule-based classifiers without an AI API key. |
| AI Mode | Optional mode that uses the user's configured API Provider for ambiguous or unsupported form, terms, or withdrawal analysis. |
| Candidate definition | A local, unreviewed site/form/field/withdrawal/wall definition generated by AI mode, user input, or observation; private until explicitly submitted. |
| Review-and-confirm gate | The single post-analysis approval the user gives before the agent submits a registration. |
| Three guards | High-risk clause escalation, payment stop (free-trial exception), and no auto-attestation. |
| Wall | A step that cannot/should not be automated: CAPTCHA, MFA, identity / email / SMS verification. |
| Mandate | A per-registration authorization record of what the user approved (references, hashes, terms URL). |
| Per-site record | Local record of what was submitted to a site (references + hashes, not duplicated raw values). |
| User-owned cloud storage | A storage location chosen and controlled by the user where only encrypted vault bytes may be synced. |
