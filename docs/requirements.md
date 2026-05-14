# Requirements

This document owns the product requirements for `formfill-assistant`.

It is the primary source for v0.1 scope, non-scope, human-in-the-loop behavior,
use cases, and non-functional requirements. Agent-specific operating rules
belong in `../AGENTS.md` and `../CLAUDE.md`.

## 1. Background

Many websites ask users to enter the same personal or business information over
and over again. The initial problem is not that users need a fully autonomous
agent; it is that repetitive form entry is tedious while still requiring human
judgment.

`formfill-assistant` starts as a local-first Chrome extension because the
browser page is where the form fields exist, and because the first version
should not require a backend service to store profile data. Keeping data local
also keeps the security model easier to inspect while the product is still
small.

The product may later grow toward more complex business and contract-form
assistance, but v0.1 should stay focused on a small, usable extension that helps
one user fill ordinary forms after explicit confirmation.

## 2. Product Principles

- Prefer user-confirmed assistance over autonomous automation.
- Keep the user responsible for judgment, consent, identity verification, and
  final submission.
- Fill only fields the user explicitly selects.
- Keep profile data local in v0.1.
- Avoid backend services, telemetry, cloud sync, and AI classification until
  they are clearly needed and explicitly scoped.
- Use deterministic, inspectable matching rules before introducing more complex
  inference.
- Treat profile data, business data, and contract-adjacent data as sensitive.
- Keep Chrome extension permissions as narrow as practical.

## 3. Human-In-The-Loop Model

The extension assists the user without pretending to be the user. When a page
requires a human step such as CAPTCHA, MFA, terms confirmation, identity
verification, file upload confirmation, or final submission, the extension
should stop filling-related activity for that step and show guidance instead of
trying to complete it.

The expected flow is:

1. detect that a human step may be present;
2. avoid filling, checking, clicking, or submitting anything related to that
   step;
3. tell the user what kind of action appears to be required;
4. wait for the user to complete the action;
5. re-scan the current page after the user continues;
6. resume suggestions only for remaining ordinary fillable fields.

Human-in-the-loop behavior is part of the product design, not an exception path.

## 4. v0.1 Scope

v0.1 includes:

- local management of basic profile fields:
  - full name
  - email address
  - phone number
  - postal code
  - address
  - company name
  - department name
  - other manually defined fields
- detection of `input`, `textarea`, and `select` elements on the active page;
- rule-based field meaning inference from attributes and nearby text;
- visible suggestions for likely matching profile fields;
- user-triggered filling of selected fields;
- local recording of which URL used which profile field types;
- an options page for profile fields, custom field definitions, settings, and
  site-field history;
- conservative detection of states that appear to require a manual human step;
- re-scanning after user-driven page changes or dynamic form updates.

## 5. v0.1 Non-Scope

v0.1 does not include:

- automatic form submission;
- automatic account registration;
- automatic address changes across multiple websites;
- automatic contract modification;
- CAPTCHA solving, CAPTCHA bypass, or CAPTCHA outsourcing;
- MFA, bot-detection, rate-limit, paywall, or access-control bypass;
- automatic acceptance of terms, policies, contracts, or consent checkboxes;
- password manager functionality;
- credit card storage;
- cloud sync;
- Google Drive or Dropbox integration;
- backend API servers;
- mobile apps;
- iOS app autofill or Android Autofill Service;
- BYOC deployment, Terraform automation, or Cloudflare Browser Run integration;
- autonomous browser AI agents;
- LLM-based field classification.

## 6. Functional Requirements

| ID | Requirement | Priority | Status |
| --- | --- | --- | --- |
| REQ-001 | The extension can store and edit basic profile fields locally. | Must | Planned |
| REQ-002 | The content script can detect visible `input`, `textarea`, and `select` fields on the active page. | Must | Planned |
| REQ-003 | Field detection uses inspectable rules based on `autocomplete`, `name`, `id`, `placeholder`, associated labels, and nearby text. | Must | Planned |
| REQ-004 | The extension shows suggestions before filling any value. | Must | Planned |
| REQ-005 | The extension fills values only after explicit user action. | Must | Planned |
| REQ-006 | The extension never clicks submit, register, apply, purchase, agree, or final-confirmation controls automatically. | Must | Planned |
| REQ-007 | The extension can detect common manual-step signals and pause assistance for that step. | Should | Planned |
| REQ-008 | The user can re-scan the page after completing a manual step or after dynamic form changes. | Must | Planned |
| REQ-009 | The extension records local site-field history for the URL and profile field types used. | Should | Planned |
| REQ-010 | The options page supports profile fields, custom field definitions, settings, and site-field history management. | Must | Planned |

## 7. Non-Functional Requirements

These requirements describe qualities expected from v0.1. Numeric targets may
be refined after implementation benchmarks exist.

