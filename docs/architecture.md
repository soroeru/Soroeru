# Architecture

Soroeru uses a Chrome MV3 extension as its client and Google Cloud for shared
form knowledge and Gemini assistance. The split minimizes installation and
repeated form discovery while preserving a useful local ledger. Product choices
are owned by [requirements](requirements.md); permitted data and retention by
[security](security.md). This document records durable architecture, not Issue histories.

## Implementation status

The repository already contains the Side Panel vault and Visibility host,
worker-managed leases, direct panel/content messages, Tier 1 schema lookup/cache,
Tier 2 structure mapping and the Cloud foundation. Relevant entry points are
`extension/sidepanel.tsx`, `extension/panel/visibility-host.ts`,
`extension/resolution-orchestrator.ts`, `src/store/vault-session.ts`,
`src/shared/cloud-contract.ts` and `cloud/src/server.ts`.

Tier 3 inference/consent UI, delivered telemetry, schema feedback promotion,
queue delivery, full settings, complete vault migration and the remaining desktop
screens are not complete. Their API contracts/infrastructure may exist while the
handler still returns `503 unavailable`. Target behavior below is not evidence of
implementation. Run-scoped consent and simplified L1/identity requirements are
new policy work; existing code does not gain that authority from this document.

## Components and trust boundaries

```text
Chrome Side Panel: UI + VaultSession + DomainService + resolution + approvals
  | direct bounded page commands/results
Content script: leased DOM scan/read/fill, local validation and secret masking
  | lease lifecycle only
Service worker: permission, injection, tab/origin/epoch lease, event routing

Side Panel <-> IndexedDB: Vault v2 ciphertext
Side Panel -> Cloud Run API: schemas, structure mapping, typed feedback/outcomes
Side Panel -> separate Cloud Run fallback: consented minimal read region
Cloud Run API -> Firestore: schemas, budgets, validation counters
Cloud Run API -> BigQuery: fixed-schema outcomes (target)
Cloud Run services -> Gemini on Vertex AI: permitted inference payloads
```

| Component | Responsibility and boundary |
| --- | --- |
| Side Panel | Holds unlocked key, domain state, approvals, Cloud client and user gates; destroys live secrets on close |
| Service worker | Owns leases and injection; no vault keys, page bodies or personal values |
| Content script | Checks tab/origin/epoch on every command, treats page as untrusted data, returns values directly to the panel; no Cloud calls or vault access |
| Domain/store | Keeps canonical attributes, accounts, disclosures, policy and Evidence independent of UI/browser transport |
| Cloud API | Validates closed contracts, enforces budgets, resolves schemas and structure mappings; no personal-value storage |
| PII fallback service | Target read-only inference boundary, isolated service account, no Firestore/BigQuery permissions or body persistence |

Use one explicitly selected tab. Request HTTPS origin access through a user
action; release never closes the user's tab. Lease metadata may use
`chrome.storage.session` (ID, tab, origin, epoch only). Navigation, disconnect,
permission removal and worker restart invalidate stale commands; rebind explicitly.
A lease is not permission to mutate a site. `PageDriver` and the domain policy
layer separate observation, approved local credential filling and consequential
operations. Never export Chrome cookies, local storage, history or profiles.

The Side Panel holds the runtime because a suspended MV3 worker loses globals.
An offscreen host cannot show decisions; serializing keys into session storage
would broaden key access. If panel lifetime cannot support collection, revisit
checkpoint UX before changing the key/approval boundary.

## Stack and persistence

| Choice | Reason and reconsideration trigger |
| --- | --- |
| TypeScript, React, Vite, npm | Reuse typed domain/UI components and locked dependencies; avoid a new framework during migration |
| Web Crypto + hash-wasm | Portable Vault v2 cryptography shared with the desktop source; no Node imports in portable vault modules |
| IndexedDB + exclusive Web Lock | Transactional ciphertext replacement and one writer across panels; prefer this to hand-built OPFS atomicity or large `chrome.storage.local` values |
| Cloud Run, Node 22, node:http | Small independent `cloud/` package with bounded JSON APIs; no service credentials in the extension |
| Firestore / BigQuery / Vertex AI | Versioned shared form registry / typed aggregate outcomes / Gemini inference; reconsider costs and abuse protection before broad distribution |
| Node test runner + Playwright for development | Exercise domain contracts and real browser fixtures; Playwright is not the target production driver |

