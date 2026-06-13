# Security

This document owns **security and privacy decisions** for `autofill`: principles, threat
model, sensitive data handling, encryption, AI-disclosure policy, wall safety boundaries,
DOM input safety, and dependency policy.

Canonical product direction is
[`rfc-001-chrome-autofill-pivot.md`](rfc/rfc-001-chrome-autofill-pivot.md) (RFC-001 v3,
see §6 / §9 / §10 / §10b). Requirement-level statements live in
[`requirements.md`](requirements.md) §7.

> **Direction change (2026-06-12).** `autofill` now stores the user's **full** personal
> data — including credit card data (with CVV) and per-site credentials — locally and
> **encrypted**, and registers / updates accounts on the user's behalf. The previous
> "do not store passwords or cards" and "never auto-submit" rules are replaced. The
> hard line that remains is: **never bypass CAPTCHA / MFA / bot detection / access
> controls.**

## 1. Security Principles

- Keep all personal data local and **encrypted at rest**; the user owns it.
- Network egress is limited to **(a) the target sites the user asks the agent to act on**
  (the agent navigates, fills, and submits there) and **(b) the user's configured AI
  provider** (form structure / terms text only, never raw personal values). No telemetry,
  analytics, crash reporting, cloud sync, or any other destination.
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
- per-site records (references + hashes, not duplicated raw values) and mandates.

Never stored:

- raw personal values in per-site records (use references + hashes for diffing);
- decrypted values in logs, error messages, or crash reports;
- real personal data in tests, fixtures, docs, or screenshots (use fake values).

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

The PoC reference implementation of this scheme is `poc/autofill-agent/src/store/`
(`crypto.ts` + `store.ts`); the AI provider API key and model settings are persisted as an
encrypted record in the same store, and the most-sensitive field (CVV) is kept out of the
shared transform view and read only through a sanctioned fill-time accessor.

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
- **Recovery unlock**: `PocStore.openWithRecoveryKey()` / `AutofillApp.unlockWithRecoveryKey()`
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

## 5. AI Provider Disclosure Policy

- Send the model **form structure and terms text**, not raw personal values. The model
  returns a mapping plan / high-risk findings; the automation layer fills values locally.
- Use only the user's configured provider: Anthropic (Opus / Sonnet / Haiku) or OpenAI
  (GPT-5.4 / 5.4-mini / 5.3-Codex), via a provider-abstraction layer.
- Use stateless requests; do not enable prompt caching of PII, stored threads, or memory.
  Prefer zero-retention / no-training options where the provider offers them.
- The model itself does not learn from inference and the context window is per-request;
  the residual risk is provider-side request logging and any stateful feature you enable
  — this policy avoids the latter and minimizes the former.

## 6. Network And External Services

Allowed external destinations are limited to: (a) the **target sites** the user asks the
agent to register or update on (normal browser navigation and form submission), and
(b) the user's **configured AI provider** (form structure / terms text only). No
telemetry, analytics, crash reporting, cloud sync, or remote classification to any other
service. The user's data store is never uploaded anywhere. Adding any other destination
requires an explicit issue updating requirements, this document, and the user-facing docs.

**Static enforcement (PRIV-001 / #20)**: `npm run poc -- check-egress`
(`poc/autofill-agent/src/dev/egress-check.ts`, tested by
`tests/unit/autofill-poc-egress.test.ts`) scans
`poc/autofill-agent/{src,run}/**/*.ts` for network-call sites and fails unless each one
carries a `// egress: target-site` or `// egress: ai-provider` annotation, and fails if
`package.json` gains a dependency matching a telemetry/analytics denylist (Sentry,
Segment, Datadog, etc.). `poc/autofill-agent/sites/` (the local 127.0.0.1-only PoC
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
and the agent resumes from where it paused.

## 8. Registration Safety Boundaries

- Submit only after the user approves the post-analysis review-and-confirm gate.
- Apply the three guards: high-risk clause escalation; payment-field stop (except
  free-trial→subscription approved by the user); no auto-attestation of eligibility /
  identity statements.
- Record a per-registration mandate (references, hashes, terms URL / version) for audit.

## 9. Input And DOM Safety

Page DOM is untrusted input. Labels, placeholders, nearby text, option labels, URLs, and
attributes may be malformed, misleading, or adversarial.

- Render page-derived text as text, not raw HTML.
- Do not evaluate page-provided strings as code or selectors without validation.
- Keep raw page text out of persisted per-site records (store references + hashes).
- Validate stored data before use; never log decrypted values.

## 10. Dependency And Supply Chain

New runtime dependencies now include Playwright and a vetted Argon2id implementation.

- Add only dependencies with a clear purpose; commit the lockfile.
- Prefer small, actively maintained packages; avoid ones that phone home or process
  personal data remotely.
- Pin AI provider SDKs and verify model IDs against provider docs.
- Run the documented audit / update check when the toolchain supports it; document build /
  framework decisions in [`development.md`](development.md).

## 11. Security Checklist

- [ ] Secrets are not committed; local state and logs are Git-ignored
- [ ] Fixtures, screenshots, tests, and docs use fake data only
- [ ] Personal data, card data (incl. CVV), credentials, and the API key are encrypted at rest
- [ ] The derived key lives in memory only; decrypted values are never logged
- [ ] Raw personal values are not sent to the AI model; no provider stateful features used
- [ ] No network egress except to the target sites the user acts on and the configured AI provider; no telemetry; data store never uploaded (`npm run poc -- check-egress`)
- [ ] Registrations submit only after the review-and-confirm gate; three guards applied
- [ ] Auto-creation-prohibited sites are fill-only
- [ ] CAPTCHA, MFA, bot detection, and access controls are detected and handed off, never bypassed
- [ ] Security-sensitive behavior is tested or manually verified