| ID | Category | Requirement | Target |
| --- | --- | --- | --- |
| PERF-001 | Performance | Form scanning should feel immediate on ordinary contact and registration forms. | Avoid noticeable UI delay on small to medium forms. |
| PERF-002 | Performance | Re-scanning should be scoped to page form state and should not require full page reloads when avoidable. | User can continue after dynamic updates. |
| AVAIL-001 | Availability | Core profile storage and suggestion behavior should work without network access. | No backend dependency for v0.1. |
| PRIV-001 | Privacy | Profile data must remain local by default. | No external profile upload in v0.1. |
| SEC-001 | Security | Passwords and credit card data must not be stored. | Unsupported field categories in v0.1. |
| SEC-002 | Security | The extension must not bypass CAPTCHA, MFA, bot detection, access controls, or consent mechanisms. | Pause and guide the user instead. |
| USE-001 | Usability | The user must be able to inspect suggestions before filling. | No hidden fill behavior. |
| MAINT-001 | Maintainability | Field classification and manual-step detection should be isolated and testable. | Avoid scattering DOM rules across UI code. |

## 8. Use Cases

### UC-001: Fill a Basic Contact Form

The user opens a contact form, reviews suggested values for name, email, phone,
company, and message-related fields, selects the fields to fill, and manually
submits the form after checking the result.

### UC-002: Fill a Form With Japanese Labels

The user opens a Japanese form containing labels such as `氏名`, `住所`, `会社名`,
and `部署`. The extension maps these to local profile fields where rules are
clear enough, then asks the user to confirm before filling.

### UC-003: Continue After a Manual Step

The user reaches a page with CAPTCHA, MFA, terms confirmation, or a final
confirmation step. The extension pauses assistance, prompts the user to complete
the step manually, then re-scans the page and resumes suggestions for any
remaining ordinary fields.

### UC-004: Manage Profile Data

The user opens the options page, adds or updates profile values, removes data
they no longer want to store, and optionally adds a custom field definition for
future form matching.

### UC-005: Review Site-Field History

The user reviews locally stored history showing which field types were used on a
URL, so future matching can become more useful without sending the history to a
server.

## 9. Field Detection Requirements

Field detection starts with rule-based matching. The classifier should inspect:

- `autocomplete`;
- `name`;
- `id`;
- `placeholder`;
- associated `label` text, including labels linked by `for`;
- labels that wrap controls;
- nearby visible text when it can be collected without brittle page-specific
  logic.

Initial examples:

- `autocomplete="email"` maps to email address.
- `autocomplete="tel"` maps to phone number.
- `name` or `id` containing `email` maps to email address.
- `name` or `id` containing `tel` or `phone` maps to phone number.
- `name` or `id` containing `zip` or `postal` maps to postal code.
- Japanese labels or placeholders containing `住所` map to address.
- Japanese labels or placeholders containing `会社名` map to company name.
- Japanese labels or placeholders containing `部署` map to department name.

The classifier should prefer useful suggestions over pretending to be certain.
Ambiguous fields should be shown as low-confidence suggestions or left for the
user to fill manually.

## 10. Manual-Step Detection Requirements

Manual-step detection should be conservative and UI-oriented. It may recognize:

- visible CAPTCHA text or common CAPTCHA containers;
- one-time password or MFA-like fields;
- consent, terms, policy, or agreement checkboxes;
- disabled submit buttons waiting for user action;
- final confirmation pages or controls;
- page transitions or dynamically rendered follow-up forms after user action.

Detection must not become adversarial. It must not solve, bypass, obscure, or
outsource CAPTCHA, MFA, bot detection, access controls, or consent mechanisms.
When uncertain, the extension should prefer prompting the user or doing nothing
over taking a risky action.

## 11. Dynamic Schema Direction

The long-term direction is to support custom fields and site-specific schema
learning. Different websites may ask for industry, department, invoice address,
contract owner, tax identifier, or other fields that are not part of the basic
profile.

v0.1 should leave room for that direction by keeping field definitions typed and
stored behind a small abstraction. It should not introduce a complex schema
engine, remote configuration service, or AI-based classifier before a simple
local model has proven useful.

## 12. Glossary

| Term | Definition |
| --- | --- |
| Profile field | A locally stored value such as name, email, phone number, address, company name, or department name. |
| Field detection | The process of finding form controls on the current page and collecting useful metadata about them. |
| Field classification | The process of mapping a detected form control to a likely profile field type. |
| Suggestion | A user-visible proposed value for a detected field. |
| Fill | Writing a selected profile value into a page field after explicit user action. |
| Manual step | A page state requiring human judgment or identity action, such as CAPTCHA, MFA, terms confirmation, or final submission. |
| Site-field history | Local history of which field types were used on a URL. |
