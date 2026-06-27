# Manual Test — Soroeru Slice A (Visibility / 開示台帳)

This is the **product-owner acceptance checklist** for **Soroeru Slice A — Visibility**
(Epic #156). It covers the unsigned macOS DMG, the encrypted vault, CSV import, the
Visibility collection run (auto-login → 開示台帳), the cross-cutting filters and initial
Reflection, the CAPTCHA/MFA wall hand-off, and the app-quit lifecycle.

> **Fake data only.** Use throwaway test accounts and fake personal values. Do **not** use
> real credentials, real cards, or real personal information anywhere in this checklist, and
> never attach vault files, `state/` output, or screenshots containing secrets to issues/PRs.

Slice scope (RFC-002 §5; [`requirements.md`](requirements.md)): **A Visibility only.** Bulk
update (B), withdrawal (C), and new-registration gate (D) are later slices and are out of
scope here. The canonical command list is [`development.md`](development.md); the test-type
matrix is [`testing.md`](testing.md).

There are two ways to exercise this checklist:

- **Packaged DMG** (Parts 1, 2, 7): the real artifact a beta user installs.
- **Dev mode against the local test sites** (Parts 3–6): the safe, fake-data way to exercise
  auto-login/collection without touching any real website. Start the bundled fake sites with
  `npm run poc:serve` and run the app with `npm run dev`.

Either way, **never run a real Visibility collection against a third-party site you do not
own, and never with real credentials.**

---

## 0. Pre-flight: required checks (run once per build)

Use fake data only. Record the commit SHA these passed on.

- [ ] `npm ci`
- [ ] `npx playwright install chromium`
- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run poc -- check-egress` (network egress allowlist)
- [ ] `npm run poc -- check-persistence` (local-write allowlist)
- [ ] `npm run poc -- check-bypass` (no CAPTCHA-solving / anti-bot dependency)
- [ ] `npm run poc:matrix -- deterministic chromium` (deterministic field mapping)
- [ ] GitHub `ci / unit`, `ci / e2e-deterministic`, and `shellcheck` are green on the branch/PR

---

## 1. DMG packaging & first launch (no Node required)

Run on an Apple Silicon Mac, macOS 14 Sonoma or macOS 15 Sequoia.

- [ ] `npm run package:dmg` produces `release/Soroeru-<version>.dmg`; `out/` and `release/`
      stay untracked/ignored by Git (`git status -sb`)
- [ ] Mount the DMG and drag `Soroeru.app` to `/Applications`
- [ ] Because the build is **unsigned / not notarized**, macOS shows a Gatekeeper warning on
      first open. Resolve with **right-click → 開く**, or for local testing only
      `xattr -dr com.apple.quarantine /Applications/Soroeru.app`
- [ ] The app launches **without** a system Node.js install, a hosted account, a cloud vault,
      a telemetry opt-in, or a browser extension
- [ ] The window title shows **Soroeru** and the subtitle「ローカルファースト・エージェンシーエンジン」

## 2. Encrypted vault: setup, unlock, recovery key

- [ ] First run (no vault yet) shows the **vault setup** form (passphrase + confirmation)
- [ ] A passphrase shorter than 8 characters is rejected with a clear Japanese message and no
      vault file is created
- [ ] A valid passphrase creates the encrypted vault under
      `~/Library/Application Support/Soroeru/vault.json` by default (or under
      `CATASHIRO_STATE_ROOT` when set) and opens the unlocked app
- [ ] Inspect `vault.json` in a text editor: it contains only encrypted JSON
      (`vaultVersion`, `kdf`, `metadata`, `records[]` with `iv`/`ciphertext`) — **no plaintext
      personal data, credentials, or values**
- [ ] 「施錠」locks the vault; relaunching shows the **unlock** screen (passphrase + recovery
      options), not the setup form
- [ ] Unlocking with a wrong passphrase fails closed (no data shown)
- [ ] The dashboard shows a recovery-key reminder until one is generated; 「作成」shows the
      recovery key **once** with a保管 warning
- [ ] After locking, **unlock with the recovery key** succeeds; a wrong recovery key fails closed
- [ ] Removing only `Soroeru.app` does **not** delete the vault; deleting the
      `Application Support/Soroeru` folder makes the next launch behave as a fresh first run

## 3. CSV import & queue review

Prepare a **fake** `Google Passwords.csv` with the header
`name,url,username,password,note`. For Parts 3–6, point the URLs at the local fake sites
(`npm run poc:serve`, e.g. `http://127.0.0.1:<port>/login`) and use fake usernames/passwords.

- [ ] On the **取り込み** tab, choosing the CSV imports it locally and shows a **counts-only**
      summary (sites created/matched, credentials imported, skipped) — never a raw
      username/password/note
- [ ] The summary lists the imported site IDs to review and notes that the actual collection
      runs from the **収集** tab
- [ ] A prompt recommends deleting the source CSV yourself; the app does **not** auto-delete it
- [ ] A malformed header (e.g. wrong columns) is rejected with the
      「CSV のヘッダー形式が想定と異なります」message and no import occurs
- [ ] An oversized / over-long CSV is rejected (too-large / too-many-rows) without importing

## 4. Visibility collection (auto-login → 開示台帳) + wall hand-off

Run this against the **local fake sites** only.

- [ ] The **収集** tab lists the imported sites with a 未収集 / 収集済み badge and a「収集」button
- [ ] Pressing「収集」opens a **headed browser**, auto-logs-in with the stored credential, and
      collects registered values into the vault
- [ ] After the run, the site shows 収集済み and a disclosure count; the status line reports
      「収集が完了しました。」
- [ ] **Wall hand-off:** for a site whose flow reaches a CAPTCHA / OTP / verification page, the
      run **pauses** and the panel shows a hand-off banner asking you to resolve it yourself in
      the headed browser. The instruction never suggests solving/bypassing the wall.
- [ ] After you resolve the wall in the browser and press「解決して再開」, the run re-observes the
      page and resumes from where it paused
- [ ] Pressing「中止」instead ends the run as a stopped/hand-off state and records a要確認
      (Constraint) — nothing is bypassed
- [ ] A detected **automation-prohibiting ToS** wording is surfaced as a要確認 Constraint for
      you to decide, not silently blocked and not auto-proceeded
- [ ] Starting a second collection while one is running is refused (別の収集が進行中です)

## 5. Disclosure ledger (per-site, stale flags, masked reveal)

- [ ] The **開示台帳** tab lists each site with disclosure counts and 古い / 不明 stale badges,
      relationship chips (ニュースレター/継続課金 等), and a要確認 count where applicable
- [ ] Opening a site shows its composed detail: each disclosed attribute with a stale flag
      (最新 / 古い / 不明) and a **masked** preview (bullets), never the raw value by default
- [ ] A value whose canonical Personal Attribute differs is flagged **古い (stale)**; a matching
      one is **最新 (current)**; a hash-only one is **不明 (unknown)**
- [ ] 「表示」on a revealable row requires **re-entering the master passphrase**; a correct
      passphrase reveals the value transiently, a wrong one fails with a clear message
- [ ] The most-sensitive field (card CVV) is **not** revealable from the ledger at all
- [ ] No raw value appears anywhere in the ledger view until an explicit re-authenticated reveal

## 6. Cross-cutting filters & initial Reflection

- [ ] The **インサイト** tab shows the four filters: ニュースレターが有効 / 継続課金・無料トライアル /
      連絡先・カードが古い / 収集が止まっている（未確認）
- [ ] Each filtered site links to its evidence and a「次の安全なアクション」description (the
      executing slices land later; Slice A is descriptive)
- [ ] The initial **Reflection** summarizes findings (stale / newsletter / billing /
      over-disclosed / stalled) as **separate observations** — it does **not** collapse into a
      single blind "全部承認" button (never a delegation of will)

## 7. App-quit lifecycle (no orphan browser, vault locked)

- [ ] Start a collection run, then **quit the app** (⌘Q): the headed Playwright browser closes
      and no `Soroeru`/Chromium helper process remains (check Activity Monitor / `pgrep`)
- [ ] Relaunching shows the **unlock** screen (the vault was locked on quit; the derived key is
      not retained)

## 8. Privacy & security spot checks

- [ ] No telemetry/analytics/crash-reporting network calls occur (the build adds none;
      `check-egress` enforces this statically)
- [ ] Evidence/diagnostics contain **references, hashes, and masked snippets only** — no raw
      values, screenshots with secrets, cookies, tokens, or Playwright traces from real sites
- [ ] If you configure an AI provider (optional), only form structure / terms text is sent —
      never raw personal values (deterministic mode is the default and needs no provider)

---

## 9. Beta release notes & known limitations

When sharing a build, record: tested commit SHA/tag, artifact name and distribution channel,
supported platform (Apple Silicon Mac, macOS 14/15), **signing/notarization status (currently
unsigned)**, and the Gatekeeper steps from Part 1. Carry forward these limitations until the
implementation and checks prove otherwise:

- [ ] Mac-only beta; Windows, Linux, and mobile are unsupported
- [ ] Build is **unsigned / not notarized**; no auto-update channel (install each build manually)
- [ ] System Node.js is not required (Electron's embedded runtime is used)
- [ ] No hosted vault, backend sync, telemetry, analytics, or crash reporting; the vault is
      local and encrypted by default
- [ ] CAPTCHA / MFA / identity & email/SMS verification / bot detection / rate limits /
      paywalls / access controls are **hand-off points and are never bypassed**
- [ ] Slice scope is **Visibility only**: bulk update, withdrawal, and new-registration gate are
      later slices
- [ ] Field detection is **Japanese-only** for now
- [ ] AI Provider mode is optional, uses the user's configured key, and receives form structure
      / terms text only — never raw personal values

> The previous Catashiro registration-first manual checklist (Add Site / registration gate /
> three guards / bulk update against `npm run poc -- register|ui`) is **superseded** by Slice A
> and has been removed from this document; it remains in git history for reference.
