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

`Catashiro` keeps the user's personal data **locally and encrypted** and uses an AI agent
plus Playwright browser automation to register on new sites and update existing accounts
on the user's behalf, with a single review-and-confirm step per registration. Keeping the
data local means the user owns and manages their own information rather than handing it to
a third-party service.

Browser automation uses Playwright so the agent works across browser engines (Chromium /
Firefox / WebKit) rather than depending on one browser's Catashiro.

## 2. Product Principles

- The user's personal data stays local and encrypted; the user owns it.
- The AI agent acts autonomously; required human intervention is minimized.
- Registration auto-submits only after the user approves a review-and-confirm gate.
- Never bypass CAPTCHA, MFA, bot detection, or access controls — detect and hand off.
- No checkout / payment, except a free-trial→subscription card case approved by the user.
- Prefer deterministic, inspectable matching; also evaluate an AI-driven variant.
- Network egress only to the target sites the user acts on and the user's configured AI provider; no telemetry; never upload the data store.
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
- URL-driven autonomous registration with the review-and-confirm gate and three guards.
- Per-site inventory of submitted fields (references + hashes, not duplicated raw values)
  and authorization records.
- Bulk update across selected sites by diffing against the latest stored values.
- Settings, including the user's own AI provider API key.
- CAPTCHA / MFA / verification wall detection with seamless hand-off and resume.
- Two field-detection variants (deterministic and AI-driven) compared for accuracy.

## 5. Non-Scope

- checkout / purchase / payment (except the approved free-trial→subscription card case);
- **bypassing** CAPTCHA, MFA, bot detection, rate limits, paywalls, or access controls;
- auto-submitting on sites whose terms prohibit automated account creation (fill only);
- auto-attesting eligibility / identity statements;
- multi-locale form detection in the PoC (PoC is Japanese-only);
- cloud sync, backend API servers, telemetry;
- mobile apps, iOS app Catashiro, Android Catashiro Service;
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

## 7. Non-Functional Requirements

Detailed security and privacy decisions live in [`security.md`](security.md). This
section records requirement-level statements.

| ID | Category | Requirement | Target |
| --- | --- | --- | --- |
| SEC-001 | Security | Personal data (incl. card data and credentials) is encrypted at rest with AES-256-GCM under a master-passphrase-derived key. | No plaintext at rest; derived key in memory only. |
| SEC-002 | Security | Never bypass CAPTCHA, MFA, bot detection, or access controls. | Detect and hand off to the user. |
| SEC-003 | Security | Raw personal values are not sent to the AI model; only form structure / terms text. | Structure to model, values local. |
| PRIV-001 | Privacy | Network egress only to the target sites the user acts on and the user's configured AI provider; no telemetry; the data store is never uploaded. | Local-first. |
| PRIV-002 | Privacy | No provider stateful features (prompt caching of PII, stored threads, memory). | Stateless requests; zero-retention where available. |
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

## 9. Field Detection Requirements

Two variants are built and compared (RFC §8):

1. **Deterministic** — reuse the scanner and rule-based classifier, inspecting
   `autocomplete`, `name`, `id`, `placeholder`, associated and wrapping `label` text, and
   safely collectible nearby text. Examples: `autocomplete="email"` → email; `住所` →
   address; `会社名` → company.
2. **AI-driven** — the model receives form structure and returns a mapping plan; values
   are filled locally.

The PoC measures success and mis-mapping rates for both, Japanese-only. Ambiguous fields
should be low-confidence or deferred to the user, not guessed with false confidence.

## 10. Wall Detection Requirements

Wall detection is conservative and exists only to hand off, never to circumvent. It may
recognize CAPTCHA widgets / text, OTP / MFA fields, and verification wording. It must not
solve, bypass, obscure, or outsource any anti-abuse mechanism; when uncertain, it stops
and asks the user.

## 11. Dynamic Schema Direction

When a form needs a field not in the store, the agent prompts the user and adds it as a
new reusable field. Keep field definitions typed and behind a small abstraction; do not
build a heavy schema engine early.

## 12. Glossary

| Term | Definition |
| --- | --- |
| Personal data field | A locally stored, encrypted value (name, address, phone, email, card data, per-site credential, or a custom field). |
| Field detection | Finding form controls and collecting metadata about them. |
| Field classification | Mapping a detected control to a stored field type (deterministic or AI-driven). |
| Review-and-confirm gate | The single post-analysis approval the user gives before the agent submits a registration. |
| Three guards | High-risk clause escalation, payment stop (free-trial exception), and no auto-attestation. |
| Wall | A step that cannot/should not be automated: CAPTCHA, MFA, identity / email / SMS verification. |
| Mandate | A per-registration authorization record of what the user approved (references, hashes, terms URL). |
| Per-site record | Local record of what was submitted to a site (references + hashes, not duplicated raw values). |
