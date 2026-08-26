# Security

This document owns **security and privacy decisions** for `Soroeru`: principles, threat
model, sensitive data handling, encryption, AI-disclosure policy, wall safety boundaries,
DOM input safety, and dependency policy.

Canonical product direction is [`requirements.md`](requirements.md).
Requirement-level statements live in [`requirements.md`](requirements.md) §8.

## 1. Security Principles

- Keep all personal data local and **encrypted at rest**; the user owns it.
- Network egress is limited to **(a) the target sites the user asks the agent to act on**
  (the agent navigates, fills, and submits there), **(b) the user's configured AI
  provider** (form structure / terms text only, never raw personal values), and **(c) the
  Digital Agency's デジタル認証アプリ service via Soroeru's identity-auth BFF**, for My Number
  (JPKI) verification only (see §14). Future user-owned cloud-storage sync may write only
  encrypted vault bytes to a user-selected location. No telemetry, analytics, crash reporting,
  or any other destination.
- **Minimize disclosure to the AI model**: send form structure / terms text, not raw
  personal values. Do not use provider stateful features (prompt caching of PII, stored
  threads, memory).
- **Never bypass** CAPTCHA, MFA, bot detection, access controls, rate limits, or
  paywalls. Detect and hand off to the user.
- Submit a registration only after the user approves the review-and-confirm gate; apply
  the three guards; surface a detected automation-prohibiting ToS clause as a Constraint
  for the user to decide (never silently block, never bypass actively-enforced controls).
- Treat page text and attributes as untrusted input.
- Use fake data in tests, fixtures, docs, screenshots, and examples.
- Do not commit secrets, local state, AI review artifacts, or generated caches.

## 2. Threat Model

| Threat | Impact | Mitigation |
| --- | --- | --- |
| Local store of full PII + card + credentials is exfiltrated | High-impact loss of all the user's data and accounts. | Encrypt at rest (AES-256-GCM, master-passphrase-derived key, key in memory only). Never log decrypted values. |
| CVV stored from site collection | The "last factor" protecting a stolen card number is copied from a site into Soroeru. | Visibility collection excludes CVV entirely: never collect, store, display, or reveal it. User-entered canonical CVV remains most-sensitive and is decrypted only at fill time. |
| Raw personal values sent to the AI model | Data leaves the machine; provider may log it. | Send structure only; fill values locally. Disable stateful features; prefer zero-retention / no-training provider options. |
| Wrong auto-submit / wrong terms accepted | User is bound to a contract or a wrong account is created. | Post-analysis review-and-confirm gate; three guards; authorization record (mandate). |
| Unintended payment obligation | Free trial silently becomes a paid subscription. | Payment-field stop; free-trial→subscription surfaced as high-risk; card filled only on approval. |
| CAPTCHA / MFA bypass behavior | Circumvents site protections; violates ToS and project policy. | Detect and hand off; never solve, bypass, hide, or outsource. |
| Automated creation where ToS forbids it | Account-creation automation may violate the site's terms. | Surface the clause as a Constraint / high-risk item for the user to decide; never silently proceed, never silently hard-block, and never bypass actively enforced controls. |
| API key leak | The user's AI account is abused. | Encrypt the API key with the same scheme; never log it. |
| User-owned cloud storage exposes the vault file | Encrypted bytes may be copied or synced by a third-party storage provider. | Store only authenticated encrypted vault bytes; never provide the passphrase, derived key, decrypted records, or raw values to the storage provider. |
| Local candidate definitions reveal user activity | Even without raw values, a candidate can reveal which sites the user visited, tried to register with, updated, or withdrew from. | Store local candidates in the encrypted vault; sanitize and require explicit opt-in before sharing. |
| MCP server overexposes local authority | External AI agents could inspect or act on sensitive account state beyond the user's intent. | Keep MCP disabled by default, local-only, permissioned, logged, and limited to summaries/planning/task creation; never expose raw values or bypass approval gates. |
| DOM-based injection / unsafe rendering | Page-provided text affects the UI or is mis-mapped. | Treat page text as untrusted; render as text; validate before use. |
| Real data committed in fixtures / logs | Sensitive data enters repository history. | Fake data only; keep local state Git-ignored. |

## 3. Sensitive Data Handling

Stored locally, **encrypted** (see [`architecture.md`](architecture.md) §3):

- name (incl. phonetic / romanized), email, phone;
- postal code and addresses (home / work / shipping / billing);
- company name, department name;
- **credit card number, expiry, holder, security code (CVV)**;
- **per-site login ID and password**;
- the AI provider API key;
- user-defined custom fields;
- per-site Disclosure records, including encrypted site-held values, normalized hashes,
  references, and mandates;
