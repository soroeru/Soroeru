# Security

This document owns **security and privacy decisions** for `Catashiro`: principles, threat
model, sensitive data handling, encryption, AI-disclosure policy, wall safety boundaries,
DOM input safety, and dependency policy.

Canonical product direction is [`requirements.md`](requirements.md).
Requirement-level statements live in [`requirements.md`](requirements.md) §7.

> **Direction change (2026-06-12).** `Catashiro` now stores the user's **full** personal
> data — including credit card data (with CVV) and per-site credentials — locally and
> **encrypted**, and registers / updates accounts on the user's behalf. The previous
> "do not store passwords or cards" and "never auto-submit" rules are replaced. The
> hard line that remains is: **never bypass CAPTCHA / MFA / bot detection / access
> controls.**

## 1. Security Principles

- Keep all personal data local and **encrypted at rest**; the user owns it.
- Network egress is limited to **(a) the target sites the user asks the agent to act on**
  (the agent navigates, fills, and submits there) and **(b) the user's configured AI
  provider** (form structure / terms text only, never raw personal values). Future
  user-owned cloud-storage sync may write only encrypted vault bytes to a user-selected
  location. No telemetry, analytics, crash reporting, or any other destination.
- **Minimize disclosure to the AI model**: send form structure / terms text, not raw
  personal values. Do not use provider stateful features (prompt caching of PII, stored
  threads, memory).
- **Never bypass** CAPTCHA, MFA, bot detection, access controls, rate limits, or
  paywalls. Detect and hand off to the user.
- Submit a registration only after the user approves the review-and-confirm gate; apply
  the three guards; do not auto-submit on auto-creation-prohibited sites.
- Treat page text and attributes as untrusted input.
- Use fake data in tests, fixtures, docs, screenshots, and examples.
- Do not commit secrets, local state, AI review artifacts, or generated caches.

## 2. Threat Model

| Threat | Impact | Mitigation |
| --- | --- | --- |
| Local store of full PII + card + credentials is exfiltrated | High-impact loss of all the user's data and accounts. | Encrypt at rest (AES-256-GCM, master-passphrase-derived key, key in memory only). Never log decrypted values. |
| CVV stored | The "last factor" protecting a stolen card number is lost. | Treat CVV as most sensitive: encrypted, never sent to the model, decrypted only at fill time and discarded, optional master-passphrase re-prompt for card use. |
| Raw personal values sent to the AI model | Data leaves the machine; provider may log it. | Send structure only; fill values locally. Disable stateful features; prefer zero-retention / no-training provider options. |
| Wrong auto-submit / wrong terms accepted | User is bound to a contract or a wrong account is created. | Post-analysis review-and-confirm gate; three guards; authorization record (mandate). |
| Unintended payment obligation | Free trial silently becomes a paid subscription. | Payment-field stop; free-trial→subscription surfaced as high-risk; card filled only on approval. |
| CAPTCHA / MFA bypass behavior | Circumvents site protections; violates ToS and project policy. | Detect and hand off; never solve, bypass, hide, or outsource. |
| Automated creation where ToS forbids it | Account-creation automation violates the site's terms. | Fill only; the user presses the final button. |
| API key leak | The user's AI account is abused. | Encrypt the API key with the same scheme; never log it. |
| User-owned cloud storage exposes the vault file | Encrypted bytes may be copied or synced by a third-party storage provider. | Store only authenticated encrypted vault bytes; never provide the passphrase, derived key, decrypted records, or raw values to the storage provider. |
| Local candidate definitions reveal user activity | Even without raw values, a candidate can reveal which sites the user visited, tried to register with, updated, or withdrew from. | Store local candidates in the encrypted vault; sanitize and require explicit opt-in before sharing. |
| MCP server overexposes local authority | External AI agents could inspect or act on sensitive account state beyond the user's intent. | Keep MCP disabled by default, local-only, permissioned, logged, and limited to summaries/planning/task creation; never expose raw values or bypass approval gates. |
| DOM-based injection / unsafe rendering | Page-provided text affects the UI or is mis-mapped. | Treat page text as untrusted; render as text; validate before use. |
| Real data committed in fixtures / logs | Sensitive data enters repository history. | Fake data only; keep local state Git-ignored. |

## 3. Sensitive Data Handling

Stored locally, **encrypted** (RFC §3):

