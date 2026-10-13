# Extension and Cloud manual checks

Use fake data, a disposable Chrome profile and a development Cloud project.
Record the commit, build configuration, results and omissions in the Issue/PR.
[Development](development.md) owns setup/commands; [security](security.md) owns
policy. Pending features below are release criteria, not currently available UI.

## Vault and panel lifetime

- [ ] Build/load the unpacked extension and open the Side Panel without Electron
      or a Native Messaging host. Create a vault, record its one-time recovery
      key and download the encrypted export.
- [ ] Verify IndexedDB contains Vault v2 ciphertext only. Wrong passphrase/recovery
      key fails without clearing data. Correct recovery unlocks the existing vault.
- [ ] Open a second Chrome window's panel: only one panel can unlock/write.
- [ ] Lock, close the panel and restart Chrome separately: key access stops and
      the next use needs unlock. Rebinding the tab is explicit.
- [ ] Simulate a save/quota failure. Lock shows failure and retains the unlocked
      state for retry/export; corrupt storage is never overwritten with empty data.
- [ ] Verify persistence-denied and encrypted-backup reminders. Do not erase the
      only copy to test recovery; use a disposable exported fixture.

## Tab and collection

- [ ] Add a fake site in the panel, select its HTTPS tab and grant origin access.
      Verify another tab/origin cannot receive collection commands.
- [ ] Collect the fixture's known values and verify account, attribute, time and
      source; missing/ambiguous fields remain unknown, not successful empty reads.
- [ ] Navigate out of scope, close the tab, revoke permission, restart the worker
      and lock the vault while a request is pending. Each invalidates stale work;
      a returned stale response cannot write values. Release leaves the tab open.
- [ ] Add CAPTCHA/MFA, bot/rate-limit markers or automation-prohibiting terms.
      Collection stops; the user remains in the same tab. Resume rechecks the
      page and authorization. No alternate browser or bypass is attempted.
- [ ] Cancel a run and verify already saved observations remain, with no later
      sends/writes attributed to the cancelled request.

## Cloud settings panel (#568)

Use a development environment with fake vault records only.

- [ ] Open the Side Panel after unlocking the vault. The「クラウドと共有の設定」section
      appears with both toggles off and the four-category description visible. The
      section renders even when the cloud API is unconfigured (shows a notice).
- [ ] Toggle「クラウドのフォーム知識と Gemini を使う」on and off: confirm the saved notice
      or stop notice appears, and no network call is made while the API is unconfigured.
      Toggle on while collection is running: confirm the toggle remains operable (not disabled).
- [ ] Toggle「改善用の動作データを送る」off with a queued item in the encrypted vault:
      confirm the queue is emptied immediately and the stop notice appears.
      Toggle sharing back on requires a successful save before network calls resume.
- [ ] Simulate a save failure (disconnect IndexedDB or intercept the vault write):
      confirm the error message「設定を暗号化保存できませんでした」appears, the toggle
      stays at the in-memory off value, and an enable toggle fails closed (does not
      send data).
- [ ] Click「識別用キーを再生成」with a queued feedback item: confirm the item is
      discarded from the queue and the notice about past data not being affected appears.
      Confirm the key itself is not logged, displayed in plaintext, or sent to any
      cloud endpoint.

## Tier 1 shared schemas

Use `cloud/seeds/profile.html`, the reviewed seed import command in
[cloud/README.md](../cloud/README.md), a development HTTPS fixture host and fake
vault records. Browser equivalents are `tests/e2e/tier1-*.e2e.ts`.

- [ ] Import the reviewed seed, resolve its fingerprint and verify Firestore has
      only structure/mappings/counts/timestamps. A changed seed needs a higher version.
- [ ] Build with the API origin and enable cloud assistance. Inspect Network:
      lookup contains registrable domain, fingerprint and client version only,
      even when the local page has a path/query containing fake personal text.
- [ ] Break one anchor: unaffected mappings still read; the broken field becomes
      unresolved. A changed fingerprint invalidates stale proposals.
- [ ] Verify encrypted cache storage. Disable assistance or disconnect Cloud:
      valid cache/local resolution continues, unresolved fields remain unknown.
      A live `none` response does not reuse an obsolete cached schema.

## Tier 2 structure mapping

Configure an explicit reviewed Gemini model in the development environment.
Automated equivalents are Tier 2 unit, browser and Cloud tests.

- [ ] Verify Vertex logging and implicit caching are disabled. Run a profile
      fixture without an active schema. The POST contains structure only: no
      names, email, address, password, CVV, options or checked state.
- [ ] Confirm Gemini IDs/keys are validated, and actual values are read locally.
      Navigate/change structure or invalidate the lease while inference is pending:
      discard the response. Repeat with a wall appearing before local read.
- [ ] Simulate resolve outage, Gemini 429/503 and invalid output. No raw-value
      fallback or automatic retry occurs in the current Tier 2 path.
- [ ] With sharing enabled, inspect the encrypted feedback queue: anchors and keys
      only. Sharing disabled records no new feedback.
