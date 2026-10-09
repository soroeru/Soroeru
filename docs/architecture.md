# Application Architecture

This document owns **`Soroeru` application architecture and technology selection**: the
Electron process/layer boundaries, the technology decisions and their rationale, the
domain model and its encrypted persistence mapping, the IPC trust boundary, the Slice A
(Visibility) design, wall hand-off, and the security/privacy mapping.

Canonical product direction is [`requirements.md`](requirements.md). This document is the
**canonical target architecture**.

Out of scope here: product requirements (see [`requirements.md`](requirements.md)),
setup and repository layout (see [`development.md`](development.md)), and security
rationale (see [`security.md`](security.md)).

## 1. Architecture Overview

`Soroeru` is a local **Electron** desktop app (macOS MVP) with a trusted main process, a
narrow typed IPC boundary, and an untrusted React renderer:

```text
Soroeru.app (Electron)
├── main process (trusted)
│   ├── VaultService (Vault v2)
│   │   ├── encrypted record vault
│   │   ├── unlock / lock / recovery / migration
│   │   └── in-memory indexes while unlocked
│   ├── DomainService
│   │   ├── Personal Attributes
│   │   ├── Site Accounts / Credentials
│   │   ├── Disclosures
│   │   ├── Account Relationships
│   │   ├── Mandates / Evidence / Audit
│   │   ├── Policy / Preference
│   │   ├── Delegation Boundary (Capability)
│   │   └── Reflection
│   ├── AutomationService (browser-neutral PageDriver)
│   │   ├── browser-extension tab lease (production front door)
│   │   ├── Visibility login / collection today (AI-driven full-page reads when AI is
│   │   │   configured, Issue #514 — §5.2; deterministic fallback otherwise); update /
│   │   │   withdraw / register later
│   │   └── wall detection -> hand-off -> resume
│   ├── BrowserTransport (versioned, authenticated local protocol)
│   │   └── native helper -> thin browser extension -> one user-selected tab
│   ├── DefinitionService (Agent layer, §7 below — Slices B-D only, not yet ported)
│   ├── AiAnalysisService (optional)
│   │   └── structure-only provider calls for every non-collection AI use (terms,
│   │       registration field mapping); Visibility collection's AI calls are §5.2's
│   │       separate full-page-read path, not this service
│   └── IpcApi (typed, narrow, allowlisted commands)
│
├── preload
│   └── contextBridge exposing typed Soroeru API only
│
└── renderer (untrusted UI surface, React + Vite)
    ├── vault setup / unlock (`VaultGate`)
    ├── CSV import under Settings (`CsvImportPanel` via `SettingsPanel`)
    ├── Visibility collection + saved-page import on the Disclosure ledger
      (`LedgerPanel`, `SavedPageImportPanel`, `SiteCollectionUi`)
    ├── Disclosure ledger spreadsheet, filters, and Reflection
      (`LedgerPanel`, `InsightsPanel`)
    └── review-and-confirm gates (later slices)
```

**Trust rule**: the renderer never receives broad filesystem, network, browser, or vault
authority. It calls typed IPC channels and receives redacted/sanitized views (masked
previews, counts, references) unless the user explicitly reveals a value through a
re-authenticated flow (§4).

Reference implementation:

- **Main process**: `electron/main.ts` (window + IPC registration + orderly teardown),
  `electron/session.ts` (`SoroeruSession` — the trusted owner of the Vault v2 lifecycle and
  `DomainService`), `electron/visibility-service.ts` (`VisibilityService` — Visibility run
  orchestration and wall hand-off broker), `electron/ipc/contract.ts` (the channel
  allowlist and payload shapes), `electron/ipc/bridge.ts` (wires `SoroeruSession` methods to
  IPC channels).
- **Preload**: `electron/preload.ts` / `electron/preload-api.ts` (the `contextBridge` typed
  API surface).
- **Renderer**: `src/renderer/` (React + Vite; `App.tsx` plus the panel components under
  `src/renderer/components/`).
- **Domain**: `src/domain/` (`domain-service.ts`, `entities.ts`, `csv-import.ts`,
  `ledger-insights.ts`, `normalize.ts`).
- **Store**: `src/store/` (`vault-v2.ts`, `crypto.ts`, `recovery.ts`; `vault.ts` for legacy
  v1 file-existence checks only).
- **Automation**: `src/automation/` (`page-driver.ts`, `extension-page-driver.ts`,
  `browser-engine.ts` during migration,
  `visibility-runner.ts`, `wall-detection.ts`, `disclosure-collector.ts`, `evidence.ts`,
  `saved-page-importer.ts`).
- **Agent (definition/classification helpers)**: `src/agent/` (`scan.ts`, `classifier.ts`,
  `walls.ts` are reused by the Visibility automation layer; `definitions.ts`,
  `official-definitions.ts`, `mapper.ts` belong to the not-yet-ported Slices B-D harness,
  §7).

Keep shared logic — field classification, wall detection, the store/crypto boundary, and
the provider abstraction — isolated so it can be tested outside a live browser and outside
Electron.

The MVP packaging target is a downloadable, unsigned macOS DMG for a small group of
invited beta users plus a Soroeru-owned Chrome extension. Chrome Web Store distribution,
a self-contained native helper, and signing/notarization are release gates for promoting
the extension path beyond developer validation. Windows, Linux, mobile, and additional
browser adapters are later (see [`requirements.md`](requirements.md) §9).

## 2. Technology Selection

Decisions below are requirements-derived (see [`requirements.md`](requirements.md) §1),
not asset lock-in: existing implementation assets are reused only where they fit: North
Star (agency acquisition, not delegation of will); slice order A→B→C→D; Delegation
Boundary (L0 default, L1 in-policy, L2 out of MVP); the hard safety line (never bypass
CAPTCHA / MFA / bot detection / rate limits / access controls); the ToS stance
(automation-prohibiting terms are a surfaced Constraint, never a silent block, never a
bypass); and local-first (no hosted vault, telemetry, analytics, or crash reporting).

