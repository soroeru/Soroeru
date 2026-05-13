# Testing

This document owns the testing strategy for `formfill-assistant`.

Manual browser checklists belong in [`manual-test.md`](manual-test.md).

## 1. Test Strategy

Write the balance of unit, integration, end-to-end, and manual testing.

## 2. Test Types

| Type | Purpose | Target |
| --- | --- | --- |
| Unit |  |  |
| Integration |  |  |
| E2E |  |  |
| Manual |  |  |

## 3. Test Environment

Write the test runner, browser requirements, extension loading approach, and
local-only constraints.

Frameworks:

-

Directory structure:

```text
tests/
```

## 4. Test Data And Fixtures

Write fixture and fake-data rules.

HTML fixtures for automated and manual form tests should live under
`tests/fixtures/` unless a later issue chooses a different location.

## 5. Commands

Write the commands for all tests, focused tests, type-aware tests, and future
E2E tests once they exist.

```bash
# Run all tests

# Run one test

# Run e2e tests
```

## 6. Manual Testing

Link to [`manual-test.md`](manual-test.md) and describe when manual checks are
required.

## 7. CI

Write which checks run in CI and which checks remain local or manual.