- [ ] **Offline cache freshness (Issue #567)**: with cloud assistance enabled, load
      a page whose schema was cached more than 30 days ago (backdate `fetchedAt` in
      the encrypted vault via a test script). Simulate offline. Confirm no schema
      match and graceful null result. Restore `fetchedAt` to within 30 days; confirm
      the cache is used again offline.
- [ ] **Queue retry (Issue #567)**: with telemetry sharing on, trigger a Tier 2
      resolve (no active schema). A feedback item should appear in the encrypted
      queue. Disconnect the network and trigger another resolve to confirm the item
      stays in the queue. Reconnect and trigger a fresh resolve; confirm the item is
      delivered (queue empties). Verify delivered feedback contains only
      structure/hashes (anchors, keys, fingerprint) — no personal values.
- [ ] **Idempotency key preserved**: capture the queue item before delivery. After
      retry delivery, confirm the `idempotencyKey` is identical to the original.

## Tier 3 consent gate and PII fallback (#562)

Use only fake fixture data and a development Cloud project. Automated equivalents
are `soroeru-tier3-resolution.test.ts` and Cloud API tests (`server.test.mjs`).

- [ ] Enable cloud assistance, arrange a fake profile page with at least one field
      Tier 1 and Tier 2 leave unresolved, and confirm the consent gate dialog appears
      with the correct origin and the list of requested attribute keys.
- [ ] Decline the consent gate: no `tier3-ticket` or `read-with-consent` request is
      sent; the result carries the Tier 2 values with the unresolved field still missing.
      Close the dialog via the X button and verify the same outcome.
- [ ] Let the gate expire (or set the deadline to a short test value): no API call is
      made; the result is the same as decline.
- [ ] Approve the gate: `tier3-ticket` is called once, `read-with-consent` once.
      Inspect both requests: no site name in plain text, no raw values, no passwords,
      CVV, or OTP items in the payload. Confirm the consent ID is a fresh UUID each run.
- [ ] Toggle cloud assistance off while the gate is open: the gate closes with
      "declined" and no API call is made.
- [ ] Inspect Cloud Logging and Trace for the `tier3-ticket` and `read-with-consent`
      handlers: no request body content, no response values, no site name, and no
      PII appear in log entries or trace spans. Only the consent ID, payload hash,
      payload byte count, and budget-decrement event are logged.
- [ ] Verify that the per-day budget counter increments on approval and that a second
      approval on the same day uses the same counter record (idempotency key prevents
      double-decrement on retry).
- [ ] Confirm that password, CVV, and OTP fields (type=password, autocomplete=
      current-password / new-password / one-time-code / cc-csc) are never included
      in the `readRegionMasked` payload sent to the cloud, even if they appear on
      the same page as the unresolved fields.

## Cloud deployment

- [ ] Run `node scripts/check-cloud-deployment.mjs <project-id>` after runtime
      deployment. Verify public contracts, payload-bound tickets/replay rejection,
      service accounts, instance limits and logging/cache settings.
- [ ] A pending telemetry/read handler returning `503 unavailable` is expected;
      it must not acknowledge persistence or inference that did not occur.
- [ ] Inspect both services' Cloud Logging/Trace: application entries contain only
      enum error category and latency, not bodies, values, IP, site, tokens or
      consent IDs. Inspect additional sinks as well as the configured exclusions.
      Confirm Firestore `schemaFeedback/{id}/receipts/{key}` document exists after
      delivery and a re-delivered identical key returns `accepted: true` without
      incrementing counters.
- [ ] Verify fallback has Vertex and specific ticket-secret access but no Firestore
      or BigQuery grant. Inspect budget counts after smoke; billing alerts notify
      at configured thresholds but do not cap spending.
- [ ] Verify PR runs validate only; main deployment uses OIDC and the commit's
      immutable image digest. No service-account key or local state artifact is uploaded.
- [ ] Run the Tier 2 manual scenario: the deployment smoke permits unavailable
      mapping and alone cannot establish that the configured model works.

## Pending policy and migration acceptance

Apply these when the corresponding implementation is available, and record any
missing feature as untested rather than passing it:

- [ ] Tier 3 decline/close/timeout sends nothing; scoped run approval bounds sites,
      page kinds, keys, 20 requests and 15 minutes. Expansion, expiry, wall hand-off,
      lock, close and restart end authority. Retry is bounded with a fresh ticket.
- [ ] No password/CVV/OTP or ambiguous secret-like value reaches Gemini. Oversized
      regions hand off; fabricated, cross-item and expanded masked values fail
      corroboration. Tier 3 never enters schema learning or logs.
- [ ] Sharing-off clears queues and blocks delivery; assistance-off blocks Cloud
      requests while local ledger/cache remains useful. Both default off.
- [ ] L1 requires explicit scope selection without a quiz; writes retain required
      consequential confirmations. Unverified identity edits cannot retain a badge.
- [ ] Import a disposable legacy encrypted export, check records/recovery and
      unsupported-version/corruption failures, and confirm overwrite is explicit.
      Do not import desktop browser session state into the Chrome profile.
- [ ] Before desktop retirement, compare migrated screens and outcomes using
      fake data. Legacy entry points are in development; detailed old DMG release
      evidence remains in Git history and the original PRs.