| Layer | Decision | Why |
| --- | --- | --- |
| Runtime / language | **Node.js + TypeScript + Electron** | Electron main owns the vault, policy, browser-session orchestration, and provider SDKs. TypeScript keeps page snapshots, the Disclosure ledger, Policy, IPC, and browser-transport contracts shared and typed end to end. |
| UI | **React + Vite + TypeScript** in the Electron renderer, with `contextIsolation`, `sandbox`, and `nodeIntegration: false`; all privileged operations go through typed preload IPC | Soroeru's UI is mostly ledger tables, filters, forms, confirmation gates, policy settings, and reflection surfaces — React's ecosystem is strongest for accessible primitives, form validation, and virtualized tables. |
| Browser automation | **Soroeru-owned Chrome extension + Native Messaging**, behind the browser-neutral `PageDriver` seam | The production front door operates one explicitly selected tab in the user's real browser/profile. Electron remains the trusted core; the extension and native helper are thin adapters. Playwright Library is retained only behind a temporary developer rollback flag until parity evidence exists, then removed from production. There is never a silent Playwright fallback. |
| Browser session policy | **Explicit, in-memory lease of one user-selected tab**; the browser owns authentication/session state | A lease is bound to a browser instance, tab, site scope, permission, and execution epoch. Release never closes the user's tab. Soroeru never exports cookies, local storage, history, a profile, or `storageState`; encrypted workflow checkpoints contain only safe workflow/map/Evidence references. Restart, disconnect, tab close, permission revocation, vault lock, or out-of-scope navigation invalidates the lease and requires explicit rebind plus local revalidation. |
| Browser adapters | Chrome first; **`PageDriver` + browser-neutral session/transport contracts** are the multi-browser seam | Chrome/Edge can share a WebExtension family; Firefox needs a capability-verified adapter; Safari needs a separate Safari Web Extension/App Extension feasibility RFC. Portable semantics are commands, lifecycle, capability negotiation, and errors—not Chrome tab IDs or Native Messaging framing. |
| Local encrypted storage | **Vault v2**: a versioned encrypted record vault (§3), not a plaintext SQLite database or a single encrypted JSON blob | Matches the AES-256-GCM + Argon2id requirement, avoids native DB dependencies, and supports entity-by-entity migration and audit records. SQLCipher SQLite may be revisited later if ledger scale, query performance, or concurrent access becomes a real constraint. |
| AI provider abstraction | **AI-driven-first once configured**; optional Anthropic/OpenAI adapters are stateless and user-configured. Visibility collection sends full page content (Issue #514, §5.2); every other AI use stays structure-only | Matches the deterministic-default requirement (REQ-013) for users without AI configured. For Visibility collection, raw values leave the local process to the user's own configured provider by design, so the model can read and classify them; every other AI use (terms summarization, registration field mapping, Constraint findings) keeps raw values local — AI proposes from structure, Policy/Delegation decides. |
| Packaging | **Unsigned macOS DMG** during invited development beta, via **Electron Forge `maker-dmg`**; Chrome extension through the Chrome Web Store before product cutover | The app bundles a self-contained native helper and registers it only after explicit user action. A stable store extension ID is allowlisted. Signing/notarization is required before distribution beyond invited beta; unpacked loading is development-only. |
| Package manager | **npm** | The repo already has a lockfile; the dependency graph is not large enough to justify pnpm/Yarn. |
| Renderer build | **Vite** | Most direct match for React + TypeScript in Electron; keeps the UI iteration loop fast. |
| Main/preload build | **`tsc`** | Type-correctness first; add bundling only if packaging proves it necessary. |
| Unit tests | **Node built-in test runner** | Keeps the dependency surface small for domain/vault/service tests. |
| Browser E2E | **Playwright Test, development-only** | Tests local fixtures, Electron UI, and extension behavior without making Playwright Library a supported production automation path. |
| Formatting / linting | **Prettier + ESLint** | Standard, low-friction baseline once React/Electron source exists. |

### 2.1 Decision alternatives and reconsideration triggers

The table above records the current target stack. The following load-bearing decisions have
known alternatives and concrete triggers for reconsideration:

- **Electron desktop app**: lighter desktop shells (Tauri, native Swift/AppKit, or a
  browser-extension-only surface) were considered but not selected for the MVP because the
  trusted main process needs to own Vault v2, policy, workflow, typed IPC, Evidence, and
  provider SDK integration in one inspectable Node/TypeScript runtime. Reconsider if the
  package size or idle memory footprint is recorded as a release blocker in beta feedback
  or the release-candidate checklist, or if Electron's sandbox/process model prevents a
  required macOS security or distribution constraint.
- **Chrome extension is the production browser front door** (Issue #391): three alternatives
  were considered: keep Playwright primary, keep both paths indefinitely, or promote the
  extension and retire production Playwright. Playwright and `channel: "chrome"` failed to
  improve reachability on the Product Owner's real-site beta checks, while two privileged
  production paths would duplicate session semantics, packaging, and security surface. The
  extension therefore becomes primary. The existing Playwright adapter is a temporary,
  developer-only rollback during parity work; after the extension acceptance proof it is
  removed from runtime and packaging, while Playwright Test stays development-only. A bridge
  failure, missing permission, wall, or unsupported capability always fails closed—never a
  silent Playwright fallback. Reconsider the production retirement only if recorded extension
  evidence shows a required site is reachable and safe solely through Playwright.
- **The browser owns session state; Soroeru leases a tab**: exporting the real profile would
  grant broader authority than the job needs, so #294 `storageState` persistence remains a
  legacy Playwright-only facility until its production path and encrypted records are retired.
  The shared session seam must lose `exportStorageState`. A lease is in-memory; only encrypted
  workflow metadata survives a restart, and resumption after invalidation requires explicit
  rebind and local revalidation. Reconsider only if a future browser exposes a least-authority,
  user-approved session capability that does not export profile material.
- **Explicit binding and least permission (Ledger Site Account Scope, Issue #474)**:
  Site Accounts registered in the disclosure ledger form the operable scope ("開示台帳の Site Account 集合＝操作可能スコープ").
  The production UX connects through Chrome Bridge setup once; once connected, site accounts in the ledger are operated without per-site permission popup buttons or repetitive tab confirmation dialogs ("都度許可 UI の廃止").
  A short-lived nonce/lease ID, browser instance, tab handle, site scope, permission, and execution epoch are checked on every command.
  Origins outside the ledger remain strictly out-of-scope and fail-closed. Either surface can stop immediately.
  Cross-origin SSO is a human hand-off, not an automatic permission expansion: commands pause
  before leaving the Site Account scope, the user completes the IdP flow without Soroeru reading
  or filling the IdP, and the encrypted checkpoint retains no IdP URL, token, or page data. On
  return to an already permitted target-site origin, resume requires local redirect/site/wall
  revalidation and explicit user confirmation; a new tab or non-returning flow requires a fresh
  binding. A future adapter may automate an IdP only through a separately approved exact-origin
  grant and dedicated security design, never through the Site Account grant.
- **Thin adapters, browser-neutral semantics**: `PageDriver` retains the #381 split between
  structure snapshots and local value reads for every use except Visibility collection, whose
  AI-driven exploration pass reads values directly as part of the loop (Issue #514, §5.2). A
  browser-neutral session/factory/transport
  contract owns lifecycle, capability negotiation, cancellation, and typed errors. Chrome
  details—numeric tab IDs, extension IDs, Native Messaging framing—must not cross that seam.
  Edge is the nearest future adapter; Firefox requires a capability spike; Safari requires a
  separate feasibility RFC because Safari App Extension messaging is not assumed equivalent.
- **Store distribution and native helper**: unpacked loading stays development-only. Product
  cutover requires Chrome Web Store distribution (unlisted beta first is acceptable), a stable
  allowlisted extension ID, protocol/helper/app version negotiation, and an in-app explicit
  install/repair/uninstall flow for a self-contained helper. Registration is never implicit.
  Reconsider the store channel if its policies prevent the least-permission design; do not
  replace it with a permanently developer-mode product flow.
- **Unsigned DMG with no auto-update for MVP**: signing/notarization, auto-update, App Store
  distribution, and zip-only delivery were considered but deferred. The unsigned DMG best
  matches the small private beta while making Gatekeeper friction explicit and avoiding
  release infrastructure that is not yet required. Reconsider when distribution moves beyond
  invited beta users, when manual upgrade friction blocks validation, or when Developer ID
  signing/notarization credentials become available for a release issue.
- **AI-driven Visibility collection may read raw personal values (Issue #514)**: this reverses
  the prior "agent layer never sees raw values" invariant, but only for Visibility collection.
  Alternatives considered: (a) keep collection structure-only and improve deterministic
  discovery's page/field coverage instead (rejected — Issue #381's own field trial showed
  regex-based link/label matching misses whole pages, e.g. "ログインとセキュリティ", "プライバシー",
  that a purely structural signal cannot name in advance); (b) keep the #381 structure-only
  AI-navigation design and add a second, still-local value-reading step keyed by the model's
  page-purpose/field-location proposal rather than by the model itself reading values (rejected
  as the default — this is strictly safer and remains available as the deterministic/mapped
  fallback tier, but was explicitly not what the Product Owner asked for: Issue #514 is a
  deliberate choice to let the model read and classify values directly, not only propose where
  to look); (c) send only redacted/tokenized values (rejected — token-for-value substitution
  breaks the model's ability to classify or return the value itself, defeating the purpose).
  This is a Product Owner decision, not a technical constraint — see Issue #514 for the full
  deliberation. Because the model's raw-value read has no local corroboration source of its own
  the way a mapped/deterministic read does, §5.2 item 1 requires the returned value to actually
  appear in the page content captured for that step before it is stored — an integrity safeguard
  against hallucination or a manipulated page, not a disclosure restriction; a value that fails
  this check becomes `unknown`, never a guess. **Reconsider this decision** if: provider-side
  logging/retention cannot be
  verified as disabled for the configured provider; a real credential-leak or account-takeover
  incident is traced to this path; or the Product Owner decides to re-narrow the exception (e.g.
  back to card/CVV/password excluded, general PII only) after seeing real collection runs. Every
  other invariant this reverses only for this one path is listed in §5.2, §10, and
  `security.md` §5.

### 2.2 Extension-primary migration and implementation split

The migration is fail-closed and dependency ordered. “Default” changes only after the
extension capability proof passes; production Playwright removal happens only after the
extension path is distributed and accepted. Each numbered item should be its own Issue:

1. **Real-session reachability proof** (depends on #381 contracts): on one Product
   Owner-approved site that Playwright could not reach, prove that the extension can reach and
   observe the page without evasion; record sanitized Evidence, never credentials or captures.
2. **Browser-neutral session/transport contract** (depends on 1): introduce tab-lease lifecycle,
   capability negotiation, cancellation epochs, typed errors, and remove `exportStorageState`
   from the shared seam.
3. **Explicit binding and least-permission UX** (depends on 2): extension-created binding offer,
   Electron acceptance, exact-origin permission, badge/banner, stop/revoke/rebind.
4. **Self-contained native helper and packaging** (depends on 2): stable-ID allowlist, versioned
   handshake, explicit install/repair/uninstall, no system Node requirement.
5. **#381 extension capability proof** (depends on 1–4): sanitizer, navigation, wall-first,
   local-value, cancellation, reconnect, and stale-map invariant tests.
6. **Read-only Visibility cutover** (depends on 5): extension becomes the default with encrypted
   workflow checkpoints/Evidence and no silent fallback.
7. **Web Store and signed distribution** (depends on 4 and 6): stable Chrome ID, store privacy
   disclosures, and signed/notarized app/helper path before broader distribution.
8. **Production Playwright and #294 retirement** (depends on 6–7 plus acceptance Evidence):
   remove bundled Chromium, `channel: "chrome"`, runtime `BrowserEngine`, production
   `storageState` UI/records, and the runtime Playwright Library dependency; keep Playwright Test.
9. **Node 24 LTS toolchain migration** (depends on 4 and 8): verify host, typecheck, unit tests,
   native handshake, and DMG on Node 24 before changing the repository-wide baseline. Node 26
   remains unselected while it is Current rather than LTS.
10. **Mutation operations and future browsers** (depends on 6 and each Slice B/C/D gate): split
    update, withdrawal, and registration commands; then Edge adapter, Firefox capability spike,
    and a separate Safari extension/native-app messaging RFC.

Until item 8, release packaging remains on Node 22 because the current `appdmg` chain is the
constraint—not Playwright's Node engine. Node 24 may be evaluated for extension/native-helper
development, but two production Node baselines are not adopted. The migration exit gate requires
recorded extension reachability, #381 invariant parity, wall hand-off/resume, disconnect/rebind,
   permission revocation, cross-origin SSO hand-off/return, helper cleanup, and package/install
   Evidence.

## 3. Domain Model And Persistence Mapping

### 3.1 Entities and encrypted payload kinds

Each logical entity is one AES-256-GCM encrypted record under an Argon2id-derived master
key (PBKDF2-HMAC-SHA-512 as the Web-Crypto-only fallback), keyed by `entityKind`
(`src/domain/entities.ts` `ENTITY_KINDS`, persisted by `src/store/vault-v2.ts`):

| Domain entity | Persistence payload | Notes |
| --- | --- | --- |
| Personal Attribute | `personalAttribute` | Canonical value, label, type, sensitivity, updatedAt. Value encrypted. |
| Site Account | `siteAccount` | Site/domain, login anchor, display name, relationship summary. No copied raw PII. |
| Credential | `credential` | Username/password imported from CSV or entered by the user. Value encrypted, linked to Site Account. |
| Disclosure | `disclosure` | Account + attribute + site-held value reference/hash + as-of + evidence. The core ledger edge (§3.2). |
| Account Relationship | `accountRelationship` | Newsletter, recurring billing, last-used, membership state, confidence, evidence. |
| Constraint | `constraint` | ToS automation prohibition, wall encountered, payment/high-risk terms, unknown state. |
| Mandate | `mandate` | What the user authorized: collection, update, withdrawal, registration, policy expansion. |
| Evidence / Audit | `evidence` | References, hashes, page URLs, timestamps, masked snippets; no raw unencrypted values. |
| Policy / Preference | `policy`, `preference` | Safe defaults, user selections, suggestion history, promotion state. |
| Delegation Boundary / Capability | `capability` | Operation-specific L0/L1 status, understanding checks, reductions. |
| Reflection | `reflection` | Initial footprint and post-action change records. |
| Workflow checkpoint | `workflowCheckpoint` | Queue and resumability metadata (e.g. Visibility hand-off state), never raw browser profile state. |
| Provider settings | `providerSettings` | The user's AI provider selection and API key (encrypted). |
| Local definition | `localDefinition` | Encrypted local candidate site/field definitions (§7). |
| Site Collection Map | `siteCollectionMap` | Versioned per-site pages, typed item locators, fingerprints, provenance, and generation status (§5.2). A separate entity kind from the Slices B–D `localDefinition` shape. |
| Diagnostic | `diagnostic` | Support-bundle diagnostics, redacted. |

Vault v2 file layout:

- file header: version, KDF parameters, vault metadata, optional recovery wrapper;
- record envelope: `recordId`, `entityKind`, `schemaVersion`, `iv`, `ciphertext` (includes
  the GCM auth tag), `createdAt`, `updatedAt`;
- in-memory indexes after unlock for account/domain/attribute queries;
- encrypted export/import remains the only export path.

All raw values are inside encrypted payloads. Soroeru may store keyed hashes/fingerprints
inside encrypted payloads for comparison and audit. Anything readable before unlock (the
file header) must be non-sensitive and minimal; if unsure, encrypt it.

Vault v2 durability:

- save and encrypted-import writes replace the vault with same-directory atomic replacement:
  write a temporary file, fsync it, rename it over the target path, then best-effort fsync the
  vault directory. Temp-file write/fsync failures abort the save before replacement; for the
  macOS MVP, a failed directory fsync after a successful rename is not surfaced because the
  previous file was never truncated or partially overwritten;
- the target path is never overwritten with a partial JSON document; if a crash or write
  interruption happens before rename, the previous vault file remains the readable source of
  truth;
- unreadable, truncated, or unparseable vault files fail closed with a corruption error that
  can be reported to the user. Soroeru must not silently create an empty vault in that path;
- no automatic `.bak` generation is part of the MVP. Atomic replacement protects the
  in-place source of truth, while explicit encrypted export/recovery workflows cover user-
  chosen backups without creating extra local files that may confuse ownership or retention.

### 3.2 Disclosure row shape

Logical Disclosure row:

```text
Disclosure {
  id
  siteAccountId
  attributeKey
  encryptedValueRef
  normalizedValueHash
  observedAt
  sourcePageUrl
  sourceKind: form-field | profile-text | billing-page | newsletter-setting | user-confirmed
  confidence
  evidenceIds[]
  staleState: current | stale | unknown
}
```

`staleState` is derived by comparing `normalizedValueHash` with the canonical Personal
Attribute's normalized hash after unlock. It can be materialized for UI speed but must be
recomputed whenever a Personal Attribute changes.

The site-held value is encrypted because it is collected PII. It is stored separately from
the Site Account so bulk update can query "all Disclosures where attribute = phone and
value != canonical" without treating Site Account as a raw-value dump.

### 3.3 Evidence and audit

Evidence records make decisions inspectable without turning logs into a second vault leak:
page URL, timestamp, field labels, field type, masked snippet, and normalized hash. The
content-minimization requirement (never screenshot pixels, full HTML, cookies, tokens, or
raw values) is canonical in [`requirements.md`](requirements.md) §8. If a future feature
needs richer evidence, it must be encrypted and explicitly scoped.

### 3.4 CSV import

The importer (`src/domain/csv-import.ts`) accepts Google/Chrome Password Manager CSV
columns:

```text
name,url,username,password,note
```

It parses locally only, creates or updates Site Account seeds, and persists credentials as
encrypted `credential` records (§3.1). The behavioral safety requirements (size/row-count
validation, immediate encryption, never logging raw values, discarding the buffer after
import, no plaintext re-export, and prompting-rather-than-silently-deleting the source
file) are canonical in [`requirements.md`](requirements.md) §8 and REQ-002;
`recommendSourceDeletion` in the IPC result (§4) is how that prompt is surfaced to the
renderer.

### 3.5 Local diagnostics and support bundles

Soroeru has no telemetry, analytics, or crash-reporting service, so failure investigation
is local and user-controlled. The durable diagnostic model is the encrypted `diagnostic`
entity (§3.1), not a remote event stream and not a plaintext shadow copy of the vault.
Diagnostics may record app version, OS/runtime versions, component names, operation ids,
state transitions, error categories, wall hand-off categories, counts, timestamps, and
masked references needed to reproduce a failure. They must never record decrypted profile
values, credentials, card data, CVV, API keys, passphrases, recovery keys, raw AI prompts,
cookies, browser sessions, screenshots, Playwright traces, full HTML, raw CSV contents, or
decrypted vault bytes.

Plain operational logs, when needed for startup/build/runtime failures before the vault is
unlocked, live under the app-support diagnostics directory (macOS:
`~/Library/Application Support/Soroeru/logs/`; `SOROERU_STATE_ROOT` may redirect this in
development). They are sanitized by the same rules, are not treated as evidence of user
activity, and rotate by size/count so local troubleshooting does not grow without bound
(MVP target: 1 MiB per file, 5 retained files). Activity-level diagnostics that could reveal
which sites the user manages are stored only as encrypted `diagnostic` records in Vault v2.

`redacted` for a `diagnostic` payload means: no raw value fields; no secrets/tokens; site
URLs reduced to origin or hash when a full URL may contain identifiers; page text reduced
to a classification or masked snippet; file paths reduced to basename or app-relative
category; errors reduced to code/category plus a sanitized message. Support bundles are
generated only from a local UI action after explicit confirmation. The export is a redacted
JSON summary (app/OS/runtime versions, recent sanitized diagnostic events, and optional
sanitized operational-log excerpts), written only to a user-selected destination and never
uploaded automatically. The detailed security policy and release checklist are owned by
[`security.md`](security.md) §12.2 and §13.

## 4. IPC And Trust Boundary

The renderer and main process share exactly one typed contract:
`electron/ipc/contract.ts`. It declares:

- `IPC_CHANNELS` — the **complete allowlist** of channels the renderer may invoke (vault
  status/setup/unlock/lock/recovery, domain summary, CSV import, saved-page import, ledger
  sites/site/insights, reveal, confirm-dynamic-candidate, and Visibility
  run/resume/abort/status). Any channel not on this list is unreachable from the renderer.
- `VISIBILITY_EVENT_CHANNEL` — a one-way main→renderer channel for Visibility run
  progress and wall hand-off events (`run-started`, `handoff`, `resumed`, `run-finished`),
  carrying only references / counts / masked wording, never a raw collected value.
- Payload types for every channel, all deliberately **redacted by construction**: e.g.
  `AttributeSummary.preview` and `DisclosureView.preview` reveal at most a value's length
  (`•` bullets), never its characters; `SiteLedgerSummary` carries counts and stale tallies,
  never values.

`electron/ipc/bridge.ts` wires each `SoroeruSession` method to its channel;
`electron/main.ts` registers only the channels present in that bridge via `ipcMain.handle`.

The browser boundary is separately typed and least-authority: Electron main authenticates a
versioned local connection to the native helper; the helper relays closed-schema messages to the
Soroeru extension; the extension worker validates lease/epoch/tab/origin/permission before a
content script observes or changes the one bound page. The app-bundled helper is a **trusted but
minimal local transport**: it necessarily sees message plaintext in memory, so its process and
installed binary are inside the trusted computing base, but it has no vault/provider access,
network client, payload interpretation, durable queue, logging, or persistence. It accepts only
the authenticated app/extension endpoints and exits with the connection. The extension/content
script and helper may transiently hold page structure or a value only for the local command that
needs it; vault records, provider keys, canonical profiles, durable collection maps, AI calls,
Policy, Evidence, and gates remain in Electron. Browser target-site traffic is the only network
egress from this chain; native
messaging is local transport, and AI-provider egress remains a separate Electron-owned path —
sanitized structure only, except Visibility collection's AI-driven exploration pass, which may
send raw personal values read from the page (Issue #514; see §5.2). DOM content and every bridge
message are treated as untrusted input.

**Reveal flow**: a stored site-held Disclosure value is masked by default. Revealing it
(`revealValue`) requires re-verifying the master passphrase for that single reveal and is
refused outright for most-sensitive attributes (the card CVV). The renderer must show a
revealed value transiently and never persist it.

## 5. Slice A: Visibility (implemented core; target browser flow during migration)

Slice A's goal is not "automate a lot." It is to create the first threshold-crossing
experience: the user sees their scattered online footprint at once.

The ledger, runner, collection, and wall hand-off core are implemented. The tab-offer and lease
steps below are the target state selected by #391; current code still defaults to Playwright and
uses a feature-flagged numeric-tab extension bridge until §2.2's cutover gates pass.

### 5.1 Flow

1. **Vault setup / unlock** (`VaultGate`).
2. **CSV import**: create Site Account and Credential seeds (`CsvImportPanel`); a saved
   local account page (HTML) can also be imported manually as a fallback
   (`SavedPageImportPanel`, when auto-login/collection cannot reach a page).
3. **Visibility run** (`LedgerPanel` / `SiteCollectionUi`, `VisibilityService`):
   - ask the user to offer one Chrome tab from the extension, grant the exact HTTPS origin,
     and confirm the matching Site Account in Electron; then open an in-memory tab lease;
   - navigate to the site and log in with the stored credential;
   - detect walls; hand off in the same leased tab; the run pauses and the renderer
     receives a `handoff` event with instruction text; the user resolves the wall and the
     run resumes (§6);
   - find profile/account/billing/newsletter pages and their personal-information values via
     AI-driven exploration when AI is configured (primary path, Issue #514, §5.2), or via
     deterministic discovery otherwise (fallback, REQ-013);
   - for the AI-driven path, the model's returned values become Disclosure/Account
     Relationship candidates directly; for the deterministic path, collect field/text values
     locally first (`disclosure-collector.ts`);
   - classify values into Disclosures and Account Relationships;
   - store encrypted records plus Evidence/Audit.
     (`CollectionPanel.tsx` is residual/unmounted; the live shell drives collection from
     the Disclosure ledger after Issue #341.)
4. **Ledger view** (`LedgerPanel`): a spreadsheet-style table (sites as rows, the union of
   observed attributes as horizontally-scrollable columns) backed by `ledgerSiteDetails`
   (all sites' composed detail in one call). The same panel owns selection, batch
   Visibility collection, session-persistence bulk-enable, and per-row 詳細 / 保存ページ
   import / 削除 actions (Issue #341; the dedicated Site Management tab was removed).
   Per-site composed detail (`ledgerSite`) remains available for the row "詳細" flow.
5. **Initial Reflection / filters** (`InsightsPanel`): `ledgerInsights` /
   `computeLedgerInsights` summarize stale, risky, over-disclosed, newsletter, billing, and
   not-fully-checked findings without turning them into pressure to approve blindly.

### 5.2 Collection strategy

**Policy (Issue #514, supersedes the earlier "deterministic-first, AI optional/structure-only"
design):** once the user has an AI provider configured, **AI-driven page exploration and value
extraction is the primary Collection strategy for Slice A.** The model receives full page content
during the logged-in session — not only a sanitized structure snapshot — and both (a) proposes
which reachable page to visit next, and (b) identifies and returns the personal-information values
present on the page, classified by attribute key (name, address, phone, email, card number, CVV,
site password, account id, notification/security setting state, etc.). The automation/domain layer
writes what the model returns as Disclosure records, Account Relationship facts, and minimized
Evidence, through the normal typed `DomainService`/`VaultService` API — the model has no direct
filesystem or vault access, but the *content* of the write, including a full card number, CVV, or
site password read from the page, now comes from the model itself rather than from a separate
local value-reading step. This lifts the earlier "never sees raw personal values" restriction
specifically for Visibility collection; see `requirements.md` §8's Visibility collection exception
for the non-negotiable-requirements wording, and `security.md` for the full threat-model update.

**Implementation status (Issues #516–#517):** the domain foundation (#516) is implemented:
`Capability.operationType` and `Mandate.operation` include `ai-assisted-discovery`, and
`siteCollectionMap` has a versioned record type with validation on vault write/read and immediately before serialization.
`DomainService.addDisclosure` accepts an explicit `collectionTier: "ai-driven"` from a trusted
collection caller to retain CVV/full PAN; the persisted tier also selects full-value stale-state
comparison. An absent tier retains deterministic last-4/CVV-exclusion behavior. This marker is
not authorization by itself — `DomainService.permitsAiCollection` additionally checks a live,
run-scoped `ai-assisted-discovery` Mandate/Capability pair before any collector action.

The AI-driven exploration and extraction loop (#517) is implemented as a separate module
(`src/automation/ai-visibility-collector.ts`, `ai-visibility-contract.ts`,
`collection-observation.ts`, `visibility-navigation-policy.ts`) alongside the existing
structure-only `AiEngine` (Issue #276), which it does not use or extend. It enforces
same-registrable-site navigation, per-site page/depth/call/token/time budgets, immediate wall and
ToS-prohibition hand-off, a closed model output schema with no browser-control tool, and local
corroboration before any write: a returned value must match its own captured item verbatim
(with only NFC/whitespace/phone-and-card-separator normalization; passwords and CVV require exact
match) before `VisibilityRunner` commits it as a Disclosure. A non-corroborating value becomes an
`unknown-state` Constraint instead. `PageDriver.captureCollectionObservation` /
`checkCollectionObservation` (both adapters) bind each observation to a document/revision/binding
epoch so a stale or navigated-away response is discarded rather than written. Every documented
failure mode (provider error, invalid response, cancellation, wall, budget exhaustion, ToS
decision, unknown destination, session invalidation) falls back to the existing deterministic
`DecisionEngine`/`PageExplorer` path within the same run, never a bare error. Production
authorization issuance (the collection gate, L0/L1 UI) remains follow-up work (`#519`).

`SiteCollectionMap` generation and map-based recollection (#518) are implemented in
`src/automation/collection-map.ts`, `VisibilityRunner`, and `DomainService`
(`getSiteCollectionMap` / `saveSiteCollectionMap`). An AI-driven run turns its committed,
locally corroborated facts into map pages (field-id locators plus locally computed
fingerprints) and saves the next map revision: `ready` when the run completed without
fallback, `candidate` otherwise. When a live `ai-assisted-discovery` grant exists and the site
has a map, the runner uses the map first and makes no provider call: it navigates to each
mapped page through `gotoCollection`, runs wall/ToS checks, captures one observation, and
reads only entries whose page fingerprint, item fingerprint, and local classifier key all
still agree. Values read this way keep the `ai-driven` tier of the run that created and
corroborated the entry. A mismatch (page gone, page changed, selector miss, item changed, or
classification disagreement) isolates only that entry. The rest of the observed page falls back
to the deterministic tier, and the run records an `unknown-state` Constraint that suggests
regeneration. When no mapped page can be observed, the run falls back to deterministic
exploration. Recollection never rewrites the map; only
`runSite(id, { regenerateCollectionMap: true })`, set from an explicit user action, runs
AI-driven collection again and replaces the map. Without a live grant the map is not used.
The user-facing regeneration control and provenance display belong to #519/#520.

Collection uses two tiers, chosen per REQ-013's AI-optionality rule (a third, later tier is
unaffected):

1. **AI-driven exploration and extraction** (primary once AI is configured; Issue #514): as
   described above. Every safeguard *unrelated* to raw-value exposure is unchanged and still
   enforced locally, never by the model: same-registrable-site HTTPS navigation only; per-site
   page/depth/call/token/time budgets; immediate hand-off on CAPTCHA/MFA/bot-detection/wall
   signals (never solved, bypassed, outsourced, or obscured); GET alone is never accepted as proof
   of read-only — the destination must match a locally approved account-information page class and
   must not carry an action-like path/query/element signal (logout, delete, withdraw, cancel,
   unsubscribe, confirm, submit, purchase, or preference mutation), and such destinations are
   rejected from discovery rather than confirmable; unknown destinations still require user
   confirmation before navigation. The model has no general browser-control tool — it can only
   propose the next same-site read-only navigation and report values found on the current page;
   navigation, wall detection, and every write still execute locally.
   **Local corroboration before write (integrity, not disclosure, safeguard):** the
   automation/domain layer captures the page content given to the model for that navigation step
   and requires a returned value (or its normalized form) to actually appear in that captured
   content before `DomainService.addDisclosure` accepts it. A returned value that does not
   corroborate against the page it was claimed to come from — whether from model hallucination or
   from untrusted/manipulated page content trying to inject a fabricated value — is treated as
   `unknown` / a review-task candidate, never stored as a confident Disclosure (same "prefer
   unknown over a confident wrong answer" rule as the rest of this document,
   `requirements.md` §8). This check is local and does not send anything back to the model; it
   only gates what the write path accepts.
2. **Deterministic discovery** (fallback when AI is not configured, or when an AI-driven pass
   fails, is cancelled, or exhausts its per-site budget mid-run — REQ-013):
   - login form traits;
   - account/profile/billing/newsletter link text;
   - field labels, `autocomplete`, `name`, `id`, placeholder, nearby text
     (`src/agent/scan.ts`, `src/agent/classifier.ts`);
   - Japanese-only matching for MVP.
   This tier never sends any value to an AI provider, so it keeps the pre-#514 conservative
   storage behavior for card data: site-collected card numbers are reduced to last 4 digits before
   storage, and CVV is never collected or stored through this tier.
3. **Official/local site definitions** (§7) are a later tier for Slice A and are the
   primary tier already implemented for the not-yet-ported registration/withdrawal PoC.

Unclear values become `unknown` Disclosures or review tasks (surfaced to the user as
pending dynamic-attribute candidates), not guessed data — for both tiers.

AI-driven collection also produces a versioned `SiteCollectionMap` as a byproduct (Issue #381's
schema): the page-purpose/field-location facts the model used for this run are recorded so a
later rerun on an unchanged page can be served from the map's local coordinates first and fall
back to a fresh AI pass only on mismatch (selector miss, page gone, structural change). This
keeps repeat collection inspectable and reduces provider calls, but does **not** reintroduce a
structure-only restriction: a rerun still reads the actual value locally at the mapped location,
which is the same local-read step the deterministic tier already performs. Maps are encrypted
local candidate definitions, mismatch is isolated per entry with fallback to the tier that
applies (AI retry or deterministic), and regeneration requires user action.

AI-driven collection has a separate `ai-assisted-discovery` capability. At L0 the collection gate
names each discovery run **and states plainly, every time, that the model will see raw personal
values — including full card numbers, CVV, and site passwords — sent to the user's configured AI
provider.** Existing collection L1 does not grant `ai-assisted-discovery`; L1 expansion requires
its own explicit understanding check covering provider egress of those raw-value categories and
bounded navigation. Reduction (L1 → L0, or disabling AI collection back to the deterministic tier)
remains immediate and unconditional. Unconfigured-security Review tasks are computed from the
latest Disclosure/Evidence; dismissal is an encrypted Preference keyed by task plus observation
hash, so unchanged rescans stay dismissed and changed observations can surface once.

Implementation extends both `Capability.operationType` and `Mandate.operation` with the literal
`ai-assisted-discovery`; it does not overload `collection`. Maps use the encrypted
`siteCollectionMap` entity kind, included in `ENTITY_KINDS` (`src/domain/entities.ts`, Issue #516).
Its v1 shape stores per-account revisions, generation status, provenance, page purposes and
fingerprints, and typed item coordinates: CSS is restricted to `:root` plus positional
`*:nth-child(N)` child steps, and field IDs to bounded scanner `f-N` / `d-N` coordinates.
Value-bearing attribute selectors, DOM IDs/classes, and text selectors are rejected.
Map URLs omit query/fragment/credentials;
producers must minimize coordinates and enforce site scope before storing structural facts.
The v1 storage ceilings are 32 pages per map, 128 items per page, 128 characters for
record/account IDs and attribute keys, and 2048 characters for URLs/selectors. A positional
selector has at most 64 steps, with child indices and scanner indices in 1–999999. These
are storage ceilings, not grants to exceed the collection run's smaller exploration budgets.
During `put`/`save`/`exportEncrypted`, invalid maps are rejected without writing a replacement
vault; serialization revalidates maps because the general vault API exposes mutable record
references.

**Fingerprint producer contract (Issue #518 producer: `structuralFingerprintInPage`):** derive fingerprints locally from
structure, never from model-supplied fingerprint claims or raw HTML/text/value hashes. Encode
an ordered JSON array of `[childIndexPath, tag, controlType]` tuples in DOM preorder as UTF-8,
then SHA-256 it into exactly 64 lowercase hexadecimal characters. `childIndexPath` is an array
of one-based child-element positions relative to the fingerprinted root (empty for the root);
`tag` is the lowercase standard HTML element name (`other` for custom/unknown elements);
`controlType` is the browser-normalized standard input type for input elements, or the empty
string for other elements. Page fingerprints cover the document body element tree (which
excludes the extension's automation banner under `<html>`); item fingerprints cover the
located element subtree. Non-rendered `script`/`style`/`noscript`/`template`/`link`/`meta`
elements are skipped and consume no child index, so injected scripts do not invalidate a
map. A tree over 20,000 elements yields no fingerprint, so that page is never mapped. Exclude text, values, labels, IDs, classes, URLs, and all
other attributes. Schema validation enforces the output format, while the future local producer
must enforce this input contract; a valid hash encoding alone does not prove its provenance.
The producer runs synchronously inside the same in-page capture as the value read, and
fingerprints never enter the model envelope.

**Coordinate trade-off (Issue #516):** positional paths and bounded scanner IDs avoid retaining
page-controlled values that can be embedded in selectors. Arbitrary CSS, DOM IDs/classes, and
text/value selectors were rejected because a syntax-only validator cannot establish that those
strings contain no personal values. This deliberately sacrifices resilience to inserted or
reordered elements: require fingerprint agreement and fall back on mismatch, never silently
read another element. #518 uses only field-id locators (the scanner numbers elements
deterministically for an unchanged page). Revisit the coordinate representation if an unchanged-page
rerun fixture fails fingerprint/locator reuse solely because scanner numbering is unstable,
or if an inserted non-data sibling makes an otherwise unchanged-item fixture fall back. Any
replacement needs the same value-free guarantee before widening the schema.

Discovery wall pause/resume reuses the existing
`workflowCheckpoint` entity and same-headed-session lifecycle from §6 rather than defining a
second checkpoint mechanism.

### 5.3 Account Relationship filters

`ledgerInsights` (`computeLedgerInsights`) computes the required filtered lists — the exact
minimum set is canonical in [`requirements.md`](requirements.md) REQ-006 — plus the initial
Reflection. Each filter item links back to evidence and the next safe action; the UI should
create the "suddenly I can" feeling without collapsing judgment into a single bulk-approve
button.

### 5.4 Delegation for Slice A

Visibility is still a world-touching action because it logs in and reads data. Delegation
levels and their conditions for this slice are canonical in
[`requirements.md`](requirements.md) §7.1 and §5 (the general Delegation Boundary model).

## 6. Wall Hand-off and Resume

When CAPTCHA / MFA / identity / email / SMS verification is detected
(`src/automation/wall-detection.ts`, kept strictly separate from field classification), the
Visibility runner pauses and `VisibilityService` emits a `handoff` event with instruction
text and evidence. The user resolves the step in the same visibly bound browser tab; the
renderer then calls `resumeVisibility` (continue) or `abortVisibility` (stop; never
bypasses). Detection is conservative and never attempts to solve, bypass, outsource, or
obscure a wall; see [`security.md`](security.md) §7.

Resume is valid only while the same live tab lease, site scope, permission, and execution epoch
remain valid. Browser/extension/app restart, tab close, vault lock, permission removal,
out-of-scope navigation, or bridge disconnect invalidates the lease. The encrypted workflow
checkpoint remains, but continuing requires an explicit rebind and local revalidation of URL,
site scope, wall state, and checkpoint; no tab ID or browser-session material is durable.

Only one Visibility run (and therefore one hand-off) is active at a time — `SoroeruSession`
rejects a concurrent `runVisibility` call with a `busy` status. Bulk update (§8) will reuse
this same per-site pause/resolve/resume shape once implemented.

## 7. Definition / Agent Layer (Slices B-D harness, not yet ported)

This section documents `src/agent/definitions.ts`, `src/agent/official-definitions.ts`,
`src/agent/mapper.ts`, and the shared contracts in `src/types.ts`
(`ProfileKey`, `Transform`, `PageSnapshot` / `FormField`, `MappingPlan`, `TermsAnalysis`,
`WallDetection`, `GateRequest` / `GateDecision`, `SiteRecord` / `FilledFieldRecord`,
`RegistrationMandate`). This code is real and tested, but it belongs to the
**pre-Electron PoC harness** (`src/app/*`, run via `npm run poc`) that predates the current
Electron/React target architecture (§1) and has **not yet been ported** into
`electron/`/`src/renderer/`. It is kept because Slices B (bulk update), C (withdrawal), and
D (new registration) will need an equivalent deterministic/AI field-mapping seam, and this
is the closest existing reference; it must be re-integrated behind `AutomationService` /
`DomainService` / typed IPC (§1, §4) before it is product code, not used as-is.

Two seams keep the deterministic and AI variants interchangeable and testable:

- **`Mapper` seam** (`src/agent/mapper.ts`): `DeterministicMapper` and `AiMapper`
  implement the same interface (`discoverRegistrationLink`, `mapFields`, `analyzeTerms`).
  Callers depend on the interface, so either variant can be swapped in and measured against
  the same scenarios.
- **Normalization seam** (`src/agent/normalization.ts`): every mapper output passes
  through `normalizeMappingPlan` / `normalizeTermsAnalysis` before it is acted on. This is
  the single place that drops invented keys, invalid transforms/roles, and field ids that
  are not on the page, and that folds `prohibitsAutoCreation` / `trial-subscription` into
  the high-risk flags. Both variants share it, so guard stop conditions are identical
  regardless of which mapper produced the plan.

**Cross-layer invariant (agent layer never sees raw values).** The agent layer receives
only `PageSnapshot` structure (labels / `name` / `id` / type / options / nearby text) and
terms text. Raw profile values are resolved from the decrypted store and injected by the
automation layer at fill time — they never enter a mapper input or an AI prompt. This
invariant is asserted in `tests/unit/soroeru-poc-contracts.test.ts`.

### 7.1 Shared Official and Local-Candidate Definitions

Deterministic Mode and AI Mode share one definition model (`SiteDefinition` /
`LocalCandidateDefinition` in `src/types.ts`) for:

- site and URL patterns (`match.domains` / `match.urlPatterns`);
- form signatures and field mappings (`registrationSignature`, `fieldRules`);
- withdrawal-flow steps (`withdrawalSteps`);
- wall-detection patterns (`wallSignals`);
- terms links and high-risk signals (`notes`; full terms analysis stays in
  `src/agent/guards.ts`).

Resolution order (`src/agent/definitions.ts`):

1. scan the current page / flow through `PageDriver` (`PageSnapshot`);
2. `matchDefinition` builds a score from domain/URL pattern, path pattern, field-token,
   heading, button, and wall-signal hits — a definition must positively match
   `match.domains` or `match.urlPatterns` before any other signal counts;
3. `resolveDefinitions` scores checked-in official definitions
   (`src/agent/official-definitions.ts`) together with this vault's non-rejected local
   candidate definitions, best first;
4. `applyFieldRules` maps fields the matched definition has rules for (first matching rule
   wins, same convention as `src/agent/classifier.ts`); unmapped fields fall back to the
   deterministic/AI mapper;
5. ask the API Provider only for ambiguous or unsupported cases.

AI output is stored as a **local candidate definition**, not as an official definition.
`candidateFromAiMapping()` converts a structure-only AI mapping result into a sanitized
encrypted local candidate after validation. Candidate definitions are lifecycle-managed:

```text
unknown or changed site
  -> AI/user/observation creates local_candidate
  -> local runs validate or reject it
  -> user may opt in to submit a sanitized candidate
  -> human review and tests promote it to official/shared definition
```

`validateCandidateDefinition` (`src/agent/definitions.ts`) is the "local runs validate or
reject it" step: it checks that the candidate identifies a site, that every embedded regex
compiles, that field-rule profile keys are known/custom, and — per
[`security.md`](security.md) §9 — that no embedded string looks like a raw personal value
(email, card-number-like, or phone-number-like). Candidates are stored in the encrypted
vault (`localDefinition`, §3.1) alongside profile data, site records, and mandates.

The sanitized opt-in submission and official-promotion steps remain future and opt-in.

## 8. Slices B-D: Bulk Update, Withdrawal, New Registration (design direction)

Slice A (Visibility) is the only slice implemented under the target Electron architecture
today. Slices B (bulk update), C (withdrawal cleanup), and D (new registration) are
**design direction, not yet implemented** under `electron/` / `src/renderer/`. Their intent
per [`requirements.md`](requirements.md) §7:

- **B — Bulk update**: for user-selected sites, diff Disclosure hashes against the latest
  canonical Personal Attribute values (§3.2 makes this a cross-site query: "attribute = X
  and value != canonical"), open the sites with changes, log in with stored credentials,
  update the changed fields, and hand off at walls (§6) — reusing the same per-site
  pause/resolve/resume shape Visibility already implements.
- **C — Withdrawal cleanup**: help the user stop newsletters, cancel unused subscriptions,
  and withdraw from unused services identified by the Account Relationship filters (§5.3).
  Site withdrawal may execute within the delegated range; irreversible final actions
  (account deletion, final withdrawal confirmation) and any Soroeru-internal data deletion
  stay gated and are never auto-clicked.
- **D — New registration**: URL-driven registration behind the review-and-confirm gate and
  the three guards (high-risk-clause escalation, payment stop with the
  free-trial→subscription exception, no auto-attestation). On auto-creation-prohibited
  sites, the agent fills only and the user submits.

A pre-Electron PoC (`src/app/registration-session.ts`, `src/app/bulk-update-session.ts`,
`src/app/withdrawal-session.ts`, run via `npm run poc`) implements these flows against a
separate app shell (`SoroeruApp` / `AppRunner`, a server-rendered local web UI over Node's
HTTP server). That code is retained as a reference for the flow shape and guard logic, but
its app-shell and UI layer are superseded by §1/§4 (Electron main + typed IPC + React
renderer) and must not be treated as the current product surface. Each slice needs its own
implementation Issue that re-integrates the relevant PoC logic (or a redesign of it) behind
`AutomationService`/`DomainService`/IPC.

## 9. Identity Verification Integration (My Number / JPKI)

Canonical identity requirements (first-launch gate, non-editable basic-4 attributes,
phone/email OTP verification, never storing the 12-digit My Number or PIN) are owned by
[`requirements.md`](requirements.md) §4.2 and §10 (REQ-015–REQ-020); this section owns the
integration mechanism only.

- Verification uses the Digital Agency's **デジタル認証アプリ** (認証 API only, not 署名検証者
  status): the card is read on the user's smartphone; the desktop links via QR (cross-device).
  Basic-4 attributes (legal name, residence address, DOB, sex) come via the UserInfo endpoint
  plus scope; the ID token carries `sub` as a PPID. No desktop NFC reader is required or
  supported.
- Because the integration effectively requires a server-side BFF, Soroeru runs a **minimal,
  OSS, zero-retention identity-auth broker** (decision "A", Issue #218): egress to the Digital
  Agency only, basic-4 attributes forwarded encrypted to the user's device and never
  persisted server-side. This is a narrowly-scoped exception to the no-backend principle,
  limited to the identity layer; the local encrypted vault stays local ("No hosted vault" is
  unchanged).
- Legal/assurance-level constraints and the full My Number / JPKI handling policy: see
  [`security.md`](security.md) §14.

A future advanced-user local MCP server is out of MVP scope; its boundaries (read-only /
planning-oriented tools only, never exposing raw personal values or bypassing the
review-and-confirm gate) are owned by [`requirements.md`](requirements.md) §9.

## 10. Security And Privacy Mapping

| Requirement | Architecture decision |
| --- | --- |
| Local encrypted vault | Vault v2 encrypted records (§3); no hosted service. |
| Memory-hard KDF | Argon2id primary; PBKDF2-HMAC-SHA-512 fallback only where required. |
| Derived key in memory only | `VaultV2` / `SoroeruSession` own the unlock/lock lifecycle; the renderer never receives the key. |
| CVV most sensitive | Canonical CVV: stored encrypted, reveal refused outright (§4), fill requires a dedicated accessor. Issue #516 adds encrypted site-collected CVV Disclosure storage only for explicit `collectionTier: "ai-driven"`; omitted/deterministic tier excludes both value and hash. Full-PAN stale comparison uses the persisted tier. Issue #517 implements the exploration loop and local corroboration that produce this tier; production authorization UI gates (L0/L1) remain pending (§5.2, `#519`). |
| Raw PII to AI | **Structure-only** for every AI use except Visibility collection: the agent/AI layer accepts structure-only requests and provider adapters validate redaction (the pre-#514 structural sanitizer component for the old discovery pass is retired — §5.2 no longer routes Visibility collection through it, and no other AI use needs one, since they already never receive page content). **Visibility collection is the one exception** (Issue #514, §5.2): its AI-driven exploration pass receives full page content, including raw personal values, from the user's configured provider — every other safeguard (same-site navigation, budgets, wall hand-off, no general browser-control tool, and the local corroboration-before-write check) still applies. |
| Egress limited | Architectural egress classes are target-site, ai-provider, and the identity-auth broker route to the Digital Agency (§9); the current static checker covers the implemented target-site / ai-provider classes and must add an identity-auth-broker category before broker code lands. No telemetry dependencies. |
| CSV contains plaintext passwords | Import buffer is local, encrypted immediately, never logged, discarded after processing (§3.4). |
| Local diagnosability without telemetry | Encrypted `diagnostic` records plus sanitized rotating operational logs and user-initiated support-bundle export (§3.5); no automatic upload. |
| No active-control bypass | Wall detection (§6) is separate from classification; detected walls stop or hand off. |
| Review gate / three guards / fourth boundary | Domain/Policy services decide (later slices, §8); the renderer only renders the gate. |
| ToS automation prohibition | Constraint record + high-risk UI; user decides; active controls still never bypassed. |
| No raw browser profile at rest | The browser owns its profile/session; the tab lease is memory-only and Soroeru never exports cookies, local storage, history, profile bytes, or `storageState` (§2). |

## 11. Field Detection And Measurement

Soroeru keeps the deterministic-vs-AI comparison because it directly protects agency:
wrong mapping makes the user choose over false information.

For site-wide discovery, Soroeru chooses a bounded observe/propose loop over a single static call
or autonomous browser control. A static call lacks multi-page reach; autonomous control gives
untrusted DOM excessive authority. Reconsider only if measurement shows inadequate coverage and a
replacement preserves schema-only navigation proposals, deterministic local execution of every
write, and existing gates (wall hand-off, budgets, same-site scope). Structure/value separation
remains the rule for every AI use except Visibility collection, whose bounded loop intentionally
reads and returns values as part of the loop itself (Issue #514, §5.2).

Measurement plan:

- define local fixtures for Slice A page types: login, profile, address, phone, card,
  newsletter, billing, MFA wall, ToS constraint;
- run deterministic and AI-assisted mapping against the same `PageSnapshot` shape;
- record success rate, mis-mapping rate, unknown/stop rate, wall hand-off accuracy;
- prefer "unknown / ask" over confident wrong mapping;
- no raw values in measurement artifacts.

`src/agent/scan.ts`, `src/agent/classifier.ts`, wall detection, guard analysis, the CSV
importer, and privacy static checks are the reusable candidates for this comparison.

## 12. Build, Test, And Quality Gates

Canonical commands and required coverage live in [`development.md`](development.md) and
[`testing.md`](testing.md). Do not duplicate the command list here; update those documents
when commands change.

## 13. Multi-Agent Orchestration Architecture

This section documents the target **multi-agent orchestration architecture** implemented across Issues `#439`–`#446` and `#482`. The orchestration system coordinates Issue execution while enforcing local-first security, strict role isolation, deterministic dependency management, and privacy-preserving observability.

**Trust boundary.** Everything in §13 is *development-time repository infrastructure*: it builds Soroeru, it is never part of the shipped Electron app, and it never touches the user's vault or personal data. Its egress is GitHub (Issues, Projects, pull requests) plus the operator's own agent CLIs; the JSONL/SQLite telemetry sink here is a local developer log on the operator's machine, not product telemetry. The product-level non-negotiables elsewhere in this document — no backend, no telemetry, no egress beyond the sites the user acts on and their own AI provider — constrain the app, and §13 sits outside their scope rather than being an exception to them.

```text
ProjectGraph (Parent Orchestrator, scripts/project-issue-graph.mjs)
├── 1. Capabilities Discovery (Codex / Claude / Grok / Gemini capability probing)
├── 2. Project Items & GitHub Dependency Closure Graph
├── 3. Deterministic Batch Selection (maxParallel, Priority rank, Issue #)
├── 4. Role Program per Issue (execution mode → role sequence → verified route per role)
├── 5. Role-by-Role Dispatch & Event Loop (assign_routes → dispatch_worker → wait_for_events)
├── 6. Recovery (idempotency keys, worktree-preserving handoff; retry/handoff caps NOT yet enforced — §13.4)
└── 7. Integration Quality Gate (Cross-Issue conflict, contract, criteria checks)
      │
      ▼ Dispatches one CLI process per role
Worker (external agent CLI, own process, own verified route)
├── Enters .worktrees/issue-<number>-<slug> via issue-implementation or handoff-issue
├── Fetches its own Issue body, diff, and test results (never received from the parent)
└── Returns role-complete / milestone events only
      │
      ▼ Telemetry Events
LLMOps Observability & Offline Evaluation
├── Append-Only JSONL & SQLite Telemetry Sink (Privacy-preserving, correlation IDs, waste taxonomy)
└── Offline Evaluation Harness (Episode reconstruction, Quality-Token Frontier reporting)
```

### 13.1 Role Sequencing in the ProjectGraph (`#439`, `#482`)

Orchestration is one LangGraph state machine (`scripts/project-issue-graph.mjs`) whose nodes are
`load_config` → `discover_capabilities` → `fetch_project_issues` → `validate_dependencies` →
`build_runnable_plan` → `assign_routes` → `dispatch_worker` → `wait_for_events` →
`integration_gate` → `release_dependents` / `return_to_worker` → `select_handoff_route`, ending at
one of two terminals: `summarize_run` (complete or blocked) or `fail_run` (a `failureReason` from
any setup node, or `no-worker-route-available`).

The parent:

- Evaluates verified runtime capabilities across Codex, Claude, Grok, and Gemini adapters.
- Fetches GitHub Project items and constructs the recursive `Blocked by` dependency graph.
- Dispatches runnable Issues in priority order up to `maxParallel`.
- Advances each Issue **role by role** through its role program, dispatching one worker process
  per role and resuming on `role-complete` events.
- Releases dependent Issues only upon reaching the configured milestone (`pr-created` or `merged`).
- Executes the **Integration Quality Gate** before dependency release to prevent cross-Issue contract breaks or file conflicts.

Steps *inside* one role — preparing the worktree, running tests, committing, pushing, opening the
PR — stay inside the worker's own `issue-implementation` / `handoff-issue` skill run rather than
becoming parent graph nodes. A separate synchronous `IssueSubgraph` was considered and rejected:
the parent is interrupt-driven and asynchronous (workers run detached and report events), and
wrapping a whole Issue lifecycle in one blocking node would have required re-designing waiting,
handoff, and `maxParallel`.

Role isolation is therefore **process isolation**, and it is worth being precise about how much
that buys.

*Enforced by the architecture*: each role is a separate CLI process on its own verified route, so
no role can observe another's conversation, chain-of-thought, raw responses, or session; and the
parent's dispatch payload is a closed, deny-listed set of fields — Issue number, role, route,
skill, release policy, next milestone (`buildRoleDispatchPayload` / `assertNoDisallowedKeys` in
`scripts/project-issue-roles.mjs`, on the live dispatch path).

*Not enforced, deliberately*: the roles **share the Issue worktree**. A planner's output reaches
the implementer as a committed design doc under `docs/design/`, and the implementer's work
reaches the reviewer as the branch diff. That on-disk channel is the intended one — it is how
work is handed along — but it means isolation bounds *conversation* context, not *all* context.
What a worker reads for its role is governed by its prompt and skill (convention), not by a
mechanism: the role schemas in §13.3 describe context a worker assembles locally for itself, and
nothing on the parent side validates that assembly.

### 13.2 Bounded Execution Modes and Role Programs (`#440`, `#482`)

To prevent arbitrary workflow generation, execution modes are restricted to a deterministic finite set (`scripts/project-issue-modes.mjs`), each mapping to a fixed role program (`scripts/project-issue-roles.mjs`):

- **`direct-review`** (Small/Low-Risk Issues): `implementer` → `independent reviewer`.
- **`plan-implement-review`** (Medium/Standard Issues): `planner` → `implementer` → `independent reviewer`.
- **`parallel-analysis-implement-review`** (originally intended for Large/High-Risk Issues): `parallel analysts` → `synthesizer` → `implementer` → `independent reviewer`. **Not implemented, and never selected** — it has no entry in `MODE_ROLE_PROGRAMS` and `modePreferencesFor` never ranks it. Large and high-risk Issues therefore run `plan-implement-review` today; they are not left without a plan, they simply get one planner instead of parallel analysts. Reconsider implementing it when telemetry shows `plan-implement-review` failing specifically on large/high-risk Issues — repeated `NEEDS_REVISION` or exhausted review budgets concentrated at size XL or `riskCategory` high/critical. Until that signal exists, the extra analyst fan-out would cost tokens without evidence of benefit.

Mode eligibility is decided deterministically based on Issue Size (`S`, `M`, `L`), change scope, dependency depth, and risk category. A candidate mode ranking policy orders eligible modes without expanding the candidate set; because `direct-review` stays eligible for medium-risk Issues, the preference order is conditioned on risk (`modePreferencesFor`) so anything above low risk buys a planner instead of always taking the cheapest eligible mode. `implementer` and `reviewer` roles use distinct verified routes whenever the pool holds more than one — enforced in both directions, on re-picks, and across handoffs — and a pool with no distinct route left degrades to a shared route with a recorded `same-route-reviewer:*` reason. Simultaneous parallel edits to the same worktree are strictly prohibited (`validateWorktreeConcurrency`, enforced at assignment).

The first implementation role to enter an Issue creates the worktree via `issue-implementation` and later ones resume it via `handoff-issue`; a **reviewer is dispatched with no skill at all**, because both implementation skills commit, and instead works read-only inside the existing worktree.

Review is bounded at two passes (`MAX_REVIEW_PASSES`). A `NEEDS_REVISION` verdict returns the Issue to the implementer for one fix cycle; `REJECTED` blocks immediately. Exhausting the budget blocks the Issue rather than looping.

An integration-gate rejection has its **own** single allowance (`MAX_GATE_REOPENS = 1`), tracked separately from the review passes: a gate rejection is a cross-Issue problem, not a code-review round, so it does not compete with the review budget for its first reopen. A second gate rejection blocks the Issue with `integration-gate-rejected-twice`. The reopen is still refused when no review pass remains to check the fix (`integration-gate-rejected`), because reopening without a following review would publish unreviewed work.

**Where review findings go.** The verdict (`PASS` / `NEEDS_REVISION` / `REJECTED`) travels as a `role-complete` event and is the only review data in graph state; findings text must never enter state, because the checkpointer persists it. The findings themselves are posted by the reviewer as a single pull request comment headed `role=reviewer pass=<N> verdict=<…>`, which makes GitHub the durable channel between two roles that share no process. A fix-cycle implementer receives `--fix-cycle <N>`, reads those comments with `gh pr view --comments`, pushes to the existing branch — it must not open a second PR — and posts its own `role=implementer fix-cycle=<N>` comment recording what it changed per finding. GitHub's native review feature is deliberately unused: the agents act with one human's credentials, so the PR author and the reviewer are the same account and an approve/request-changes state cannot be expressed. Running tests is part of the implementer's own skill run, and the reviewer receives the resulting test summary rather than re-running it. `--single-worker` restores the pre-`#482` behaviour of one worker per Issue.

Terminal mode/role telemetry is emitted exactly once, where the program truly stops: at release, or when the program blocks. Degradation (`degraded`) is recorded separately from why the mode was selected (`selectionReason`).

Under a role program, the `pr-created` milestone is reached by completing the program; reporting it while roles are still active is rejected (`role-program-active`) so dependents cannot be released on unreviewed work. Under `--release-policy merged` the program ends before the release milestone, and the run stays waitable for the external `merged` event rather than summarizing as blocked.

### 13.3 Role-Specific Context Schemas & Isolation (`#441`)

`src/shared/role-schemas.ts` defines dependency-free validators describing what each role may receive. **They are an executable specification, not an enforced boundary: nothing in the repository calls them at runtime today** — the only importer is their own unit test, and the workers are external CLI processes that never load this TypeScript module. They exist to make the intended per-role context reviewable and to keep the deny-list honest.

The shapes:

- **`PlannerInput` / `AnalystInput`**: Receives Issue title, body, repository rules, and codebase context.
- **`ImplementerInput`**: Receives task plan/analysis findings, Issue details, and target file boundaries.
- **`ReviewerInput`**: Receives **only** stated acceptance criteria, changed file paths, Git diff references, and test execution summaries. Chain-of-thought, raw model responses, and full conversation histories from the implementer are explicitly excluded.
- **`VerifierInput`**: Validates test execution evidence, Git/PR state, and acceptance criteria without re-running subjective review passes.
- **`HandoffInput`**: Carries Git state, completed steps, failure classification, and resume node payload.

All of them reject disallowed keys (`chainOfThought`, `rawModelResponse`, `toolHistory`, credentials, PII) when called.

**What is actually enforced** is the orchestration-side dispatch payload: `buildRoleDispatchPayload` runs `assertNoDisallowedKeys` over the same deny-list on the live path in both `dispatchWorkerNode` and `dispatchWorker`, and a contract test asserts the two lists stay identical. Giving the schemas a real runtime caller would require a worker-side preflight inside the skill — the workers assemble their own context, so only they are in a position to validate it. Until then, treat §13.3 as the specification and the payload deny-list as the guarantee.

### 13.4 Bounded Recovery, Handoff, and Safe Resume (`#445`)

Recoverable failures (session limits, timeouts, quota exhaustion, provider crashes) are handled per **worker process**, which since `#482` means per *role attempt* rather than per Issue: a three-role program has three independently interruptible processes, and a fix cycle adds more.

Enforced today:

- **Failure Classification**: `classifyFailure` splits errors into recoverable vs unrecoverable closed reason codes.
- **State & Worktree Preservation**: Handoff terminates only the worker process tree and preserves the Issue worktree, branch, uncommitted changes, role progress, and review counts; the interrupted role resumes as the same role on the new route.
- **Route Exclusion — two of three paths**: an explicit `worker-interrupted` event adds the failing agent to the run's unavailable list. A dispatch-time failure excludes the exact model, then re-probes the affected agent at graph fan-in and replaces the checkpointed capability pool before handoff; sibling models stay eligible only if that probe verifies them again. If the refresh fails, the run fails closed. The third path, the `check` lost-notification probe, deliberately excludes neither agent nor model: a worker found dead by the probe says little about its agent CLI, so the route stays in the pool.
- **Idempotency Protection**: Action dispatches, git commits, pushes, and PR creations are protected by deterministic `idempotencyKey(issue, action, attempt)` logic to prevent duplicate PRs or commits upon crash recovery.
- **Review Budget**: bounded independently in §13.2 (at most two review passes and one fix cycle per Issue, plus one integration-gate reopen). This budget is not consumed by a handoff — an interrupted reviewer resumes at the same `reviewPass`, so recovery cannot silently spend a review.
- **Worktree Provenance**: `select_handoff_route` decides the replacement's skill from recorded state (`worktreeCreated`), not by inferring a worktree from the existence of an execution record. A dispatch-failed attempt never created one, so its replacement runs the creating skill.

**Designed but not yet enforced**: the per-attempt "same-route retry at most once" and per-Issue "alternate-route handoff at most once" caps from `#445`. The `retryCounts` / `handoffCounts` state channels exist but no node reads or increments them, and `select_handoff_route` re-dispatches every interrupted Issue without consulting a budget, failing only when the pool is empty.

The consequence differs by interruption path, and this is the gap the caps must close first. Explicit interruption shrinks the pool by agent. Dispatch failure shrinks it by the exact failed model plus any sibling routes the targeted probe no longer verifies; a failed refresh stops the run. Those paths therefore terminate as verified alternatives are exhausted. On the **probe path the pool does not shrink**: a worker that dies silently is re-dispatched to the same route indefinitely, spending real tokens each cycle, with `attemptFor` minting a fresh idempotency key every time. Role-per-process dispatch multiplies the interruption points per Issue, making that path easier to reach than before `#482`. Restating the caps in role-attempt units and naming the node that decrements them is open work.

**Run durability and resume**: the orchestration run's single source of truth is its checkpoint file (`FileCheckpointSaver` in `scripts/project-issue-graph-checkpointer.mjs`, over `@langchain/langgraph-checkpoint`), selected by `--thread-id` and `--checkpoint-file`. Every `interrupt()` pause is durable, so a parent that dies mid-run resumes from the last committed node rather than restarting the Issue. Corruption fails closed with the reason codes `checkpoint-file-required`, `checkpoint-file-corrupt`, and `checkpoint-format-unsupported`; a partial or unreadable file is never treated as an empty run. Because an Issue now spans three or more detached worker processes recorded by `pid` / `pgid`, a resumed parent reconciles them rather than assuming they died with it: `dispatchCandidates` refuses to dispatch into an Issue whose recorded execution is still `running`, and the `check` event re-verifies liveness with a PID-reuse-safe probe (start time must not postdate the recorded dispatch) before anything is treated as dead.

### 13.5 LLMOps Telemetry & Offline Evaluation (`#442`, `#443`, `#444`)

1. **Privacy-Preserving Telemetry (`#442`, `#443`)**:
   - Implements append-only JSONL and SQLite event sinks (`scripts/project-issue-telemetry.mjs`).
   - Tracks correlation IDs across runs, nodes, roles, and routes.
   - Categorizes token usage as `exact`, `estimate`, or `unavailable` without inventing artificial values.
   - Records wasted execution taxonomy (`duplicate_node_execution`, `abandoned_worker`, `timeout`, `failed_handoff`).
   - Strictly prohibits storing raw prompts, responses, Issue bodies, diffs, credentials, or PII.

2. **Offline Evaluation Harness (`#444`)**:
   - Reconstructs sanitized episodes from telemetry logs (`scripts/project-issue-offline-eval.mjs`).
   - Provides deterministic state-transition replay to evaluate candidate routing policies.
   - Generates Quality-Token Frontier reports comparing terminal success rates, test/gate pass rates, PR merge rates, and quality-adjusted token efficiency without data leakage.

### 13.6 Optional Issue Triage Boundary (`#535`)

Jev is a development-only Issue classifier, separate from the desktop app's AI providers.
It is off by default. `project-issue-triage-client.mjs` starts one short-lived child
(`project-issue-triage.mjs`) with structured metadata over stdin. Only that child fetches
the Issue title/body and sends them to the fixed TypeSafe endpoint. Private repositories,
revision mismatches, detected credentials/personal values, and oversized requests fail
closed. The detector is a conservative tripwire, not proof that arbitrary prose contains
no personal information; operators must use public, reviewed development Issues with fake
examples. There is no vault, application state, diff, or tool-history input.

The parent accepts only validated enums, probability maps, version hashes, and integer
usage counts. Raw Issue text, HTTP responses, error bodies, and stderr never enter parent
state or telemetry. `TYPESAFE_API_KEY` is supplied through the triage child's environment
and removed before the GitHub CLI subprocess, worker dispatch, and worker process spawn. This is a data-flow boundary, not
an OS sandbox: child processes share the local user's filesystem privileges.

The contract module validates `TriageInput`, `TriageResult`, `TriageDecision`, and
`RouteEvidence`. A route can only refer to the supplied verified pool. Comparable,
recent benchmark evidence with identical task-kind coverage is required to ask a routing question; absent evidence yields
`abstain`, rather than an inference from model names. Mapping the Issue to those task kinds
remains a model instruction; shadow evaluation must establish its quality before adoption.
Acceptance validates the corresponding usable result, and preferred routes additionally
require a confident, non-abstaining route answer. Runtime availability checks belong
to the capability adapters, independently of suitability evidence.

The runner serializes requests and reserves each attempt durably before starting a child.
Reservations are never refunded, including preflight failures; at most 20 attempts are
allowed per run. A failed reservation prevents execution. Authentication or throttling
failures disable the provider for that run. The caller owns one runner and its durable
state. In graph shadow mode (#536), the file checkpoint saves a metadata-only request
fingerprint and the reservation before the child starts. Only closed triage results,
those fingerprints, and revision/pool hashes are checkpointed; the Issue body never
enters the checkpoint. A resumed run that finds an existing claim records a local
fallback and requires manual assignment; it never re-sends the request. The graph
refreshes CLI routes for each new selection batch, compares metadata and pool state
before first dispatch, and requires manual route assignment after a fallback or a
failed exact-route check. Shadow does not adopt Jev's risk, Size, mode, or route; later
roles and handoff keep the existing pool. Assisted adoption remains disabled pending
#538. There are no retries; HTTP time is capped at five seconds and the child process
tree at ten seconds. Request/response bodies are capped at 24/64 KiB, with redirects
rejected.

This opt-in boundary adds external processing of reviewed development text in exchange
for cheaper classification experiments. Shadow mode also costs autonomy: its route-refresh
and metadata-freshness checks can pause a run for manual assignment or fail it closed
where off mode would continue, because a fallback means the Issue could not be classified
safely and a person decides. Node's built-in fetch avoids an additional SDK;
keeping deterministic orchestration as the default preserves offline operation. Revisit
the choice if evaluation cannot meet the risk-recall/adoption gates, if API contracts or
retention terms change, or if process isolation needs an OS sandbox. The provider does
not have an assumed zero-retention guarantee: see the dated terms review in
[development.md](development.md#jev-triage-provider-terms-and-activation).