- name (incl. phonetic / romanized), email, phone;
- postal code and addresses (home / work / shipping / billing);
- company name, department name;
- **credit card number, expiry, holder, security code (CVV)**;
- **per-site login ID and password**;
- the AI provider API key;
- user-defined custom fields;
- per-site records (references + hashes, not duplicated raw values) and mandates;
- local candidate definitions, because they reveal user activity and account-management
  intent even when they do not contain raw personal values.

Never stored:

- raw personal values in per-site records (use references + hashes for diffing);
- raw personal values in local candidate definitions, official definitions, shared
  registry submissions, or AI prompts;
- decrypted values in logs, error messages, or crash reports;
- real personal data in tests, fixtures, docs, or screenshots (use fake values).

**Mask policy (PRIV-002 / #21)**: a single mask module
(`src/agent/gate.ts`) defines two policies, used everywhere
a profile value can reach a display or a file:

- `maskValue(key, value)` — for **interactive review surfaces** (the
  review-and-confirm gate, `renderGate`, and the local UI's profile listing:
  the web UI's personal-data section and legacy `AppUI`'s "1. 個人情報"
  menu): card number → last 4 digits; CVV, card
  expiry/holder, and account password → a strong mask (`isSensitiveKey`);
  email and phone → a partial mask (`du***@example.com`, `090-****-5678`)
  that still lets the user recognize their own value. Other fields (name,
  address, company, account ID) are shown in full — the gate's job is to let
  the user verify *exactly* what will be submitted, so masking those would
  weaken the review. The UI's "r) 表示" (reveal) command additionally requires
  re-entering the master passphrase for `isSensitiveKey` fields before
  showing the raw value (Claude Review follow-up on #17).
- `maskForArtifact(key, value)` — for **persisted artifacts**
  (`state/catashiro-poc/matrix-*.json`, written by `npm run poc -- matrix`):
  card / CVV / expiry / holder / password use the same strong mask; every
  other field is reduced to its length (e.g. `(17文字)`) or `(空)` — no raw
  value of any kind is written to disk outside the encrypted store. This is
  the "necessary minimum" treatment for fields (e.g. address) that
  `maskValue` shows in full for review purposes.

**Local persistence (PRIV-002 / #21)**: `npm run poc -- check-persistence`
(`src/dev/privacy-check.ts`, tested by
`tests/unit/catashiro-poc-privacy.test.ts`) scans
`{src,run}/**/*.ts` for local-filesystem writes and fails
unless each one carries a `// persist: encrypted-store`,
`// persist: encrypted-export`, or `// persist: measurement-output`
annotation — i.e. the encrypted store (`src/store/store.ts`), the encrypted
export/import (SEC-003 / #44), and the masked measurement output above are the
*only* code paths allowed to write to local disk. A new, unannotated local
write fails this check and must be reviewed against this section before it is
annotated.

**`state/ai-reviews/`** (the local AI review hook,
[`docs/local-ai-review.md`](local-ai-review.md)) operates on `git diff` of
source code, not on `state/catashiro-poc/` (the encrypted profile store); since
profile values are encrypted at rest and never appear in source, review
artifacts cannot contain raw personal data. Both `state/ai-reviews/` and
`state/catashiro-poc/` are Git-ignored.

## 4. Encryption (canonical)

Per RFC §9. Use only widely vetted algorithms; do not roll custom crypto.

1. **Master passphrase** — entered by the user at unlock; never stored.
2. **Key derivation** — Argon2id (memory-hard) from passphrase + a stored 16-byte random
   salt; **PBKDF2-HMAC-SHA-512 (≥ 600k iterations)** as a Web-Crypto-only fallback. KDF
   parameters are stored to remain reproducible.
3. **Encryption** — AES-256-GCM (authenticated), a fresh random 96-bit IV per record,
   never reused. Stored as `{salt, kdfParams, records: [{iv, ciphertext+tag}]}`.
4. **Key lifetime** — the derived key lives in memory only while unlocked; cleared on
   lock / exit. Never written to disk.
5. **Runtime** — AES-GCM / PBKDF2 via Web Crypto API; Argon2id via a vetted library.
6. **Format version** — the store file carries a `version` field; opening a version newer
   than the running build understands fails closed rather than mis-reading the bytes.
   Migrations are added per version, never silent.
7. **Lock lifecycle** — `lock()` drops the derived key and every decrypted value
   (profile, site records, mandates, provider settings) from memory; further reads/writes
   throw until the store is reopened with the passphrase.

The reference implementation of this scheme is `src/store/`
(`crypto.ts` + `store.ts`); the AI provider API key, model settings, local candidate
definitions, and account-state metadata are persisted as encrypted records in the same
store, and the most-sensitive field (CVV) is kept out of the shared transform view and
read only through a sanctioned fill-time accessor.

Convenience option: an OS keychain (macOS Keychain / Windows DPAPI / Linux libsecret) may
hold a session key to avoid re-entry, trading convenience for relying on the OS login
session — make the tradeoff explicit in settings.

**CVV**: storing it is generally discouraged (it is the last factor protecting a stolen
card number). It is stored at the user's request but handled as the most sensitive field:
encrypted, never sent to the model, decrypted only at fill time and immediately discarded,
with an optional master-passphrase re-prompt (default on) for card operations.

**Recovery (SEC-003 / #44)**: a zero-knowledge design means a forgotten passphrase loses
all data unless the user set up a recovery key beforehand.

- **Recovery key**: a 256-bit random secret, generated locally and shown to the user
  exactly once (base32, grouped for readability, e.g. `ABCD-EFGH-...-2345`). It is never
  persisted in plaintext and never sent anywhere.
- **Wrapping the master key**: rather than a separate data-encryption key / envelope
  layer, the recovery key directly wraps the existing passphrase-derived master key.
  `setupRecoveryKey()` exports the master key's raw bytes, encrypts them (AES-256-GCM)
  under SHA-256(recovery key) as the key-wrapping key, and stores the result as the
  optional `recovery` field in the store file. A single SHA-256 is sufficient here
  (unlike the passphrase KDF) because the recovery key already carries 256 bits of
  entropy.
- **Recovery unlock**: `PocStore.openWithRecoveryKey()` / `CatashiroApp.unlockWithRecoveryKey()`
  unwrap the master key with the recovery key instead of deriving it from a passphrase,
  then decrypt the store as usual. A wrong recovery key fails AES-GCM authentication and
  is rejected (fail-closed), matching the wrong-passphrase behavior in §4.7.
- **Rekey invalidates recovery**: `rekey()` (passphrase change) derives a new master key
  under a fresh KDF salt and clears the existing recovery wrap, since it wraps the old
  key. The user must run `setupRecoveryKey()` again afterward if they want recovery to
  remain available. This is documented behavior, not a bug.
- **Export / import**: `exportEncrypted()` returns the same encrypted JSON shape as the
  on-disk store (`version`, `kdf` params, encrypted `records`, and `recovery` if
  configured) — there is no plaintext export. `PocStore.importEncrypted()` validates the
  store format version before writing anything (fails closed on an unsupported version,
  per §4.6) and refuses to overwrite an existing destination file unless the caller
  passes `{ overwrite: true }`.
- **Error handling**: invalid JSON fails closed as `StoreCorruptError`; unsupported or
  newer format versions fail closed as `StoreFormatError`; locked-store access fails as
  `StoreLockedError`. Import validates JSON and format before writing the destination.
- **Mac beta location**: app-bundle launches use `~/Library/Application Support/Catashiro`
  by default (`CATASHIRO_STATE_ROOT` may override it for tests or an explicit
  user-selected local folder). Development commands continue to use `state/catashiro-poc`.

## 5. AI Provider Disclosure Policy

- Send the model **form structure and terms text**, not raw personal values. The model
  returns a mapping plan / high-risk findings; the automation layer fills values locally.
- Use only the user's configured provider: Anthropic (Opus / Sonnet / Haiku) or OpenAI
  (GPT-5.4 / 5.4-mini / 5.3-Codex), via a provider-abstraction layer.
- AI mode is optional and should be invoked only when the user enables `mode=ai` and
  deterministic confidence is too low, a site/flow is unsupported, or the user explicitly
  asks for AI assistance.
- Use stateless requests; do not enable prompt caching of PII, stored threads, or memory.
  Prefer zero-retention / no-training options where the provider offers them.
- The model itself does not learn from inference and the context window is per-request;
  the residual risk is provider-side request logging and any stateful feature you enable
  — this policy avoids the latter and minimizes the former.
- App-embedded terminals and CLI Provider integrations are not supported AI integration
  paths. They make output stability, cost control, permissions, and structured validation
  harder than API Provider integration.

## 6. Network And External Services

Allowed external destinations are limited to: (a) the **target sites** the user asks the
agent to register, update, or withdraw from (normal browser navigation and form
submission), (b) the user's **configured AI provider** (form structure / terms text only),
and (c) future user-owned storage locations that receive only encrypted vault bytes after
an explicit design/implementation issue. No telemetry, analytics, crash reporting, hosted
vault, or remote classification to any other service. The user's decrypted data store is
never uploaded anywhere. Adding any other destination requires an explicit issue updating
requirements, this document, and the user-facing docs.

User-owned cloud storage is allowed only as encrypted-vault storage/sync. The storage
provider must never receive the master passphrase, derived key, decrypted records, raw
personal values, raw candidate evidence, or AI prompts. Conflict resolution, sync
metadata, and provider authentication must be designed so they do not create plaintext
shadow state.

**Static enforcement (PRIV-001 / #20)**: `npm run poc -- check-egress`
(`src/dev/egress-check.ts`, tested by
`tests/unit/catashiro-poc-egress.test.ts`) scans
`{src,run}/**/*.ts` for network-call sites and fails unless each one
carries a `// egress: target-site` or `// egress: ai-provider` annotation, and fails if
`package.json` gains a dependency matching a telemetry/analytics denylist (Sentry,
Segment, Datadog, etc.). `sites/` (the local 127.0.0.1-only PoC
test-site server) is out of scope — it is not external egress. A new, unannotated
network destination — or a telemetry-shaped dependency — fails this check and must be
reviewed against this section before it is annotated.

## 7. Wall Safety Boundaries (non-negotiable)

The agent may **detect** a wall and hand off; it must never complete or circumvent it.

Do not implement:

- CAPTCHA solving, bypass, hiding, outsourcing, or token reuse;
- MFA / one-time-code bypass;
- bot-detection or rate-limit bypass;
- paywall or access-control bypass;
- auto-submitting on sites whose terms prohibit automated account creation.

At a wall, the agent pauses in the same headed Playwright session, the user resolves it,
and the agent resumes only after re-observing the page. Ambiguous access-control or
security-check wording is treated as a wall too: when unsure, stop and ask the user.

**Static enforcement (SEC-002 / #23)**: `npm run poc -- check-bypass`
(`src/dev/bypass-check.ts`, tested by
`tests/unit/catashiro-poc-bypass.test.ts`) scans `package.json` `dependencies` /
`devDependencies` for package names matching a CAPTCHA-solving or anti-bot /
browser-fingerprint-evasion denylist (e.g. `2captcha`, `anticaptcha`,
`capsolver`, `*-stealth`, `rebrowser`, `fingerprint-injector`,
`fingerprint-suite`). A dependency matching this denylist fails the check and
must be reviewed against this section before it is added — `Catashiro` detects
walls and hands off; it never solves, bypasses, hides, or outsources them.

**Detect-only invariant (SEC-002 / #23)**:
`tests/unit/catashiro-poc-walls.test.ts` fixes two invariants that hold
regardless of which wall kind `detectWall` reports:

- `handoffInstruction` copy never suggests solving, automating, bypassing, or
  skipping the wall — it only asks the human to resolve it themselves.
- `clearWalls` resolves to `status: "abort"` (never proceeds, never
  re-observes) for **every** `WallDetection["kind"]` when no handoff is wired.
  This is the fail-safe side of a detector false negative in the handoff
  path: a wall that is detected but cannot be handed off must stop the run
  (recorded as `manualHandoff`), not be treated as cleared.

## 8. Registration Safety Boundaries

- Submit only after the user approves the post-analysis review-and-confirm gate.
- Apply the three guards: high-risk clause escalation; payment-field stop (except
  free-trial→subscription approved by the user); no auto-attestation of eligibility /
  identity statements.
- Record a per-registration mandate (references, hashes, terms URL / version) for audit.
- Withdrawal and account-deletion flows require the same gate discipline. Irreversible
  withdrawal confirmation, eligibility/identity attestation, and any final action blocked
  by site terms must remain under the user's explicit control.

### 8.1 Sensitive Site Category Risk

Certain site categories carry higher ToS or regulatory risk for automated registration
or update:

- **Financial services**: banks, brokerages, insurance, tax authorities.
- **Government portals**: national/local government, social services, immigration.
- **Medical services**: clinics, pharmacies, health-record portals.

The app's fill-only/user-submit policy (`REQ-008`) and ToS detection handle known
prohibitions, but these categories warrant additional investigation before broader use.
For Japan specifically, the terms of 楽天, Amazon Japan, Yahoo! Japan, and Google
regarding automated read and update should be reviewed (see [`requirements.md`](requirements.md) §14.4).

### 8.2 GDPR and Privacy Compliance Notes

`Catashiro`'s local-first, no-hosted-vault, no-telemetry design aligns with core GDPR
principles: data minimization, user ownership, and no third-party processing. However,
formal GDPR compliance requires additional investigation:

- **Right to be Forgotten**: the local vault can be deleted, but a mechanism to confirm
  complete deletion (including backups and any exported data) should be documented.
- **Data Controller responsibility**: when `Catashiro` is used by organizations, the
  responsibility boundaries for automated account actions need to be clarified.
- Legal applicability varies by jurisdiction; the investigation items are tracked in
  [`requirements.md`](requirements.md) §14.3 and require separate implementation issues
  before work begins.

## 9. Candidate Definition Privacy

Candidate definitions are local, unreviewed site/form/field/withdrawal/wall definitions
generated by AI mode, user input, or observation. They must not contain raw profile
values, screenshots with personal information, cookies, session tokens, or raw HTML that
captures user-entered values.

Even sanitized candidates can reveal sensitive user activity, such as interest in a
medical, financial, employment, political, religious, or adult service. Therefore:

- store local candidates in the encrypted vault;
- search them locally by structured metadata and fingerprints before invoking AI;
- send at most the relevant sanitized candidate snippets to the configured AI Provider;
- make sharing candidates fully opt-in;
- strip user identifiers, raw values, account state, cookies, tokens, and screenshots
  before submission;
- promote candidates to official shared definitions only after review and tests.

**Implementation (#80):** `validateCandidateDefinition` (`src/agent/definitions.ts`) runs
a heuristic scan over every free-text/pattern string in a candidate for email-like,
card-number-like, and phone-number-like values, plus structural checks (site-identity
rule present, regex patterns compile, field-rule profile keys known/custom).
`PocStore.upsertLocalCandidate` (`src/store/store.ts`) runs this validation and throws
`CandidateValidationError` rather than persisting an invalid candidate; valid candidates
are stored encrypted in `localCandidates` alongside profile data, site records, and
mandates. This heuristic is defense-in-depth, not a guarantee — callers that generate
candidates (AI mode, future observation-based generation) must still avoid embedding raw
values in the first place.

## 10. Local MCP Server Safety (future)

A local MCP server is a future advanced-user extension and must be disabled by default.
If added, it must be local-only, session-authorized, permission-scoped, and auditable.

MCP tools may expose summaries, planning helpers, sanitized current-page structure,
candidate-definition proposals, and `Catashiro` task creation for later review. MCP tools
must not expose raw personal values, credentials, card numbers, CVV, API keys, decrypted
vault exports, direct browser control, or submit/withdraw operations that skip
`Catashiro`'s own review-and-confirm gates.

All MCP calls should be logged in the encrypted vault with the tool name, time, requested
scope, and sanitized result summary. Logs must not include decrypted values.

## 11. Input And DOM Safety

Page DOM is untrusted input. Labels, placeholders, nearby text, option labels, URLs, and
attributes may be malformed, misleading, or adversarial.

- Render page-derived text as text, not raw HTML.
- Do not evaluate page-provided strings as code or selectors without validation.
- Keep raw page text out of persisted per-site records (store references + hashes).
- Validate stored data before use; never log decrypted values.

## 12. Dependency And Supply Chain

New runtime dependencies now include Playwright and a vetted Argon2id implementation.

- Add only dependencies with a clear purpose; commit the lockfile.
- Prefer small, actively maintained packages; avoid ones that phone home or process
  personal data remotely.
- Pin AI provider SDKs and verify model IDs against provider docs.
- Run the documented audit / update check when the toolchain supports it; document build /
  framework decisions in [`development.md`](development.md).

### 12.1 Mac Beta Artifact Safety

The Mac private-beta artifact is generated locally by `npm run package:mac` and written to
`release/` (gitignored). It bundles compiled application code and installed npm
dependencies, but must not bundle:

- encrypted vault files from `state/` or `~/Library/Application Support/Catashiro`;
- `.env`, API keys, passphrases, recovery keys, browser sessions, or cookies;
- local AI review output under `state/ai-reviews/`;
- screenshots, logs, diagnostics, or support bundles containing raw personal values.

The generated launcher stores beta data under the user's app-support directory and writes
process logs under `~/Library/Logs/Catashiro`. Logs must remain operational only; never
log decrypted profile values, credentials, card data, CVV, API keys, or raw AI prompts.

The first beta ZIP is allowed to be unsigned / not notarized only for the invited
10-user private beta, and release notes must say so. Wider distribution requires a
separate signing/notarization issue and a repeat of the security checklist below.

### 12.2 Local Diagnostics And Support Bundles

Diagnostics are local-only and telemetry-free. `DiagnosticEvent` records are stored in
the encrypted vault because even sanitized app lifecycle, flow-state, error, wall, or
site-activity summaries can reveal sensitive behavior. They must not contain raw profile
values, API keys, passphrases, recovery keys, AI prompts, cookies, browser sessions,
screenshots, Playwright traces, or decrypted vault bytes.

Support bundles are generated only after explicit user confirmation in the local Web UI.
`exportSupportBundleJson()` returns a redacted JSON summary with app version, OS/runtime
versions, and recent sanitized diagnostic events. It is never uploaded automatically and
must not be pasted into public issues if it contains sensitive site/activity context.

## 13. Security Checklist

Before distributing a Mac private beta, run the consolidated production privacy/security
gate:

```bash
npm run release:check
```

`release:check` runs typecheck, the unit test suite, and the three static hardening gates
that protect the beta boundary:

- `npm run poc -- check-egress` — network egress annotations plus telemetry /
  analytics dependency denylist (PRIV-001, §6)
- `npm run poc -- check-persistence` — local-write annotations, limiting persistence to
  encrypted store/export and masked measurement output (PRIV-002, §3)
- `npm run poc -- check-bypass` — CAPTCHA-solving / anti-bot / fingerprint-evasion
  dependency denylist (SEC-002, §7)

Treat a failure in any of these as a release blocker. Fix the code or update the owning
security section with an explicit reviewed exception before sharing the build.

- [ ] Secrets are not committed; local state and logs are Git-ignored
- [ ] Fixtures, screenshots, tests, and docs use fake data only
- [ ] Personal data, card data (incl. CVV), credentials, and the API key are encrypted at rest
- [ ] Local candidate definitions and per-site activity metadata are encrypted at rest
- [ ] The derived key lives in memory only; decrypted values are never logged
- [ ] Raw personal values are not sent to the AI model; no provider stateful features used
- [ ] No network egress except to the target sites the user acts on, the configured AI provider, and explicitly designed user-owned encrypted vault storage; no telemetry; decrypted data store never uploaded (`npm run poc -- check-egress`)
- [ ] Google Passwords.csv imports read only the user-selected upload body, never remember a local folder/path, and never persist or re-display the raw CSV or plaintext passwords
- [ ] Display/log/measurement-output masking follows the unified `maskValue` / `maskForArtifact` policy; local writes stay inside the encrypted store / encrypted export / masked measurement output (`npm run poc -- check-persistence`)
- [ ] Registrations submit only after the review-and-confirm gate; three guards applied
- [ ] Withdrawal/account-deletion flows preserve explicit user confirmation for irreversible actions
- [ ] Auto-creation-prohibited sites are fill-only
- [ ] CAPTCHA, MFA, bot detection, and access controls are detected and handed off, never bypassed
- [ ] No CAPTCHA-solving / anti-bot / fingerprint-evasion dependency is present (`npm run poc -- check-bypass`, SEC-002 §7)
- [ ] Mac beta artifacts exclude vault data, secrets, browser sessions, local logs, and support bundles
- [ ] Support bundles are user-initiated, local-only, redacted, and exclude raw values, vault bytes, API keys, prompts, cookies, screenshots, and traces
- [ ] Signing/notarization status is documented before distributing a Mac beta ZIP
- [ ] Future MCP tools are disabled by default, local-only, permissioned, audited, and unable to expose raw values or bypass gates
- [ ] Security-sensitive behavior is tested or manually verified

### 13.1 Release Review Evidence

For each beta release PR or release note, record only high-level evidence:

- `npm run release:check` result and timestamp / commit SHA
- GitHub `ci / unit`, `ci / e2e-deterministic`, and `shellcheck` status
- whether any dependency, network egress, local write, diagnostic, support bundle, log, or
  packaging path changed since the previous beta
- whether AI Provider prompt shape changed, and confirmation that raw personal values are
  still excluded
- whether wall detection / hand-off changed, and confirmation that no bypass behavior or
  bypass-oriented dependency was added
- whether Mac beta artifacts were inspected for excluded files: vaults, `.env`, API keys,
  recovery keys, cookies, browser sessions, local logs, support bundles, screenshots, and
  `state/`

Do not paste AI prompts, raw personal values, API keys, vault bytes, support bundles, or
real-site screenshots into release evidence.
