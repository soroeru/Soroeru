# Manual Test

This document owns the **browser-based manual test checklist** for `Catashiro`.

> **Direction change (2026-06-12).** The project pivoted to `Catashiro`, a local-first
> autonomous agent (see [`rfc/rfc-001-chrome-autofill-pivot.md`](rfc/rfc-001-chrome-autofill-pivot.md)).
> The previous MV3-extension checklist (build, load, options page, content-script
> scanning) described code that has since been removed (#68) and has been deleted from
> this document along with that code (history remains in git). The checklist below
> (registration, the review-and-confirm gate, the three guards, wall hand-off / resume,
> bulk update, and the encrypted store / local web UI) is the current manual checklist
> for `Catashiro`. The fake-data-only rule still applies.

Out of scope here: the overall test strategy and test-type matrix (see
[`testing.md`](testing.md)), and the canonical command list (see
[`development.md`](development.md)).

## 0. Mac Private Beta Acceptance Smoke

Run this checklist on an Apple Silicon Mac with macOS 14 Sonoma or macOS 15 Sequoia before
inviting or expanding the first private beta group.

- [ ] The app is distributed as a Mac desktop build or clearly identified development
      build; install instructions do not claim Windows, Linux, mobile, or browser
      extension support
- [ ] First-run onboarding creates an encrypted local vault in the documented default
      location or a user-selected local folder
- [ ] A beta user can complete onboarding, lock/unlock, and recovery-key setup without
      maintainer help
- [ ] A beta user can add or import at least one site and inspect the resulting per-site
      inventory without raw secret values appearing in screenshots, logs, or diagnostics
- [ ] The manual, landing/download page, and support instructions explain the local-only
      vault, no-telemetry policy, AI provider boundary, and CAPTCHA/MFA hand-off boundary
- [ ] Support bundles or diagnostics are local-only and contain no raw personal values
- [ ] Signing/notarization status is stated plainly if the beta build is not notarized

## 1. CAPTCHA / MFA / Verification Wall Handoff (SEC-002)

This section checks the `Catashiro` agent's wall detection and handoff/resume
behavior end to end against the local test sites (`npm run poc:serve`, then
`npm run poc -- demo` or `npm run poc -- register <siteId>`).

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

## 2. Registration Walkthrough And Review-And-Confirm Gate (TEST-001 / REQ-003..006, SAFE-001)

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

## 3. Three Guards (TEST-001 / REQ-007, SAFE-001)

**Guard 1 — high-risk clause escalation (`08-terms`)**

- [ ] `npm run poc -- register 08-terms`: the gate shows
      "⚠ 高リスク条項（自動承認を停止し、ユーザー判断を仰ぐ項目）" listing
      `auto-renewal` and `third-party-sharing`, each with the quoted clause
      text — these are surfaced, never auto-accepted

**Guard 3 — no auto-attestation (`08-terms`)**

- [ ] The gate asks separately, per attestation:
      "「私は18歳以上です」にチェックを入れますか？ [y/N]"
- [ ] Answering `N` registers without the `adult` checkbox checked (verify via
      "2. サイト一覧 / mandate" in `npm run poc -- ui:cli`, §4)

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

## 4. Bulk Update, Local App UI, And Encrypted Store (TEST-001 / REQ-001/002/010/011, SEC-001/003, UI-001)

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
- [ ] The `登録済みサイト` page always shows a `新規登録` form near the top; a
      `一括更新` action appears below it only when stale update candidates
      exist, otherwise "差分のあるサイトはありません" is shown
- [ ] Edit stored fields (e.g. phone number and address) together from the Web UI
- [ ] In edit mode, entering an invalid format (e.g. email without `@`, a
      postal code that is not 7 digits, a CVV that is not 3-4 digits) and
      saving shows a clear Japanese error naming the field and does not save
      any field; correcting the value and saving succeeds
- [ ] In edit mode, each field that already has a value shows a `この項目を削除`
      checkbox; checking it (including for a sensitive field such as
      `card.number`) and saving removes that field, and it no longer appears
      in the personal-data list
- [ ] In edit mode, a custom field's `この項目を削除` checkbox removes that custom
      field on save
- [ ] Revealing `card.cvv`（セキュリティコード） shows the value plus an extra
      warning not to copy it elsewhere; revealing other sensitive fields
      (e.g. `card.number`) does not show that extra warning
- [ ] After at least one registration (§2/§3), the Web UI registered-site list shows the
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
- [ ] Open the exported file under `state/catashiro-poc/` in a text editor and
      confirm it contains only encrypted JSON (`version` / `kdf` / `records`),
      no plaintext personal data