Vault v2 stores a versioned header and independently encrypted record envelopes.
`VaultPersistence.load/save/clear` separates IndexedDB from the retained file
backend. A save replaces the entire encrypted document in one transaction and
succeeds only after commit. On quota, interrupted transaction or corrupt/newer
format, surface an error and preserve the previous document; never silently
initialize over unreadable data. Validate record schema versions before migration.
Encrypted export uses the same format; an import must validate and confirm any
replacement before committing. Complete import/migration UX remains future work.

`VaultSession` keeps a non-extractable master `CryptoKey` only in panel memory;
`navigator.locks` prevents a second writer. Lock saves first; failure leaves the
panel unlocked so the user can retry/export. Panel close drops live state and
makes only a best-effort pending save; browser termination may interrupt it.
`unlimitedStorage` and a persistence request reduce eviction risk, but extension
removal or browser-data clearing can still destroy local data. Offer encrypted
backup after creation and periodically after changes; a recovery key cannot
restore an erased ciphertext file.

Account credentials are distinct from Disclosure observations. Canonical values
carry provenance/verification status; normalization supports comparison but does
not turn masked or ambiguous values into known ones. Store collected values only
in encrypted domain records. Evidence references those records with minimized
hashes, timestamps and outcome codes; it is not a second raw-value store.

## Resolution and validation

1. **Tier 1**: resolve `{site, pageFingerprint, clientVersion}` with the API.
   Validate an active schema against the live structural fingerprint, unique
   positional/scanner anchors, known attribute keys and the local classifier.
   A mismatched field alone stays unresolved. Read/fill accepted fields locally;
   schemas never authorize submission.
2. **Tier 2**: for unresolved fields, send a sanitized `StructureSnapshot`.
   Only known structural tokens and exact label/heading vocabulary survive;
   unknown prose, field/display values, options and selection state are omitted.
   Value shape is allowed only for locally classified non-secret input fields.
   The server and client reject extra keys, unknown item IDs, conflicting mappings,
   executable instructions, URLs and selectors. Revalidate on the live page.
3. **Tier 3 (target)**: only after a valid Tier 2 result leaves a required read
   unresolved. The panel obtains the scoped consent defined in requirements.
   A wall or Tier 2 transport/validation failure hands off instead of escalating.
   Capture only the unresolved region, mask secrets in the content script before
   crossing its boundary, recheck in the panel, enforce 16 KiB and send to the
   isolated fallback endpoint. Ambiguous secret-like items are omitted.

Every proposed value must match its own captured item and observation; another
value elsewhere on the page is not corroboration. Require whole-value matching
for fields/display items and a complete bounded value span for text blocks.
Permit NFC, line-ending normalization and outer whitespace trimming; remove
ASCII spaces/hyphens only for locally classified phone/card values. Do not expand
masked PANs, synthesize digits or store a model's unobserved representation.
Reject contradictory local metadata, unknown keys, My Number and card PIN before
persistence. Store observed values, not arbitrary model text. Save an accepted
Tier 3 group atomically, and discard responses after navigation, lease change,
lock, cancellation or scope expiry.

For multi-page collection, follow observed, locally validated read-only links
within the bound site's scope. Reject mutation, download, logout, purchase and
attestation routes even when encoded in path/query text. Do not infer site scope
by dropping hostname labels. Set page/depth/time/call budgets before execution;
exhaustion produces partial results, never an unbounded retry. Existing local
collection maps are encrypted hints and are revalidated per field; stale entries
cannot authorize broader navigation. Do not port obsolete browser-session exports.

## Cloud contracts and operation

`src/shared/cloud-contract.ts` owns request/response validators shared by extension
and server. JSON contracts reject unknown fields and bound body/response sizes.
All data APIs use POST, avoiding site names in URL queries.

