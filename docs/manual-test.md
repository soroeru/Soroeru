# Manual Test

This document owns browser-based manual checklists.

Use it for checks that cannot be fully automated or that need human judgment.
Test strategy and commands belong in [`testing.md`](testing.md).

## 0. Preparation

Use fake profile data only. Do not test with real personal, customer, contract,
or payment information.

If the repository still has no extension build, record that in the manual-test
notes and skip browser workflow checks until an unpacked extension can be
loaded.

Before manual checks:

- [ ] The extension build command exists and has completed
- [ ] Chrome or Chromium is available
- [ ] The unpacked extension has been loaded from the documented build output
- [ ] Fake profile data is configured
- [ ] Fixture pages or safe test pages are available
- [ ] Local environment is clean
- [ ] Logs are enabled if needed
- [ ] No real accounts, credentials, passwords, or credit card data are used

## 1. Smoke Test

- [ ] Open a simple fixture containing name and email fields
- [ ] Confirm the extension loads without console errors that block use
- [ ] Trigger scanning from the extension UI
- [ ] Confirm the fields are detected
- [ ] Confirm suggestions are shown before any values are written
- [ ] Select one suggestion and confirm only that selected field is filled
- [ ] Confirm the form is not submitted automatically

## 2. English Form Fixture

- [ ] `autocomplete="email"` is suggested as email
- [ ] `autocomplete="tel"` is suggested as phone number
- [ ] `name` or `id` containing `email` is suggested as email
- [ ] `name` or `id` containing `phone` or `tel` is suggested as phone number
- [ ] `name` or `id` containing `zip` or `postal` is suggested as postal code
- [ ] Placeholder text is considered when labels are absent
- [ ] Labels linked by `for` are considered
- [ ] Labels wrapping inputs are considered
- [ ] Ambiguous fields are not filled without user selection

## 3. Japanese Form Fixture

- [ ] `氏名` or equivalent name labels are suggested as full name
- [ ] `メール` or equivalent email labels are suggested as email
- [ ] `電話` labels are suggested as phone number
- [ ] `郵便番号` labels are suggested as postal code
- [ ] `住所` labels or placeholders are suggested as address
- [ ] `会社名` labels are suggested as company name
- [ ] `部署` labels are suggested as department name
- [ ] Suggestions remain visible for user confirmation before filling

## 4. Dynamic Form Fixture

- [ ] Open a fixture where fields appear after a user action
- [ ] Confirm the initial scan reports only currently available fields
- [ ] Perform the user action that reveals additional fields
- [ ] Re-scan the page
- [ ] Confirm newly rendered fields are detected
- [ ] Confirm previously filled fields are not overwritten without another user
      action
- [ ] Confirm the page does not need a full reload when re-scanning is enough

## 5. Manual-Step Fixture

- [ ] CAPTCHA-like placeholder is detected as requiring user action
- [ ] MFA / one-time-code-like field is detected as requiring user action
- [ ] Terms or consent checkbox is not checked automatically
- [ ] Final confirmation or submit-like control is not clicked automatically
- [ ] The UI tells the user that manual action is required
- [ ] The user can complete the manual step directly on the page
- [ ] After the user continues, re-scan resumes suggestions for remaining
      ordinary fields
- [ ] The extension does not hide, obscure, solve, or bypass the manual step

## 6. Select And Textarea Fields

- [ ] `textarea` fields are detected
- [ ] Address or message-like textareas are classified only when there is a
      clear label or attribute signal
- [ ] `select` fields are detected
- [ ] Select suggestions are shown only when a matching option exists or when a
      safe user-confirmed mapping is available
- [ ] The extension does not force invalid values into selects

## 7. Error And Recovery

- [ ] User can ignore or dismiss an incorrect suggestion
- [ ] User can manually edit a filled value after filling
- [ ] Re-scanning does not erase manual edits without user action
- [ ] Missing profile values are handled with a clear empty or unavailable state
- [ ] Extension UI can recover after page DOM changes
- [ ] Console errors, if present, are recorded for follow-up

## 8. Release Readiness

- [ ] Requirements reviewed
- [ ] Automated tests passed
- [ ] Manual tests completed
- [ ] Extension permissions reviewed
- [ ] Security-sensitive behavior reviewed
- [ ] No real personal data appears in fixtures, screenshots, tests, or docs
- [ ] No local state, logs, or AI review artifacts are staged for commit
- [ ] Rollback or recovery path documented

## 9. Troubleshooting

| Symptom | Cause / Action |
| --- | --- |
| Extension does not appear in Chrome | Confirm the unpacked extension path and manifest are valid. |
| Scan finds no fields | Check whether the content script is loaded and whether the fixture fields are visible. |
| Suggestions are wrong | Inspect field metadata and classification rules for label, placeholder, `name`, `id`, and `autocomplete` signals. |
| Values are filled without selection | Treat as a blocking safety bug. Filling must require explicit user action. |
| Terms or submit controls are touched automatically | Treat as a blocking safety bug. These controls must stay manual. |
| Re-scan misses dynamic fields | Check whether the page update happened before the scan and whether the scanner reads the current DOM. |
| UI overlaps important page controls | Adjust injected UI placement, sizing, or dismissal behavior. |
