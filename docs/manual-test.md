# Manual Test

This document owns browser-based manual checklists.

Use it for checks that cannot be fully automated or that need human judgment.
Test strategy and commands belong in [`testing.md`](testing.md).

## 0. Preparation

Write the local setup, fake profile data, extension loading steps, and fixture
selection needed before manual checks.

- [ ] Required accounts / credentials are available
- [ ] Test data is safe to modify
- [ ] Local environment is clean
- [ ] Logs are enabled if needed

## 1. Smoke Test

Write the shortest check that confirms the extension loads and detects a simple
form.

## 2. English Form Fixture

Write checks for common English labels, `name`, `id`, `placeholder`, and
`autocomplete` attributes.

## 3. Japanese Form Fixture

Write checks for Japanese labels and placeholders such as address, company, and
department fields.

## 4. Dynamic Form Fixture

Write checks for re-scanning after user-driven page changes or dynamically
rendered fields.

## 5. Manual-Step Fixture

Write checks for CAPTCHA-like, MFA-like, terms, consent, final-confirmation, or
other human-step states.

## 6. Select And Textarea Fields

Write checks for non-`input` fields that should still be detected.

## 7. Error And Recovery

Write checks for failed detection, user correction, page updates, and retry
behavior.

## 8. Release Readiness

Write the final manual checklist before a release or packaged extension build.

- [ ] Requirements reviewed
- [ ] Automated tests passed
- [ ] Manual tests completed
- [ ] Rollback or recovery path documented

## 9. Troubleshooting

Write symptoms and likely actions found during manual checks.

| Symptom | Cause / Action |
| --- | --- |
|  |  |