- local candidate definitions, because they reveal user activity and account-management
  intent even when they do not contain raw personal values;
- **opt-in persisted browser session state** (`SessionState.storageState`, Issue #294): an
  exported Playwright `storageState` (cookies + localStorage), only when the user has
  enabled persistence for that specific Site Account (default off). It is at least as
  sensitive as a credential — it can grant a logged-in session without the password — so
  it is encrypted the same way as every other vault record and never written elsewhere.
  Fixed 30-day sliding expiry (no per-site risk tiering); a read past expiry treats the
  record as absent and discards it. Disabling the per-site toggle unconditionally and
  immediately clears any existing record (same "reduction is immediate" rule as the
  Delegation Boundary), and the ledger UI offers an explicit "clear now" action independent
  of the toggle.

Never stored:

- site-collected full card PAN or CVV in Disclosure records; card numbers collected from
  sites are reduced to the last 4 digits before storage, and CVV is excluded entirely;
- raw personal values in local candidate definitions, official definitions, shared
  registry submissions, or AI prompts;
- decrypted values in logs, error messages, or crash reports;
- real personal data in tests, fixtures, docs, or screenshots (use fake values).

**Known gap — `card.number` stale-state hash scheme (issue #229, documented tech debt,
no code change yet)**: `card.number` Disclosures are now compared for staleness against
only the last 4 digits of the canonical value (`comparisonValue` in
`src/domain/domain-service.ts`), matching the last-4-digit storage rule above. A
`card.number` Disclosure recorded before this comparison rule existed would carry a hash
of the full collected value under the old scheme, and would misflag as **stale** the
next time the canonical card number is edited, even though the underlying card did not
change. There is no user data predating this change today, so no migration was written;
the vault also has no general schema-versioning mechanism for internal record shapes
(only the top-level store format version, §4 point 6). Revisit this when either a real
gap in practice appears or vault-schema versioning is built for other reasons — do not
build a one-off migration for this alone.

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
  (`state/soroeru-poc/matrix-*.json`, written by `npm run poc -- matrix`):
  card / CVV / expiry / holder / password use the same strong mask; every
  other field is reduced to its length (e.g. `(17文字)`) or `(空)` — no raw
  value of any kind is written to disk outside the encrypted store. This is
  the "necessary minimum" treatment for fields (e.g. address) that
  `maskValue` shows in full for review purposes.

**Local persistence (PRIV-002 / #21)**: `npm run poc -- check-persistence`
(`src/dev/privacy-check.ts`, tested by
`tests/unit/soroeru-poc-privacy.test.ts`) scans
`{src,run,electron}/**/*.ts` for local-filesystem writes and fails
unless each one carries a `// persist: encrypted-store`,
`// persist: encrypted-export`, `// persist: measurement-output`, or
`// persist: diagnostics-log` annotation — i.e. the encrypted store
(`src/store/store.ts`), the encrypted export/import (SEC-003 / #44), the
masked measurement output above, and the plain-text app diagnostics log below
are the *only* code paths allowed to write to local disk. A new, unannotated
local write fails this check and must be reviewed against this section before
it is annotated.

**App diagnostics log (Issue #314)**: `src/logging/file-logger.ts` writes an
unencrypted, newline-delimited JSON log (default
`<userData>/logs/soroeru.log`, one-generation size rotation) so the user can
attach it to a bug report and so debugging work can read it directly. This is
a deliberate, scoped exception to "encrypt everything," matching the existing
`measurement-output` precedent: callers may only pass structural facts (site
domain, run status/reason codes, counts, sanitized error messages) — never a
raw canonical Personal Attribute, Disclosure value, credential, card datum,
passphrase, recovery key, or `storageState`. `FileLogger` additionally runs a
regex-based redaction pass over every message/field string as defense-in-depth
before writing. The Settings tab's "ログをダウンロード" button reads this file
over IPC (`soroeru:logs:export`) and triggers a renderer-side download; no
native dialog or extra filesystem grant is added to the renderer.

**`state/ai-reviews/`** (the local AI review hook,
[`docs/local-ai-review.md`](local-ai-review.md)) operates on `git diff` of
source code, not on `state/soroeru-poc/` (the encrypted profile store); since
profile values are encrypted at rest and never appear in source, review
artifacts cannot contain raw personal data. Both `state/ai-reviews/` and
`state/soroeru-poc/` are Git-ignored.

## 4. Encryption (canonical)

Per [`architecture.md`](architecture.md) §2 and §10. Use only widely vetted algorithms; do
not roll custom crypto.

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
- **Recovery unlock**: `PocStore.openWithRecoveryKey()` / `SoroeruApp.unlockWithRecoveryKey()`
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
- **Mac beta location**: Soroeru Electron app launches use `~/Library/Application Support/Soroeru`
  by default (`SOROERU_STATE_ROOT` may override it for tests or an explicit
  user-selected local folder). Development commands continue to use `state/soroeru-poc`.

## 5. AI Provider Disclosure Policy

- Send the model **form structure and terms text**, not raw personal values. The model
  returns a mapping plan / high-risk findings; the automation layer fills values locally.
- Use only the user's configured provider: Anthropic (Opus / Sonnet / Haiku) or OpenAI
  (GPT-5.4 / 5.4-mini / 5.3-Codex), via a provider-abstraction layer.
- AI mode is optional and should be invoked only when the user enables `mode=ai` and
  deterministic confidence is too low, a site/flow is unsupported, or the user explicitly
  asks for AI assistance.
- Browser-derived requests pass through an allow-list structural sanitizer. Provider adapters
  accept its branded output, not raw DOM, raw snapshots, field/display values, prefilled or
  selected values, cookies, tokens, or local value-read results. Static text is pattern-redacted
  and omitted when ambiguity remains.
- Responses use strict closed schemas. Navigation references only an opaque element ID from the
  supplied snapshot; unknown keys, invented URLs/selectors, scripts, free-form actions, and value
  requests are rejected locally before execution.
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
`tests/unit/soroeru-poc-egress.test.ts`) scans
`{src,run}/**/*.ts` for network-call sites and fails unless each one
carries a `// egress: target-site` or `// egress: ai-provider` annotation, and fails if
`package.json` gains a dependency matching a telemetry/analytics denylist (Sentry,
Segment, Datadog, etc.). `sites/` (the local 127.0.0.1-only PoC
test-site server) is out of scope — it is not external egress. A new, unannotated
network destination — or a telemetry-shaped dependency — fails this check and must be
reviewed against this section before it is annotated.

## 7. Wall Safety Boundaries (non-negotiable)

The agent may **detect** a wall and hand off; it must never complete or circumvent it.

**The boundary line is access control, not the ToS.** A ToS clause that prohibits or
discourages automation is a *civil* matter between the user (a party to that contract) and the
site; it is surfaced as a Constraint for the user to decide (see
[`requirements.md`](requirements.md) REQ-014), and acting on it on the user's behalf, inside the
user's own authenticated session, is within scope. What is **never** crossed is the
**circumvention of an actively-enforced technical access control** — CAPTCHA, MFA, bot
detection, rate limits, paywalls — which is the criminal line under unauthorized-access law
(Japan 不正アクセス禁止法 / US CFAA). Logging into the user's own account with the user's own
credentials is not unauthorized access even when automated and even when a ToS forbids bots;
solving or evading a control that actively blocks automation is. This distinction is what lets
Soroeru contest ToS-gray confidently while keeping the inviolable line principled rather than
timid.

**A user-installed Soroeru browser extension operating an explicitly selected tab is a
front-door use of the user's real browser and authenticated session, not a bypass.** The absence
of an automation-framework fingerprint is a property of the genuine user browser; Soroeru does
not falsify or conceal one. Front-door use operates strictly within the user's explicit disclosure ledger scope (Site Account集合＝操作可能スコープ, Issue #474), eliminating per-site prompt popups while keeping non-ledger sites fail-closed, with visible badge/banner state, the user's own account/credentials, and the same wall detection, Evidence, Policy, and confirmation gates as every other browser surface. It never
includes fingerprint/UA spoofing, stealth patches, human-like input or timing disguise,
automation-marker suppression, challenge-token reuse, or any attempt to continue after a site
actively blocks the operation. If bot detection or another control fires, the extension pauses
and hands the same visible tab to the user; it does not make the control stop firing.

Do not implement:

- CAPTCHA solving, bypass, hiding, outsourcing, or token reuse;
- MFA / one-time-code bypass;
- bot-detection or rate-limit bypass;
- paywall or access-control bypass;
- silently proceeding past a detected automation-prohibiting ToS clause instead of
  surfacing it as a Constraint / high-risk item for the user to decide.

At a wall, the agent pauses in the same visibly bound browser tab, the user resolves it,
and the agent resumes only after re-observing the page and revalidating the live tab lease.
If the tab, permission, bridge, browser, app, vault lock state, or site scope changed, the lease
is invalid and an explicit rebind is required. Ambiguous access-control or
security-check wording is treated as a wall too: when unsure, stop and ask the user.

**Static enforcement (SEC-002 / #23)**: `npm run poc -- check-bypass`
(`src/dev/bypass-check.ts`, tested by
`tests/unit/soroeru-poc-bypass.test.ts`) scans `package.json` `dependencies` /
`devDependencies` for package names matching a CAPTCHA-solving or anti-bot /
browser-fingerprint-evasion denylist (e.g. `2captcha`, `anticaptcha`,
`capsolver`, `*-stealth`, `rebrowser`, `fingerprint-injector`,
`fingerprint-suite`). A dependency matching this denylist fails the check and
must be reviewed against this section before it is added — `Soroeru` detects
walls and hands off; it never solves, bypasses, hides, or outsources them.

**Detect-only invariant (SEC-002 / #23)**:
`tests/unit/soroeru-poc-walls.test.ts` fixes two invariants that hold
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
  identity statements ("I am 18+", residency, "I am authorized"). A statement of the user's own
  *intent to act* (e.g. "I want to cancel"), already approved at the gate, may be auto-checked —
  the guard targets eligibility / identity claims, not the user's own decision.
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

The review-and-confirm gate, the three guards, and Constraint surfacing of detected
automation-prohibiting ToS clauses (the user decides; actively-enforced controls are never
bypassed — see [`requirements.md`](requirements.md) REQ-014) handle known prohibitions, but
these categories warrant additional investigation before broader use.
For Japan specifically, the terms of 楽天, Amazon Japan, Yahoo! Japan, and Google
regarding automated read and update should be reviewed (see [`requirements.md`](requirements.md) §8, Automated access / scraping).

### 8.2 GDPR and Privacy Compliance Notes

`Soroeru`'s local-first, no-hosted-vault, no-telemetry design aligns with core GDPR
principles: data minimization, user ownership, and no third-party processing. However,
formal GDPR compliance requires additional investigation:

- **Right to be Forgotten**: the local vault can be deleted, but a mechanism to confirm
  complete deletion (including backups and any exported data) should be documented.
- **Data Controller responsibility**: when `Soroeru` is used by organizations, the
  responsibility boundaries for automated account actions need to be clarified.
- Legal applicability varies by jurisdiction. [`requirements.md`](requirements.md) §8
  defers legal nuances to this document; these investigation items are owned here and
  require separate implementation issues before work begins.

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
candidate-definition proposals, and `Soroeru` task creation for later review. MCP tools
must not expose raw personal values, credentials, card numbers, CVV, API keys, decrypted
vault exports, direct browser control, or submit/withdraw operations that skip
`Soroeru`'s own review-and-confirm gates.

All MCP calls should be logged in the encrypted vault with the tool name, time, requested
scope, and sanitized result summary. Logs must not include decrypted values.

## 11. Input And DOM Safety

Page DOM is untrusted input. Labels, placeholders, nearby text, option labels, URLs, and
attributes may be malformed, misleading, or adversarial.

- Render page-derived text as text, not raw HTML.
- Do not evaluate page-provided strings as code or selectors without validation.
- Keep raw page text out of persisted per-site records (store references + hashes).
- Validate stored data before use; never log decrypted values.
- Prompt instructions embedded in DOM are data, never authority. A bounded discovery engine may
  propose at most one same-site read-only navigation per step after schema, existence, budget,
  wall, and policy validation. GET is not sufficient: local policy rejects action-like
  routes/elements, permits only approved account-information page classes, and requires user
  confirmation for unknown non-action destinations. It receives no general browser or
  value-reading tool.
- Wall detection runs before sanitization and navigation. CAPTCHA, MFA/OTP, passkey, identity
  verification, bot detection, and rate limiting always pause for human hand-off; model output
  cannot override the pause.
- Site collection maps are encrypted local candidates. Evidence stores only map/page/entry
  references, hashes, timestamps, and outcomes—never HTML, screenshots, raw prompts, or values.
  Sharing requires explicit opt-in and separate sanitization and remains disabled until reviewed.

## 12. Dependency And Supply Chain

New runtime dependencies now include Playwright and a vetted Argon2id implementation.

- Add only dependencies with a clear purpose; commit the lockfile.
- Prefer small, actively maintained packages; avoid ones that phone home or process
  personal data remotely.
- Pin AI provider SDKs and verify model IDs against provider docs.
- Run the documented audit / update check when the toolchain supports it; document build /
  framework decisions in [`development.md`](development.md).

**Continuous detection (operation rules).** Dependency vulnerabilities are monitored
continuously by two layers: **Dependabot** (`.github/dependabot.yml`) opens update PRs
across all dependencies, and a **CI audit gate** (`SEC-003`, `npm run audit:check` =
`node scripts/audit-check.mjs`, a thin wrapper around
`npm audit --omit=dev --audit-level=high --json`, in `.github/workflows/ci.yml`) fails
builds on new high/critical advisories in the **production** surface (runtime + optional
deps). The gate is intentionally scoped to production deps, and the wrapper further
excludes only the specific advisory sources recorded in
[`scripts/accepted-advisories.json`](../scripts/accepted-advisories.json), so the accepted
build-time-only `devDependency` and unpatchable build-time-only `optionalDependency`
advisories below do not keep CI permanently red while any *new* advisory still fails the
gate. The reusable setup, threshold/scope rationale, acceptance flow, and triage steps
live in [`dependency-security.md`](dependency-security.md); the accepted advisories
themselves are recorded in §12.0 below.

### 12.0 Build-Time-Only Dependency Vulnerabilities (interim risk acceptance)

Some `devDependency` advisories cannot currently be cleanly fixed because they are
pulled transitively by the packaging toolchain (`@electron-forge/cli`, already at its
latest `7.11.2`). These chains run only during **build / packaging** (DMG generation on
a developer or CI machine) and are **not present in the distributed runtime**, which
ships only the compiled app, the runtime dependencies (currently `playwright` plus a
vetted Argon2id implementation, `hash-wasm`), Electron's embedded Node, and the packaged
Chromium.
They are therefore **not an end-user runtime attack surface**.

**Scope of the interim risk acceptance**

- **`tar` (high)** — via `@electron-forge/core-utils → @electron/rebuild →
  @electron/node-gyp → make-fetch-happen → cacache`. Advisories such as Hardlink Path
  Traversal / Symlink Poisoning / Arbitrary File Write / PAX smuggling
  (GHSA-34x7-hfp2-rc4v and others).
- **`tmp` (high) + `external-editor` / `@inquirer/editor` / `@inquirer/prompts` (low)**
  — via `@electron-forge/cli → @inquirer/prompts → @inquirer/editor → external-editor →
  tmp`. Advisories: arbitrary temp write via symlink `dir` (GHSA-52f5-9888-hmc6) and
  path traversal via unsanitized prefix/postfix (GHSA-ph9p-34f9-6g65).

**Premises that bound the risk**

1. **Build-time only / not shipped.** These packages execute only while building or
   packaging the app. The exploit preconditions (processing an attacker-controlled
   archive / temp path) do not occur in normal local DMG builds from this repository.
2. **No clean upstream fix today.** `@electron-forge/cli` is already at the latest
   `7.11.2`; the only `npm audit` "fix" it offers is a downgrade to `7.6.1`
   (semver-major regression), which is not a real fix. `npm audit` reports
   `fixAvailable: false` for both `tar` (vulnerable range `<=7.5.15`) and `tmp`
   (vulnerable range `<=0.2.5`).

**Override escalation — evaluated, NOT adopted (2026-06-29)**

Forcing patched versions via `overrides` (`tar: ^7.5.19`, `tmp: ^0.2.7`) was evaluated
and **rejected** for now:

- The override does **not** resolve cleanly. `npm install --package-lock-only` leaves
  `tar@6.2.1` and `tmp@0.0.33` marked **`invalid`** because `@electron/rebuild`,
  `@electron/node-gyp`, `cacache`, and `external-editor` pin the old major ranges
  (`tar@^6`, `tmp@^0.0.33`).
- A clean fix requires a **major** bump (tar 6→7, tmp 0.0→0.2). Those consumers call the
  old programmatic APIs, so forcing the new majors risks breaking native rebuild and
  **DMG packaging** (`npm run package:dmg`).
- Per the controlling Issue, an override is adopted **only if `npm run package:dmg`
  succeeds with it**. That could not be safely verified in the working environment, so
  the override is **not applied**; we keep tracking + risk acceptance instead.

**Upstream tracking references**

- electron-forge: <https://github.com/electron/forge>
- `@electron/rebuild` (tar consumer): <https://github.com/electron/rebuild>
- `@electron/node-gyp`: <https://github.com/electron/node-gyp>
- Inquirer.js (`@inquirer/prompts` / `@inquirer/editor`):
  <https://github.com/SBoudrias/Inquirer.js>
- `node-tmp`: <https://github.com/raszi/node-tmp>

Re-evaluate when `@electron/rebuild` promotes `tar`, the inquirer chain drops `tmp`, or
`@electron-forge/cli` ships an updated transitive tree.

**Residual unresolved count (release-judgment input, honest record)**

This branch is stacked on #178 (`jsdom` removal), so the `undici` chain is already gone
here. Measured on this branch on **2026-06-29** (`npm audit`): **22 advisories total — 19
high, 3 low**, all build-time-only via the chains above. `npm audit` counts per package
node, not per advisory, so the 19 high are `tar` plus every `@electron-forge/*` /
`@electron` package that transitively depends on it (`@electron/rebuild`,
`@electron/node-gyp`, `make-fetch-happen`, `cacache`, the `@electron-forge/*` packages)
and `tmp`; the 3 low are `external-editor` / `@inquirer/editor` / `@inquirer/prompts`.
`npm audit --omit=dev` (production scope — the runtime `dependencies` `hash-wasm`,
`playwright`, `@anthropic-ai/sdk`, `yaml`, plus `optionalDependencies`) reported **0
vulnerabilities** on that date. `npm audit` audits the resolved dependency tree recorded
in `package-lock.json`, not only what the current OS actually installs, so this held
regardless of the CI runner's OS; it changed only because no advisory existed yet for
`image-size` (see below) — not because `appdmg` was out of audit scope on non-macOS
runners. Counts shift with upstream updates; re-check at release time.

**Optional dependency: `image-size` via `appdmg` (interim risk acceptance, added
2026-08-26)**

- **Advisories** — `image-size` (high, both apply to every published release):
  - GHSA-w3rx-r6r6-pgpr: ICNS parser allows denial of service through an infinite loop.
  - GHSA-5p2g-fcmc-qvqq: JXL and HEIF parsers allow denial of service through infinite
    loops.
- **Dependency path** — `appdmg` (`optionalDependencies`, `^0.6.6`, `os: darwin`) →
  `image-size@0.7.5`. `appdmg` is the DMG-packaging backend invoked only by
  `npm run package:dmg`; it is never imported by the shipped Electron app or its
  runtime.
- **No clean fix today.** Both advisories' vulnerable range is `<=2.0.2`, i.e. every
  published `image-size` version through the current latest (`2.0.2`) is in range —
  there is no patched release to move to. `npm audit`'s own `fixAvailable` suggests
  downgrading to `appdmg@0.1.0`, a pre-2015, far older major that is not a real fix.
- **Why bounded.** Same premises as the `devDependency` chains above: build-time-only
  (`npm run package:dmg`), not present in the distributed runtime, and additionally
  `os`-restricted to `darwin` so it never installs on non-macOS machines at all — the
  advisory only has a chance to matter on a maintainer's own Mac while packaging a DMG
  from this repository's own source, not from any attacker-controlled input.
- **Enforcement.** Recorded by advisory `source` id in
  [`scripts/accepted-advisories.json`](../scripts/accepted-advisories.json), which
  `scripts/audit-check.mjs` (the `audit:check` implementation) reads to exclude exactly
  these two advisory ids from the gate; any other new high/critical advisory still fails
  it.
- **Re-evaluate** when `image-size` ships a release outside the `<=2.0.2` vulnerable
  range, or `appdmg`/its DMG-maker chain drops the dependency.
- Upstream tracking: <https://github.com/image-size/image-size>,
  <https://github.com/LinusU/node-appdmg>.

### 12.1 Mac Beta Artifact Safety

The Mac private-beta artifact is generated locally by `npm run package:dmg` and written to
`release/` (gitignored), with Forge intermediate output under `out/` (gitignored). It
bundles compiled application code, installed npm dependencies, Electron's embedded Node
runtime, and the packaged Playwright Chromium browser, but must not bundle:

- encrypted vault files from `state/` or `~/Library/Application Support/Soroeru`;
- `.env`, API keys, passphrases, recovery keys, browser sessions, or cookies;
- local AI review output under `state/ai-reviews/`;
- screenshots, logs, diagnostics, or support bundles containing raw personal values.

The packaged app stores beta data under the user's Soroeru app-support directory. Logs
must remain operational only; never log decrypted profile values, credentials, card data,
CVV, API keys, or raw AI prompts.

The first beta DMG is allowed to be unsigned / not notarized only for the invited
10-user private beta, and release notes must say so. Wider distribution requires a
separate signing/notarization issue and a repeat of the security checklist below.

**Chrome extension production front door (decision #391; migration from prototype #340):**
The DMG bundles the
self-contained native-host relay bundle at
`Soroeru.app/Contents/Resources/native-host/host.cjs` (`npm run build:host`). The bridge
remains feature-flagged during parity work; production cutover requires a self-contained helper,
Chrome Web Store stable ID, version negotiation, explicit tab-binding UX, and signed/notarized
distribution beyond invited beta. Manifest registration is always user-initiated — the app
copies the bundled file to app-support and registers
`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/jp.soroeru.bridge.json`,
as per the design (`docs/design/issue-291-chrome-extension-bridge.md` §3.3). Before
distributing a DMG, confirm:

- [ ] The host bundle is built and lands in the DMG at
      `Soroeru.app/Contents/Resources/native-host/host.cjs` (`npm run package:dmg`).
- [ ] Extension and native-host code never log or persist raw values, cookies,
      handshake tokens, snapshots, or credentials. `npm run poc -- check-egress` and
      `npm run poc -- check-persistence` scan `extension/` and `native-host/`; the only
      allowed native-host writes are the manifest and the per-launch handshake token
      (`// persist: native-host-registration`), neither of which contains personal values.
- [ ] The DMG contains no browser profile, cookies, vault data, logs, or real data
      alongside the host bundle (spot-check per `docs/manual-test.md` §0.3).
- [ ] The installed manifest and host copy do not remain after disconnect/uninstall
      (`docs/manual-test.md` §0.2–0.3 cleanup verification).
- [ ] The manifest's `path` field points at the app-support copy, never into
      `Soroeru.app`, so App Translocation and user `.app` relocation cannot break or
      redirect it (design §3.3).
- [ ] One explicit tab and exact HTTPS origin are bound; permission and binding are separate,
      memory-only grants, and badge plus in-page banner remain visible while active.
- [ ] Every bridge command carries the current lease/epoch and uses the closed command schema;
      arbitrary script/DOM evaluation, raw HTML, screenshots, downloads, and unrestricted
      navigation remain impossible.
- [ ] The app-bundled native helper is treated as a trusted, minimal local transport because it
      sees plaintext messages in memory. It is authenticated to the app/extension endpoints and
      has no vault/provider access, network client, payload interpretation, persistence, durable
      queue, or logs; installed-binary integrity and cleanup are release-verified.
- [ ] Extension/content/helper payloads may contain raw values only transiently for the local
      read/fill operation that needs them; they are never logged, persisted, included in
      diagnostics, or forwarded to AI. The extension contains no vault, provider key, canonical
      profile, or durable collection-map state.
- [ ] Disconnect, tab close, permission removal, vault lock, browser/extension restart, and
      out-of-scope navigation invalidate the lease and require explicit rebind; none triggers a
      silent Playwright fallback.

### 12.2 Local Diagnostics And Support Bundles

Diagnostics are local-only and telemetry-free. `DiagnosticEvent` records are stored in
the encrypted vault because even sanitized app lifecycle, flow-state, error, wall, or
site-activity summaries can reveal sensitive behavior. They must not contain raw profile
values, API keys, passphrases, recovery keys, AI prompts, cookies, browser sessions,
screenshots, Playwright traces, or decrypted vault bytes.

Plain operational logs are allowed only for startup/build/runtime failures that may happen
before the vault is unlocked. They live under the app-support diagnostics directory
(`~/Library/Application Support/Soroeru/logs/` on macOS, or the `SOROERU_STATE_ROOT`
override in development), carry sanitized operational categories rather than user activity,
and rotate by size/count (MVP target: 1 MiB per file, 5 retained files). Activity-level
site diagnostics stay in encrypted `DiagnosticEvent` records, not plaintext logs.

Support bundles are generated only after explicit user confirmation in the local Web UI.
`exportSupportBundleJson()` returns a redacted JSON summary with app version, OS/runtime
versions, recent sanitized diagnostic events, and optional sanitized operational-log
excerpts. It is never uploaded automatically and must not be pasted into public issues if
it contains sensitive site/activity context.

## 13. Security Checklist

Before distributing a Mac private beta, run the consolidated production privacy/security
gate:

```bash
npm run release:check
```

`release:check` runs typecheck, the unit test suite, the three static hardening gates
that protect the beta boundary, and the dependency-audit gate:

- `npm run poc -- check-egress` — network egress annotations plus telemetry /
  analytics dependency denylist (PRIV-001, §6)
- `npm run poc -- check-persistence` — local-write annotations, limiting persistence to
  encrypted store/export, masked measurement output, and the unencrypted-by-design app
  diagnostics log (PRIV-002, §3)
- `npm run poc -- check-bypass` — CAPTCHA-solving / anti-bot / fingerprint-evasion
  dependency denylist (SEC-002, §7)
- `npm run audit:check` — production dependency audit gate (SEC-003,
  `npm audit --omit=dev --audit-level=high`), the same command CI runs; shares its
  threshold/scope so local and CI never drift (§12, [`dependency-security.md`](dependency-security.md)).
  Requires registry access; see [`development.md`](development.md) §8.1 for the offline
  note and the rationale for keeping it in the release gate rather than per-commit.

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
- [ ] Detected automation-prohibiting ToS clauses are surfaced as a Constraint for the user to decide (never silently blocked, never bypassing actively-enforced controls)
- [ ] CAPTCHA, MFA, bot detection, and access controls are detected and handed off, never bypassed
- [ ] No CAPTCHA-solving / anti-bot / fingerprint-evasion dependency is present (`npm run poc -- check-bypass`, SEC-002 §7)
- [ ] Mac beta artifacts exclude vault data, secrets, browser sessions, local logs, and support bundles
- [ ] Support bundles are user-initiated, local-only, redacted, and exclude raw values, vault bytes, API keys, prompts, cookies, screenshots, and traces
- [ ] Signing/notarization status is documented before distributing a Mac beta DMG
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

## 14. Identity Verification (My Number / JPKI)

Canonical identity is anchored in the user's own public personal authentication
(マイナンバーカード / JPKI). Requirement and product rationale: [`requirements.md`](requirements.md)
§4.2 and Issue #218. This section owns the security, privacy, and legal handling.

**Authentication mechanism — デジタル庁「デジタル認証アプリ」 (認証API).** Soroeru does not read
the card itself or act as a signature verifier. It integrates as a **relying party** with the
Digital Agency's **デジタル認証アプリ** service (OIDC / OAuth 2.0 authorization-code flow). The
card is read on the **user's smartphone** by the Digital Agency app; from the desktop the user
links via a **QR code (cross-device)**. Soroeru uses the **認証 (authentication) API only** — not
the 署名 (signature) API. Basic-4 attributes (name, address, DOB, sex) are returned via the
**UserInfo endpoint + requested scope** (with the 券面事項入力補助 PIN entered in the Digital
Agency app, never in Soroeru); the ID token carries `sub` = a **PPID (pairwise pseudonymous
identifier)**.

**Non-negotiable handling rules:**

- **Never store the 12-digit My Number (個人番号).** Basic-4 attributes are obtained through the
  authentication flow and do not include the number. Storing or retaining the number for
  identity-management purposes is outside the 番号法's permitted uses and is prohibited.
- **The card PIN is never seen by Soroeru.** It is entered in the Digital Agency app on the
  user's phone. Soroeru handles OIDC tokens, not the PIN; tokens and the PPID are never logged.
- **Store only**: the basic-4 attributes (encrypted at rest, like other Personal Attributes),
  the PPID, and **verification Evidence** — the Digital Agency verification reference and
  timestamp. Do not retain raw tokens beyond the flow.
- **Derived fields** (kana, romaji) are stored as **unverified** and clearly distinguished from
  the verified basic-4; they are never presented as JPKI-verified.
- **Phone / email**: ownership is verified by an OTP round-trip; the OTP is never logged. At most
  3 of each are stored. Removing a verified contact is Soroeru-internal data deletion — the
  fourth absolute boundary (always confirmed).

**Connection architecture (decided: "A — central, OSS, zero-retention BFF", Issue #218).** The
デジタル認証アプリ integration **effectively requires a server-side BFF** (registered client ID,
redirect / back-channel logout URIs, private_key_jwt); a pure local public client is not reliably
supported. Of the options — (A) a Soroeru-operated registered relying party, (B) each user
self-hosting (impractical: registration is per-business), (C) a commercial intermediary (a third
party would see basic-4) — **A** is adopted. This is a **deliberate, narrowly-scoped exception to
the no-backend principle**, limited to the identity-authentication broker:

- The BFF is **OSS and reproducibly deployable** (inspectable / self-hostable).
- **Stateless / zero-retention**: basic-4, tokens, PPID, and PIN are **never persisted** by the
  operator; obtained basic-4 is **forwarded encrypted to the user's device and immediately
  discarded** server-side.
- **Egress is to the Digital Agency service only** (plus the return channel to the user's
  device). No telemetry, analytics, or raw-PII logging.
- **"No hosted vault" is unchanged**: the canonical encrypted store stays local on the user's
  device. Only a minimal auth-broker backend is introduced, for the identity layer only.

**Assurance level.** Verification is **mediated by the Digital Agency's 公的個人認証 service** (the
Digital Agency operates the verifier); Soroeru does not need 署名検証者 status and does not rely on
local-only signature validation. **No desktop NFC / IC card reader is required** — the card is read
on the user's smartphone, with QR cross-device linking from the desktop.

**Residual / investigation items (recorded, not resolved):**

- Identity onboarding is **Japan-resident, card-holder-with-smartphone only**; no fallback path in
  v1. The user must have the Digital Agency app installed.
- **Operator-trust dependency**: even with zero-retention, basic-4 transits the Soroeru-operated
  BFF during the flow. The design must minimize and document this; trust rests on the OSS,
  reproducible deployment.
- **事業者申請** (relying-party registration with the Digital Agency — client ID, redirect /
  back-channel logout URIs, private_key_jwt key management) and its eligibility / operational
  obligations must be completed before launch.
- The **site-side trust benefit** (relying parties treating Soroeru sign-ups as identity-verified)
  remains deferred (Issue #218).
- For regulated industries, Soroeru-mediated verification is **not** a recognized 犯収法 eKYC
  method; any future site-side claim must be designed to the applicable standard separately.
