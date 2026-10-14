# Security and privacy

Security supports a useful, low-friction experience: prevent concrete losses,
unexpected disclosure, charges and deletion without asking the same question
repeatedly. [Requirements](requirements.md) owns when the user decides;
[architecture](architecture.md) owns component/data-flow design. This document
owns data handling and release controls. Target policy is not an assertion that
pending consent, telemetry or migration features are implemented.

## Data handling

| Data | Local handling | Permitted external handling |
| --- | --- | --- |
| Secrets: passwords, CVV, vault/recovery keys, OTP, tokens, cookies, API keys | Password/CVV records encrypted; keys in memory; no secret logs | Only the secret's intended authentication/form destination; never any AI, shared schema or telemetry |
| Personal values: name, address, contact, account ID, card number/expiry | Encrypted vault, transient memory for collection/fill | Target site for an approved operation; Gemini only for the scoped Tier 3 read |
| Page content potentially containing personal values | Transient observation, no raw page archive | Only minimal secret-masked Tier 3 regions after consent |
| Sanitized structure and Form Schemas | Encrypted site-specific cache | Cloud schema registry and structure-only Gemini mapping |
| Typed outcomes | Minimized local Evidence; encrypted pending queue | Fixed-schema improvement telemetry when sharing is enabled |
| Approval events | Encrypted scope/time/outcome/hash records | No raw approval record upload |
| Per-site validator token | Secret random key encrypted locally | Schema feedback only; server HMAC storage, no BigQuery or cross-site identifier |

Never store the 12-digit My Number or card PIN, including under a mislabeled
attribute. Canonical and site-observed CVV may remain encrypted in the vault, but
reveal is refused and deterministic local code reads them only at fill/collection
time. Site passwords are filled locally, never through a model. The browser owns
its authenticated session; the extension does not export cookies or profile data.

Tier 2 uses a positive structural vocabulary, not only personal-value regexes.
For Tier 3, mask secret inputs and display text by element metadata, nearby labels
and local classification; omit ambiguous secret-like items. Recheck in the panel
before sending. No consent authorizes sending secrets to a model. A model result
must corroborate locally before becoming a Disclosure.

## Consent and useful defaults

Target Tier 3 consent may cover one named run, bounded to exact sites, page kinds,
attribute kinds, 20 requests and 15 minutes, or just the current fallback.
This replaces repeated per-region approvals without granting cross-run access.
A visible stop control revokes remaining authority. Scope expansion, interruption
and wall hand-off end approval. Each request still has its own validated snapshot
and single-use ticket. A transport/5xx retry may occur once under the same active
scope and consumes the request budget; rate limits and budget exhaustion do not
retry. Requirements owns the full user-facing decision flow.

Cloud assistance and improvement sharing default off. Setup explains each once;
turning assistance on does not turn sharing or personal-content reads on. The
same defaults apply to development demonstrations and production. Remove the
previous extra release-time default-decision gate and special judging-build
notice. These choices avoid recurring prompts while keeping a usable local path.

Identity verification is optional for local Visibility and canonical data entry.
Record verified vs user-entered provenance and clear verification after edits;
never represent unverified input as an identity attestation. A future identity
provider/BFF needs a separate integration Issue with its exact data/retention
boundary; it is not a currently approved general-purpose egress path.

## Encryption and durability

Vault v2 uses AES-256-GCM with a fresh 96-bit nonce per record. The default KDF is
Argon2id with a random 16-byte salt, 64 MiB memory, three iterations and one lane.
PBKDF2-HMAC-SHA-512 at 600,000 iterations is an explicit compatibility path, not
silent downgrade. `src/store/crypto.ts` owns executable parameters.

Passphrases are not stored. Derived master keys are non-extractable in an unlocked
Side Panel and never serialized into extension storage. Setup may derive a
short-lived extractable copy solely to wrap it with the locally generated
256-bit recovery key; do not persist that raw copy. Recovery material is shown
once and stored only as a wrapped master key. Passphrase change invalidates the
old recovery wrap and requires a replacement recovery key.

IndexedDB contains ciphertext only and remains the only extension vault store.
Authentication/format errors fail closed, without replacing a corrupt vault with
an empty one. Transactional saves and a single-writer Web Lock prevent
partial/concurrent overwrite. Export is an explicit encrypted file chosen by the
user, not cloud sync and not a second primary copy. Import validates the exact
Vault v2 document before replacing data and requires confirmation for overwrite.
A lost passphrase without recovery prevents decryption; a recovery key does not
recover erased browser storage. Backups, save-error visibility and lock/close
semantics are specified in architecture.

