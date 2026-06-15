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

### 0.1 Release Candidate And Artifact Steps

Use this sequence for each private beta build. The build may be distributed as a GitHub
Release, direct file share, or landing-page download link, but the exact channel must be
recorded in the beta release notes before users receive it.

- [ ] Start from an up-to-date `main` branch with no local source, doc, generated, or
      state-file changes (`git status -sb`)
- [ ] Create a short-lived release branch named
      `codex/beta-YYYY-MM-DD-<short-slug>` or `release/beta-YYYY-MM-DD-<short-slug>`
- [ ] Review the merged PR list since the previous beta and write the user-visible
      release-note bullets, including fixed issues, new limitations, and upgrade notes
- [ ] Run the required local checks in §0.2 and confirm the GitHub checks for the
      release branch or release PR are green
- [ ] Build the Mac artifact with `npm run package:mac`
- [ ] Confirm `release/Catashiro.app` and `release/Catashiro-mac-beta.zip` were created
      and that `release/` remains untracked / ignored by Git
- [ ] Launch the generated `.app`, complete the install / first-run checks in §0.3, then
      close the app and confirm no Playwright browser sessions remain open
- [ ] Tag the tested commit as `beta-YYYY-MM-DD` or record the tested commit SHA in the
      release notes if a tag is not being used yet
- [ ] State signing / notarization status plainly in the release notes; for the current
      unsigned beta, include the expected macOS Gatekeeper friction and how the user can
      remove the app

### 0.2 Required Local And GitHub Checks

Run these checks before a beta build is shared. Use fake data only, and do not attach
vault files, screenshots with secrets, support bundles, or `state/` output to public
issues or PRs.