| Endpoint | Role / current state |
| --- | --- |
| `/v1/schemas/resolve` | Active schema lookup implemented |
| `/v1/agent/map-structure` | Structure mapping implemented when a Gemini model is configured |
| `/v1/agent/tier3-ticket` | Budgeted, signed payload-bound ticket foundation implemented |
| `/v1/agent/read-with-consent` | Isolated fallback contract; inference/consent integration pending |
| `/v1/schemas/feedback` | Contract; delivery/aggregation pending |
| `/v1/telemetry/outcome` | Contract; BigQuery ingestion pending |

Default region is `asia-northeast1`. Cloud Run uses attached service accounts;
GitHub deploy uses OIDC, not exported service-account keys. API callers are
anonymous: an embedded extension credential would be public. Per-instance IP
buckets, instance/concurrency caps and a transactional Firestore daily Gemini
budget bound abuse. IP limits weaken across instances and restart; billing
alerts notify but do not cap spending. Reassess gateway/edge quotas if anonymous
traffic exhausts legitimate users' budget.

Each Tier 3 request has its own five-minute HMAC ticket bound to site, consent ID
and exact payload SHA-256. Fallback runs with one instance and an in-memory used
nonce set; a restart can permit replay of the same still-valid payload. Run-scoped
approval does not make tickets reusable: each retry needs a fresh ticket and
budget debit, and the local approval tracks the total request count. Consent is
client-enforced; the server cannot prove a human approved an anonymous request.

Gemini receives stateless requests. Project implicit caching and model request/
response logging are disabled and checked before inference; unreadable settings
fail closed. Cloud logging exclusions and body-free application logs are release
checks, not guarantees about all Google infrastructure processing.

## Shared schema lifecycle and offline behavior

Schemas contain domains, structural hashes, positional anchors, enum attribute
keys, versions, confidence, provenance, status and validation counts. They contain
no personal values. Maintainer seed import is implemented; automatic promotion
below is target work. Reimporting an identical seed is idempotent; changing it
requires a higher version.

Candidate promotion defaults: at least three distinct validators, at least five
validations, at least 90% success over the latest up-to-ten validations and fewer
than three failures in that window. Retire candidates after 30 days without
promotion, and retire active schemas when that failure window fails or a newer
version becomes active. High-risk identity/card mappings require a reviewed
`official` seed. Revalidate all schemas locally even after promotion: validators
can be fabricated and a shared schema grants no authority.

Count validators with a per-site HMAC of a vault-held random key and a second
server-side HMAC; never place that token in BigQuery. Only Tier 1/2 outcomes can
feed schema learning. Sharing off disables feedback and clears pending entries.

Cache schemas encrypted because their domains reveal the user's site set. Offline
or assistance-off mode uses active schemas fetched less than 30 days ago and
local deterministic resolution; a live `none` response does not revive stale
cache data. Current resolution also rejects confidence below 0.8. Unknown fields
remain unknown; Cloud-dependent accuracy is not an offline parity requirement.

Target queues store only validated feedback/outcome payloads encrypted, with
idempotency keys, at most 100 entries and at most three exponential-backoff retries;
drop the oldest at capacity. Tier 3 bodies are never queued. Checkpoints contain
stage and unresolved attribute keys, not values or reusable approval. Resume
requires unlock, rebind and fresh validation. A failed checkpoint save produces a
visible interruption and restarts resolution next time; it does not resume a
half-approved operation.

## Migration boundary

Electron, Native Messaging and production Playwright remain migration sources,
not the extension's required runtime. The Side Panel demo runs without a native
host. Keep the old encrypted Vault v2 format readable and verify export/import
before retiring the desktop entry point. Legacy encrypted `sessionState` is not
imported into Chrome's authenticated profile. Desktop-only APIs, provider settings
and browser binaries must leave the production path at cutover.

Until then, the legacy Electron Visibility path may send non-secret page values
to the user's configured AI provider; other legacy AI uses stay structure-only.
It is not the extension's three-tier consent model. Password/CVV masking and
local deterministic filling apply to both. Old code remains inspectable in Git;
new product decisions and release claims must describe the extension path.
