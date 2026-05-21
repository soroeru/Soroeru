# Security

This document owns **security and privacy decisions**: principles, threat
model, sensitive data handling, permission review rules, network policy, human
step safety boundaries, DOM input safety, and dependency policy.

Out of scope here: extension permission usage and runtime layout (see
[`extension.md`](extension.md)) and product-level non-functional requirement
statements (see [`requirements.md`](requirements.md) §7).

## 1. Security Principles

- Keep profile data local in v0.1.
- Do not send profile data, site-field history, or page-derived form data to
  external services.
- Do not store passwords or credit card data.
- Do not submit forms, accept terms, or complete final confirmation steps
  automatically.
- Do not bypass CAPTCHA, MFA, bot detection, access controls, rate limits, or
  paywalls.
- Keep extension permissions as narrow as practical.
- Treat page text and attributes as untrusted input.
- Use fake data in tests, fixtures, docs, screenshots, and examples.
- Do not commit secrets, local state, AI review artifacts, or generated caches.

## 2. Threat Model

| Threat | Impact | Mitigation |
| --- | --- | --- |
| Over-broad extension permissions | More pages or data become reachable than intended. | Prefer `activeTab` or narrow host access; document any broad permission before adding it. |
| Profile data leaked to a network service | Personal or business data leaves the user's machine. | No backend, telemetry, cloud sync, or external profile upload in v0.1. |
| Password or credit card storage | High-impact secrets are stored in a tool not designed for them. | Do not support password or credit card field categories in v0.1. |
| Automatic form submission | User may register, apply, purchase, agree, or submit incorrect data without consent. | Never click submit or final confirmation controls automatically. |
| Terms or consent auto-acceptance | User may appear to consent without judgment. | Treat terms and consent controls as manual steps. |
| CAPTCHA / MFA bypass behavior | Circumvents site protections and may violate user or site expectations. | Detect and pause; never solve, bypass, hide, or outsource. |
| Host page interference from injected UI | Page controls may be obscured or altered. | Scope styles, avoid large overlays, and manually test fixtures. |
| DOM-based injection or unsafe rendering | Page-provided text could affect extension UI. | Treat page text as untrusted; render as text, not HTML, unless explicitly sanitized. |
| Real data committed in fixtures or logs | Sensitive data becomes part of repository history. | Use fake data only and keep local state ignored by Git. |

## 3. Sensitive Data Handling

Allowed in v0.1 local storage:

- name;
- email address;
- phone number;
- postal code;
- address;
- company name;
- department name;
- user-defined non-secret fields;
- local site-field history.

Not allowed in v0.1 storage:

- passwords;
- one-time passwords;
- credit card numbers, expiration dates, or security codes;
- government IDs or identity verification secrets unless a future issue
  explicitly scopes and reviews them;
- real test data, real customer data, or copied production records.

Tests, fixtures, documentation, and screenshots must use fake values.

## 4. Local Storage And Encryption Direction

Use local browser storage only for v0.1. `chrome.storage.local` or IndexedDB are
acceptable candidates once implementation begins. Storage access should go
through a small abstraction so future migration, validation, or encryption can
be added without changing content scripts and UI code directly.

The current profile storage reader ignores invalid stored rows and logs a
warning instead of failing the whole options page. This keeps valid local
profile fields accessible if a future validation rule rejects an old password,
one-time-code, or credit-card-like row.

Encryption is a future direction, not a current guarantee. If Web Crypto API
encryption is added later, document:

- what is encrypted;
- where keys come from;
- what remains visible to the browser extension runtime;
- how backup, migration, and recovery work;
- what risks encryption does and does not solve.

## 5. Extension Permissions Review

The extension manifest lives at `src/manifest.json`.

Current permissions:

| Permission | Reason | Security Notes |
| --- | --- | --- |
| `storage` | Store user-managed profile fields locally through the storage abstraction. | Profile data remains in browser-local extension storage. Do not add sync, telemetry, or external upload without a new scoped issue and security review. |

Permission review rules:

- Prefer the smallest permission set that supports the user-visible workflow.
- Prefer user-initiated access such as `activeTab` when it is sufficient.
- Avoid broad host permissions unless the implementation requires them and the
  reason is documented.
- Avoid permissions unrelated to local form assistance.
- Treat new permissions as security-sensitive changes requiring manual review.
- Explain why each permission is needed, which component uses it, and what user
  data it can expose.

## 6. Network And External Services

v0.1 has no backend dependency. The extension must not send profile data,
site-field history, or page-derived form contents to external services.

Do not add telemetry, analytics, crash reporting, cloud sync, LLM services, or
remote classification without an explicit issue that updates requirements,
security notes, and user-facing documentation.

## 7. Human-Step Safety Boundaries

The extension may detect that a human step is present and may guide the user. It
must not complete the step.

Do not implement:

- CAPTCHA solving, bypass, hiding, outsourcing, or token reuse;
- MFA or one-time-code bypass;
- bot-detection or rate-limit bypass;
- paywall or access-control bypass;
- automatic terms, policy, contract, or consent acceptance;
- automatic final submission, registration, application, purchase, or
  confirmation.

When the page requires one of these actions, the extension should pause and let
the user act directly.

## 8. Input And DOM Safety

Page DOM is untrusted input. Field labels, placeholders, nearby text, option
labels, URLs, and attributes may be malformed, misleading, or adversarial.

Implementation expectations:

- render page-derived text as text, not raw HTML;
- avoid evaluating page-provided strings as code or selectors without
  validation;
- keep injected UI isolated from host page styles where practical;
- avoid global CSS resets or broad selectors;
- avoid storing unnecessary page text in site-field history;
- validate storage data before use;
- preserve user ability to review and edit filled values.

## 9. Dependency And Supply Chain

Current JavaScript / TypeScript dependencies are limited to development tools:

- `typescript` for compilation and type checking;
- `@types/node` for Node unit test typings.

When dependencies are introduced:

- add only dependencies with a clear purpose;
- commit the lockfile for the chosen package manager;
- prefer small, actively maintained packages;
- avoid dependencies that phone home or process profile data remotely;
- run the documented audit or update check when the toolchain supports it;
- document any build tool or framework decision in [`development.md`](development.md).

## 10. Security Checklist

- [ ] Secrets are not committed
- [ ] Local state and logs are ignored by Git
- [ ] Fixtures, screenshots, tests, and docs use fake data only
- [ ] No passwords or credit card data are stored; profile validation rejects
      unsupported password, one-time-code, and credit-card-like categories
- [ ] No profile data is sent to external services
- [ ] Extension permissions are minimal and documented
- [ ] Page-derived text is treated as untrusted input
- [ ] Filling requires explicit user selection
- [ ] Submit, register, apply, purchase, agree, and final confirmation controls
      are not clicked automatically
- [ ] CAPTCHA, MFA, bot-detection, access-control, and consent mechanisms are
      not bypassed
- [ ] Security-sensitive behavior is tested or manually verified
