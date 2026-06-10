# Testing

This document owns the **testing strategy** for `formfill-assistant`: what to
test, which test types apply, and where fixtures live.

Out of scope here: the browser-based manual checklist itself (see
[`manual-test.md`](manual-test.md)) and the canonical command list (see
[`development.md`](development.md)).

## 1. Test Strategy

Testing should focus on the parts that carry product and safety risk:

- deterministic field classification;
- DOM scanning across common form shapes;
- manual-step detection boundaries;
- storage behavior for local profile data and site-field history;
- message passing between extension components;
- browser behavior for suggestion UI and user-confirmed filling.

Use automated tests for deterministic logic and fixture-based DOM behavior.
Use manual browser checks for extension loading, injected UI, and workflows that
require human judgment.

## 2. Test Types

| Type | Purpose | Target |
| --- | --- | --- |
| Unit | Verify pure rules and small modules. | Field classification, normalization, manual-step heuristics, storage helpers. |
| Integration | Verify modules together against controlled inputs. | DOM scanning with HTML fixtures, message payload handling, storage abstraction behavior. |
| E2E | Verify the extension in a real browser once tooling exists. | Loading the extension, scanning fixture pages, showing suggestions, selected filling, re-scanning. |
| Manual | Verify user experience and safety boundaries. | Human-in-the-loop behavior, UI placement, real Chrome extension loading, release readiness. |

## 3. Test Environment

The current automated test runner is Node's built-in test runner after
TypeScript compilation.

Frameworks:

- Unit / integration: Node built-in test runner.
- DOM scanning unit tests use `jsdom` to construct a `Document` from HTML
  fixtures, since the content script's `scanFields` accepts a `Document`
  argument for testability.
- E2E: Playwright is the current candidate for future browser tests.
- Manual: Chrome or Chromium with an unpacked local extension.

Directory structure:

```text
tests/
├── fixtures/
├── unit/
├── integration/
└── e2e/
```

The directory structure is expected but not created yet. Update this document
when real tests are added.

## 4. Test Data And Fixtures

HTML fixtures for automated and manual form tests should live under
`tests/fixtures/` unless a later issue chooses a different location.

Fixture rules:

- Use fake names, emails, phone numbers, addresses, company names, and
  department names.
- Do not commit real personal data, real customer data, screenshots containing
  private data, or copied production forms with sensitive content.
- Include both English and Japanese forms.
- Include forms with labels linked by `for`, labels wrapping inputs, missing
  labels, placeholders, and `autocomplete` attributes.
- Include `textarea` and `select` examples.
- Include dynamic form examples that add fields after user action.
- Include CAPTCHA-like, MFA-like, terms, consent, and final-confirmation
  placeholders for safety testing. These fixtures must not use real CAPTCHA or
  MFA services.

## 5. Commands

Test commands belong with the rest of the quality gates in
[`development.md`](development.md).

Current automated test command:

```bash
npm test
```

`npm test` builds the extension and runs unit tests from `tests/unit/`.

## 6. Manual Testing

Use [`manual-test.md`](manual-test.md) for browser-based checklists.

Manual checks are required when a change affects:

- extension loading;
- content script DOM interaction;
- injected UI;
- selected filling behavior;
- manual-step prompts;
- permissions;
- storage behavior that users can observe.

## 7. CI

No CI quality gate for the extension exists yet. When automated checks are
added, CI should run the non-interactive gates that are stable in a clean
environment, such as lint, typecheck, unit tests, integration tests, and build.

Manual browser checks and local AI review remain local unless a later issue
explicitly adds GitHub Actions fallback automation.