Ordinary ledger values may be visible while unlocked; sensitive password/card
reveals require reauthentication, and CVV reveal remains refused. Avoid repeated
reauthentication for non-sensitive local reading. Never log decrypted values,
plaintext CSV rows, raw page bodies, screenshots, prompts or model responses.

## Cloud retention and egress

Allowed product destinations are the bound target sites and the configured
Soroeru Cloud HTTPS origins. Gemini is called only by Cloud Run. Personal vault
sync, unrelated analytics and third-party crash reporting are not enabled by this
policy. The migration-only Electron provider exception is described in architecture.

Soroeru Cloud never persists Tier 3 request/response bodies or extracted values,
including in Firestore, BigQuery, logs, traces or schema learning. The fallback
service account has Vertex inference and narrowly scoped ticket-secret access,
not registry/telemetry access. Disable model request/response logging, traces that
capture bodies and context caching, including implicit Vertex caching. Check
settings at deployment and inference; inspection failure blocks inference.
This is an application retention policy, not a promise about Google's entire
infrastructure or contractual processing; review provider configuration/terms
before release without claiming zero retention beyond verified controls.

Cloud API logs contain enum error category and latency only. Exclude request/
system logs carrying IPs, paths or identifiers, and inspect all additional sinks.
Per-IP abuse buckets stay in memory. Do not store a user history to diagnose a
form failure. Prefer local status and typed aggregate failure counts.

Outcome telemetry accepts only: site ID, form/schema ID and version, operation
type, resolution tier, result, enum error category, confidence bucket, client
version, structural fingerprint and hour-truncated time. No values, labels, URL
paths, DOM, IP or client identifiers. Shared contract validation rejects unknown
keys and BigQuery has no free-text column. Domain/timing aggregates can still
reveal site usage trends; sharing remains optional and off clears pending queues.
Feedback shares only value-free mappings and a site-specific validator token;
turning sharing off stops both channels. Tier 3 results never train shared schemas.

Positional anchors, enum keys and structural hashes limit schema content.
Reject personal-value-like strings (email, telephone, postal/card identifiers,
long digit strings and token-like material) before writes; regexes alone are not
proof of anonymity. Schemas are untrusted proposals, revalidated locally.
Promotion thresholds and high-risk-field seed review belong to architecture.

## Site operation and interruption

Never bypass CAPTCHA, MFA, bot detection, rate limits, paywalls or access controls.
Hand off in the same browser session. Automation-prohibiting terms require an
informed user decision, not a legal conclusion by the agent. Public terms reading
and access to the user's own account do not grant permission to defeat a control.

AI has no general browser tool or authority to accept terms, fill secrets or
submit a consequential action. Validate observed elements, site scope, read-only
navigation, budgets and wall state locally. Page text is untrusted data, including
instructions that request secrets or broader access. Final deletion/withdrawal,
payment exceptions and identity attestation follow the requirements' explicit gates.

## Development and release checks

Use fake data for tests, fixtures, screenshots and documents. Debugging a real
user problem does not authorize publishing their values or account-domain list.
Local diagnostics should contain bounded codes/counts, not value-bearing exception
text. Support exports need preview and intentional sharing; do not upload local
state as CI artifacts.

Use locked dependencies, Dependabot and `npm run audit:check`; narrowly accepted
advisories live in `scripts/accepted-advisories.json` with scope and rationale.
Do not reproduce dated audit reports here. New dependencies, egress or hosting
need explicit Issue scope. Development-agent provider disclosure is separately
bounded by the orchestration skill and never grants access to product vault data.

Before releasing a changed data path:

- Run the applicable [development checks](development.md#quality-gates), including
  `release:check`, and fake-data failure-path tests.
- Verify both Cloud services' identities, log exclusions, cache/logging settings,
  instance limits and payload-bound ticket rejection after deployment.
- Verify off/decline/expiry/lock/wall paths prevent unauthorized sends and that
  stale responses cannot write values. Test pending features only after implementation.
- Inspect manifest permissions/CSP: no remote scripts, `unsafe-eval`, cookie,
  history or bookmark permissions. `wasm-unsafe-eval` exists only for the KDF.
- Verify backup/migration and save failures before removing the old entry point.
  Record evidence and remaining risks in the release Issue/PR, not a new report file.
