# Manual Test

This document owns the **browser-based manual test checklist** for `autofill`.

> **Direction change (2026-06-12).** The project pivoted to `autofill`, a local-first
> autonomous agent (see [`rfc/rfc-001-chrome-autofill-pivot.md`](rfc/rfc-001-chrome-autofill-pivot.md)).
> The MV3-extension checklist below is historical. A new checklist (registration, the
> review-and-confirm gate, the three guards, wall hand-off / resume, encrypted store) is
> being written alongside the PoC implementation (#33). The fake-data-only rule still applies.

Out of scope here: the overall test strategy and test-type matrix (see
[`testing.md`](testing.md)), and the canonical command list (see
[`development.md`](development.md)).

## 0. Preparation

Use fake profile data only. Do not test with real personal, customer, contract,
or payment information.

Before manual checks:

- [ ] `npm run build` has been run and `dist/extension/` exists
- [ ] Chrome or Chromium is available
- [ ] The unpacked extension has been loaded from the documented build output
- [ ] Fake profile data is configured
- [ ] Fixture pages or safe test pages are available
- [ ] Local environment is clean
- [ ] Logs are enabled if needed
- [ ] No real accounts, credentials, passwords, or credit card data are used

Current build command:

```bash
npm run build
```

Load the unpacked extension from `dist/extension/`.

## 0.1 Options Page Profile Storage

- [ ] Open the extension options page
- [ ] Add fake profile data using the options page button
- [ ] Confirm the fake profile fields are listed
- [ ] Edit one fake profile field and confirm the update persists after reload
- [ ] Delete one profile field and confirm it is removed after reload
- [ ] Clear all profile fields and confirm the list is empty after reload
- [ ] Try to add a custom field with a credit-card-like label and confirm it is
      rejected
- [ ] Try to add a custom field with a password-like label and confirm it is
      rejected
- [ ] Confirm profile storage still works while the machine is offline

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

## 9. PoC: CAPTCHA / MFA / Verification Wall Handoff (SEC-002)

This section checks the `autofill` PoC's (`poc/autofill-agent/`) wall
detection and handoff/resume behavior end to end against the local test
sites (`npm run poc:serve`, then `npm run poc -- demo` or
`npm run poc -- register <siteId>`).

- [ ] When a CAPTCHA / OTP / email-verification wall fixture is reached, the
      agent pauses in the same headed browser session
- [ ] The handoff message asks the user to resolve the wall themselves and
      does not suggest any way to solve, automate, or bypass it
- [ ] The user resolves the wall directly in the browser (e.g. the fixture's
      "human confirms" control)
- [ ] After resolution, the agent re-observes the page and resumes
      automation from the resumed page (mapper / gate / fill / submit all run
      against the post-handoff page, not the pre-handoff one)
- [ ] If the wall is never resolved, the run ends as `manualHandoff` — the
      agent does not retry, solve, or proceed
- [ ] `npm run poc -- check-bypass` reports no CAPTCHA-solving / anti-bot /
      fingerprint-evasion dependency (docs/security.md §7)

## 10. Troubleshooting

| Symptom | Cause / Action |
| --- | --- |
| Extension does not appear in Chrome | Confirm the unpacked extension path and manifest are valid. |
| Scan finds no fields | Check whether the content script is loaded and whether the fixture fields are visible. |
| Suggestions are wrong | Inspect field metadata and classification rules for label, placeholder, `name`, `id`, and `autocomplete` signals. |
| Values are filled without selection | Treat as a blocking safety bug. Filling must require explicit user action. |
| Terms or submit controls are touched automatically | Treat as a blocking safety bug. These controls must stay manual. |
| Re-scan misses dynamic fields | Check whether the page update happened before the scan and whether the scanner reads the current DOM. |
| UI overlaps important page controls | Adjust injected UI placement, sizing, or dismissal behavior. |

## 11. PoC: Registration Walkthrough And Review-And-Confirm Gate (TEST-001 / REQ-003..006, SAFE-001)

`npm run poc -- register <siteId> [deterministic|ai]` runs a single site headed
with the interactive CLI gate (`CliGate` / `renderGate`).

- [ ] `npm run poc -- register 01-basic` opens a headed browser, finds the
      registration page, and fills the form from the seeded dummy profile
- [ ] Before anything is submitted, the CLI prints the review-and-confirm
      gate: service name and origin, every field to be submitted with its
      profile key and value (sensitive fields masked), and any terms links
- [ ] Answering `N` at "この内容で登録しますか？" aborts without submitting
      (status `declined`; nothing is registered on the server)
- [ ] Answering `y` submits and the CLI prints `status: registered`
- [ ] `npm run poc -- register 05-choices` prompts for the field not in the
      seeded store ("ご職業") with `未保存の項目「ご職業」の値を入力してください:`
- [ ] Re-running a site that needs "ご職業" does not prompt again — the
      entered value was saved for reuse (REQ-005)

## 12. PoC: Three Guards (TEST-001 / REQ-007, SAFE-001)

**Guard 1 — high-risk clause escalation (`08-terms`)**

- [ ] `npm run poc -- register 08-terms`: the gate shows
      "⚠ 高リスク条項（自動承認を停止し、ユーザー判断を仰ぐ項目）" listing
      `auto-renewal` and `third-party-sharing`, each with the quoted clause
      text — these are surfaced, never auto-accepted

**Guard 3 — no auto-attestation (`08-terms`)**

- [ ] The gate asks separately, per attestation:
      "「私は18歳以上です」にチェックを入れますか？ [y/N]"
- [ ] Answering `N` registers without the `adult` checkbox checked (verify via
      "2. サイト一覧 / mandate" in `npm run poc -- ui:cli`, §13)

**Guard 2 — payment stop with trial→subscription exception (`09-trial-card`)**

- [ ] `npm run poc -- register 09-trial-card`: the gate shows
      "支払い項目の判定: ..." (trial-subscription) and explains the card is
      filled only on approval
- [ ] Answering `N` to the card-approval prompt: card fields (number / expiry
      / holder / CVV) are not filled and the run ends as `declined`
- [ ] Re-run and answer `y` to the card-approval prompt: card fields are
      filled and registration completes

**Auto-creation-prohibited site (`10-no-auto`, REQ-008)**

- [ ] `npm run poc -- register 10-no-auto`: the gate shows
      "※ このサイトは自動アカウント作成を禁止しています。入力のみ行い、最後の登録ボタンはご自身で押してください。"
- [ ] The agent fills the ordinary fields but does not check the consent
      checkbox or click the final submit button
- [ ] The user checks the consent box and clicks the final button themselves
      in the headed browser; the result status is `assistedFill`, not
      `registered`

## 13. PoC: Bulk Update, Local App UI, And Encrypted Store (TEST-001 / REQ-001/002/010/011, SEC-001/003, UI-001)

- `npm run poc -- ui [deterministic|ai] [port]` starts the local browser UI.
- `npm run poc -- ui:cli [deterministic|ai]` starts the legacy terminal UI fallback.

- [ ] Web UI binds to `127.0.0.1`; opening the printed URL shows the onboarding
      / unlock screen
- [ ] Unlocking with a wrong master passphrase fails closed (no data shown)
- [ ] Web UI personal-data list masks values per `maskValue` (card number →
      last 4 digits; CVV / card expiry / holder / password → `••••••`; email /
      phone → partial mask); revealing a sensitive field requires re-entering
      the master passphrase
- [ ] The primary navigation has three tabs: `個人情報`, `登録済みサイト`, and `設定`
- [ ] The personal-data page has a visible top-right `編集` button; edit mode
      shows all profile fields in one form and has a single `保存` button at the
      bottom
- [ ] The `登録済みサイト` page places `新規登録` in the upper-left action area
      and `一括更新` in the upper-right action area
- [ ] Edit stored fields (e.g. phone number and address) together from the Web UI
- [ ] After at least one registration (§11/§12), the Web UI registered-site list shows the
      site's status, filled-field count, mandate count, and stale-field warning
- [ ] Web UI settings can save provider/model/API key; API key display requires
      re-entering the master passphrase
- [ ] Web UI settings can generate a recovery key (shown once), then lock and
      unlock using the recovery key instead of the passphrase
- [ ] Legacy `ui:cli` still supports registration and bulk update until the Web
      UI run pages are wired: "3. 一括更新" lists stale sites, runs the gate +
      three guards + wall handoff per site, and writes a new mandate per updated
      site
- [ ] Legacy `ui:cli` still supports encrypted export, then import into a fresh
      store path and confirm the same data is available after unlocking with
      the same passphrase
- [ ] Open the exported file under `state/autofill-poc/` in a text editor and
      confirm it contains only encrypted JSON (`version` / `kdf` / `records`),
      no plaintext personal data