- [ ] `npm ci`
- [ ] `npx playwright install chromium`
- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run poc -- check-egress`
- [ ] `npm run poc -- check-persistence`
- [ ] `npm run poc -- check-bypass`
- [ ] `npm run release:check` passes, or the above equivalent commands are recorded
      individually with the same commit SHA
- [ ] `npm run poc:matrix -- deterministic chromium`
- [ ] `npm run package:mac`
- [ ] GitHub `ci / unit`, `ci / e2e-deterministic`, and `shellcheck` are green on the
      release PR / branch
- [ ] If AI Provider mode changed, run one local AI-mode smoke with a user-owned test key
      and record only pass/fail plus provider/model name, never prompts, keys, or raw
      values

### 0.3 Install, First Run, Recovery, And Uninstall

Run these checks against the packaged `.app`, not only `npm run poc -- ui`.

- [ ] Install by unzipping `Catashiro-mac-beta.zip` and moving `Catashiro.app` to the
      beta install location documented for users
- [ ] If the build is unsigned, macOS presents the expected warning and the beta notes
      already explain it
- [ ] First launch opens the local web UI at `127.0.0.1` and does not require a hosted
      account, cloud vault, telemetry opt-in, or browser extension install
- [ ] Onboarding creates an encrypted local vault under
      `~/Library/Application Support/Catashiro` by default, or under the documented
      `CATASHIRO_STATE_ROOT` override when set
- [ ] Lock / unlock works with the master passphrase
- [ ] Recovery-key generation shows the key once, then recovery-key unlock works after
      locking or restarting the app
- [ ] A fresh install with an existing fake-data vault can be unlocked from the documented
      local vault location, or the limitation is listed in §0.6 release notes
- [ ] Uninstall instructions remove the `.app` and explain that the local vault remains
      unless the user explicitly deletes the application-support folder
- [ ] Removing only the `.app` does not delete the local vault; deleting the vault folder
      makes the next launch behave as a fresh first run

### 0.4 Core Beta Manual QA Scenarios

Run the detailed checklists below for the affected areas, then confirm this short beta
scenario set before sharing a build with the first 10 users.

- [ ] Add Site: choose "まだ持っていない" and complete `01-basic` registration through
      the review-and-confirm gate
- [ ] Add Site: choose "すでに持っている" on an existing-account profile page and import
      approved fake profile values into the encrypted vault
- [ ] Add Site: choose "わからない" and confirm no site record is created until the user
      chooses a branch
- [ ] Registration gate: decline once and confirm nothing is submitted; approve once and
      confirm the site inventory updates
- [ ] Three guards: run `08-terms`, `09-trial-card`, and `10-no-auto` and confirm
      high-risk clauses, card approval, no auto-attestation, and fill-only behavior
- [ ] Wall hand-off: run CAPTCHA-like, OTP-like, email-verification, and ambiguous
      security-check fixtures; the user resolves the wall in the same headed browser
      session, then the agent re-observes and resumes
- [ ] Bulk update: change fake phone/address values, run the current bulk-update path,
      and confirm only stale fields are proposed and a new mandate is recorded
- [ ] Support bundle / diagnostics: generate or inspect the current diagnostic output, if
      available, and confirm it contains no raw personal values, API keys, vault bytes,
      cookies, screenshots with secrets, or Playwright traces from real sites
- [ ] Security release evidence records only high-level pass/fail, commit SHA, and changed
      risk areas; it does not include prompts, raw values, API keys, vault bytes, or
      real-site screenshots

### 0.5 Beta Release Notes Template

Each beta build should include a short note with:

- tested commit SHA or tag
- artifact name and distribution channel
- supported platform: Apple Silicon Mac, macOS 14 Sonoma / macOS 15 Sequoia
- signing / notarization status
- setup prerequisites, including Node.js 22+ if the build does not bundle Node
- what changed since the previous beta
- required fake-data test coverage and checks that passed
- known limitations from §0.6
- support instructions and what users must not send (vault files, real personal data,
  API keys, screenshots containing secrets)

### 0.6 Known Limitations To Review Before Each Beta

Copy the current limitations into the beta release notes and remove only when the
implementation and checks prove otherwise.

- [ ] Mac-only beta; Windows, Linux, mobile apps, Android Autofill Service, iOS app, and
      browser-extension distribution are unsupported
- [ ] Build is unsigned / not notarized unless a signing issue has explicitly changed
      this
- [ ] Node.js 22+ is required unless the artifact bundles a Node runtime
- [ ] No auto-update channel; users install each beta manually
- [ ] No hosted vault, backend sync, telemetry, analytics, or crash reporting
- [ ] The encrypted vault is local by default; cloud-storage sync is unsupported unless a
      later encrypted-sync issue defines it
- [ ] CAPTCHA, MFA, identity verification, email/SMS verification, bot detection, rate
      limits, paywalls, and access controls are hand-off points and are never bypassed
- [ ] Checkout / purchase flows are unsupported; free-trial-to-paid-subscription card
      fill requires explicit approval
- [ ] PoC form detection remains Japanese-only
- [ ] AI Provider mode is optional, uses the user's configured key, and receives form
      structure / terms text only, never raw personal values

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
- [ ] On first run (no vault file yet), the screen shows a vault-setup form with
      a passphrase and a confirmation field, the local vault file path, and
      guidance that losing both the passphrase and the recovery key means the
      data cannot be recovered
- [ ] Entering passphrases shorter than 8 characters, or two passphrases that
      do not match, shows a clear Japanese error and does not create the vault
      file
- [ ] Submitting matching passphrases of at least 8 characters creates the
      encrypted vault file at the shown path, unlocks it, and redirects to
      `設定` with guidance to set up a recovery key next
- [ ] After locking or restarting once a vault exists, the screen instead shows
      the passphrase-unlock and recovery-key-unlock forms (not the setup form)
- [ ] Unlocking with a wrong master passphrase fails closed (no data shown)
- [ ] Until a recovery key is generated, the dashboard shows a reminder banner
      linking to `設定`; generating a recovery key removes the reminder
- [ ] When idle auto-lock is enabled, the dashboard states how many minutes of
      inactivity trigger an automatic lock
- [ ] Web UI personal-data list masks values per `maskValue` (card number →
      last 4 digits; CVV / card expiry / holder / password → `••••••`; email /
      phone → partial mask); revealing a sensitive field requires re-entering
      the master passphrase
- [ ] The primary navigation has three tabs: `個人情報`, `登録済みサイト`, and `設定`
- [ ] The personal-data page has a visible top-right `編集` button; edit mode
      shows all profile fields in one form and has a single `保存` button at the
      bottom
- [ ] The `登録済みサイト` page always shows a `サイトを追加` guided action near the
      top with choices for new registration, existing-account import, and uncertain
      account status; a `一括更新` action appears below it only when stale update
      candidates exist, otherwise "差分のあるサイトはありません" is shown
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
- [ ] After at least one registration (§2/§3 or below), the Web UI registered-site list
      shows the site's status, filled-field count, mandate count, and stale-field warning
- [ ] Web UI settings can save provider/model/API key; API key display requires
      re-entering the master passphrase
- [ ] Web UI settings can generate a recovery key (shown once), then lock and
      unlock using the recovery key instead of the passphrase
- [ ] Web UI `一括更新` shows stale site/field checkboxes, requires at least one
      selected field, runs selected sites independently through the review gate,
      surfaces per-site success/failure/wall states, and writes a new mandate per
      updated site
- [ ] Legacy `ui:cli` still supports bulk update as a developer fallback:
      "3. 一括更新" lists stale sites, runs the gate + three guards + wall handoff
      per site, and writes a new mandate per updated site

### 4a. Web UI New-Registration Run (#81)

With the local test sites running (`npm run poc:serve`) and the Web UI open
(`npm run poc -- ui`):

- [ ] On `登録済みサイト`, entering a site URL (e.g. the `01-basic` test site)
      under `サイトを追加`, choosing "まだ持っていない", and submitting opens a
      headed browser and shows a progress state that auto-refreshes every few
      seconds
- [ ] Choosing "すでに持っている" imports the URL as an existing-account site record
      with `accountState=imported`; choosing "わからない" asks the user to choose
      before continuing and does not create a record
- [ ] For an existing-account profile/settings page, the import core extracts only
      local form values after the user has reached the page, shows masked candidates
      for review, saves only approved/edited values into the encrypted vault, and
      records imported-field hashes in the site inventory. CAPTCHA/MFA/login walls
      must be resolved by the user in the headed browser session.
- [ ] For `05-choices`, the run pauses with an "追加情報の入力" prompt for
      「ご職業」; submitting a value resumes the run and the value is saved for
      reuse (REQ-005)
- [ ] The run pauses at "確認ゲート" showing, in plain language: an intro line
      with the service name and origin, a "送信する項目" list of every field to
      be submitted with masked values, and a "規約・ポリシー" list of clickable
      terms/policy links (#82)
- [ ] Declining the gate ends the run as "ユーザーの判断で中止しました" without
      submitting anything
- [ ] Approving the gate for `01-basic` ends the run as "登録が完了しました" and
      adds/updates the site's entry in `登録済みサイト`
- [ ] For `08-terms`, the gate shows a "⚠ 自動承認を停止した項目" section listing
      the auto-renewal and third-party-sharing clauses with quoted evidence
      (guard 1), and a "ご自身でご確認のうえチェックしてください" section with the
      `adult`/「私は18歳以上です」checkbox left unchecked by default (guard 3)
- [ ] For `09-trial-card`, the gate's "お支払いについて" section explains the
      trial→subscription conversion and shows the `cardApproved` checkbox
      ("無料トライアル終了後の課金を承認"); approving the gate without checking it
      ends the run as "ユーザーの判断で中止しました" and no card data is filled
      (guard 2)
- [ ] For `10-no-auto`, the gate's "自動アカウント作成について" section explains the
      site prohibits automated account creation; approving fills the form but
      ends the run as "入力のみ完了しました" (`assistedFill`), not `registered`
- [ ] Dismissing a finished run (`閉じる`) closes the browser/page and restores
      the `サイトを追加` form
- [ ] Starting a second registration while one is in progress shows
      "別の登録処理が進行中です" and does not start a second browser session
- [ ] Legacy `ui:cli` still supports encrypted export, then import into a fresh
      store path and confirm the same data is available after unlocking with
      the same passphrase
- [ ] Open the exported file under `state/catashiro-poc/` in a text editor and
      confirm it contains only encrypted JSON (`version` / `kdf` / `records`),
      no plaintext personal data
