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
│   ├── AutomationService (Playwright)
│   │   ├── Visibility login / collection today; update / withdraw / register later
│   │   ├── wall detection -> hand-off -> resume
│   │   └── ephemeral browser contexts by default
│   ├── DefinitionService (Agent layer, §7 below — Slices B-D only, not yet ported)
│   ├── AiAnalysisService (optional)
│   │   └── structure-only provider calls
│   └── IpcApi (typed, narrow, allowlisted commands)
│
├── preload
│   └── contextBridge exposing typed Soroeru API only
│
└── renderer (untrusted UI surface, React + Vite)
    ├── vault setup / unlock (`VaultGate`)
    ├── CSV import and saved-page import (`CsvImportPanel`, `SavedPageImportPanel`)
    ├── Visibility collection run (`CollectionPanel`)
    ├── Disclosure ledger, filters, and Reflection (`LedgerPanel`, `InsightsPanel`)
    ├── site management / batch collection (`SiteManagementPanel`)
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
- **Automation**: `src/automation/` (`browser-engine.ts`, `page-driver.ts`,
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
invited beta users. Windows, Linux, mobile, and browser-extension distribution are
post-MVP (see [`requirements.md`](requirements.md) §9).

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
| Runtime / language | **Node.js + TypeScript + Electron** | Playwright's primary runtime is Node-compatible; Electron main can run Playwright, vault services, and provider SDKs without a sidecar. TypeScript keeps page snapshots, the Disclosure ledger, Policy, and IPC contracts shared and typed end to end. |
| UI | **React + Vite + TypeScript** in the Electron renderer, with `contextIsolation`, `sandbox`, and `nodeIntegration: false`; all privileged operations go through typed preload IPC | Soroeru's UI is mostly ledger tables, filters, forms, confirmation gates, policy settings, and reflection surfaces — React's ecosystem is strongest for accessible primitives, form validation, and virtualized tables. |
| Browser automation | **Playwright Library**, headed | Unified automation API across Chromium / Firefox / WebKit; supports a live headed session the user can take over for MFA/CAPTCHA. Default packaged engine is Chromium for packaging simplicity; Firefox/WebKit remain compatibility targets behind the same `BrowserEngine` abstraction. |
| Browser session policy | **Ephemeral Playwright contexts by default; opt-in per-Site-Account encrypted `storageState` persistence** (Issue #294), toggled from the ledger's site detail view; no raw browser profile or cookies persisted as durable plaintext outside the vault | For sites that treat a fresh context as automation-suspicious, the user may opt in per site to reuse a session. The exported `storageState` is stored as an encrypted Vault v2 record (`sessionState`, AES-256-GCM / Argon2id, same as every other record) — never a raw browser profile — with a fixed 30-day sliding expiry and immediate clearing on opt-out. If the app exits mid-run, the run is safely stopped and resumed/retried from encrypted workflow state, not from a raw browser profile. |
| Browser channel | Packaged Chromium by default; **`BrowserEngine` accepts an opt-in `channel: "chrome"`** to launch the user's installed Google Chrome instead, falling back to packaged Chromium if it is not installed (Issue #293) | Some sites treat the bundled Chromium build as more automation-suspicious than a real Chrome binary. The option is opt-in and off by default (no UI wiring yet, separate from the `storageState` persistence toggle above, which is unwired to `channel: "chrome"`). |
| Local encrypted storage | **Vault v2**: a versioned encrypted record vault (§3), not a plaintext SQLite database or a single encrypted JSON blob | Matches the AES-256-GCM + Argon2id requirement, avoids native DB dependencies, and supports entity-by-entity migration and audit records. SQLCipher SQLite may be revisited later if ledger scale, query performance, or concurrent access becomes a real constraint. |
| AI provider abstraction | **Deterministic-first**; optional Anthropic/OpenAI adapters are stateless, structure-only, and user-configured | Matches the requirement that raw values never leave the local process; AI proposes (structure classification, terms summarization, Constraint findings), Policy/Delegation decides. |
| Packaging | **Unsigned macOS DMG** for the MVP, via **Electron Forge `maker-dmg`**, with clear Gatekeeper instructions and no auto-update | Matches the macOS-only MVP, removes the user's Node.js prerequisite, and bundles the app plus the default Playwright browser. Signing/notarization, auto-update, and other platforms are explicitly later. |
| Package manager | **npm** | The repo already has a lockfile; the dependency graph is not large enough to justify pnpm/Yarn. |
| Renderer build | **Vite** | Most direct match for React + TypeScript in Electron; keeps the UI iteration loop fast. |
| Main/preload build | **`tsc`** | Type-correctness first; add bundling only if packaging proves it necessary. |
| Unit tests | **Node built-in test runner** | Keeps the dependency surface small for domain/vault/service tests. |
| Browser E2E | **Playwright Test** | Reuses the product's own automation library for new Soroeru E2E and packaging smoke. |
| Formatting / linting | **Prettier + ESLint** | Standard, low-friction baseline once React/Electron source exists. |

### 2.1 Decision alternatives and reconsideration triggers

The table above records the current target stack. The following load-bearing decisions have
known alternatives and concrete triggers for reconsideration:

- **Electron desktop app**: lighter desktop shells (Tauri, native Swift/AppKit, or a
  browser-extension-only surface) were considered but not selected for the MVP because the
  trusted main process needs to own Vault v2, headed Playwright automation, typed IPC, and
  provider SDK integration in one inspectable Node/TypeScript runtime. Reconsider if the
  package size or idle memory footprint is recorded as a release blocker in beta feedback
  or the release-candidate checklist, or if Electron's sandbox/process model prevents a
  required macOS security or distribution constraint.
- **Packaged browser engine defaults to Chromium**: bundling all Playwright engines was
  considered but deferred to keep the first DMG smaller and reduce packaging failure modes.
  Firefox/WebKit remain compatibility targets behind `BrowserEngine`, so this is a
  distribution choice rather than a product-level Chromium lock-in. Reconsider if Visibility
  collection has two or more confirmed beta-site failures that pass on Firefox or WebKit
  with the same workflow, or if beta support requires a second bundled engine to satisfy the
  browser-engine independence goal.
- **`channel: "chrome"` stays opt-in, unwired to any setting**: a full Soroeru-owned Chrome
  extension (#291) was evaluated as a heavier alternative and not selected for this increment;
  `channel: "chrome"` needed no new extension surface, native host, or packaging change, so it
  landed first as the minimal `BrowserEngine` option. Real-site pass/fail comparison data
  between packaged Chromium and `channel: "chrome"` was not collected in this Issue (no
  real-site network access or test credentials in this environment, and `docs/testing.md`
  restricts automated tests to local fixtures) — the option exists for manual beta evaluation.
  Reconsider promoting it to a user-facing setting once manual beta testing records at least
  one confirmed site where `channel: "chrome"` collects data that packaged Chromium fails to.
  This option is independent of the `storageState` persistence decision below: it is
  unwired to it, and the two questions (which browser binary launches a session, and whether
  a session is reused across runs) were decided on separate timelines.
- **Opt-in `storageState` persistence uses a flat 30-day expiry and a simple per-Site-Account
  toggle** (Issue #294): two narrower alternatives were considered and rejected for this
  increment — (a) gating the toggle on the still-undecided #291 permission model instead of
  its own boolean field, and (b) a variable expiry keyed to per-site risk tier instead of one
  fixed duration for every site. Unlike `channel: "chrome"` above, this decision was **not**
  gated on beta comparison data: the Product Owner decided the simple/fixed model directly
  in-session (`docs/design/storage-state-persistence.md`), since reusing a session across runs
  is a separate question from which browser binary launches it. Reconsider tying the toggle to
  #291's permission model once that model ships, or reconsider a risk-tiered expiry if beta
  feedback shows a flat 30 days is wrong for high-risk sites (either direction changes the
  `sessionState` record shape and the ledger's session-persistence UI, so it is tracked here
  as a decision, not left implicit in the table row above).
- **Soroeru-owned Chrome extension + Native Messaging + Electron bridge stays a designed,
  unselected option** (Issue #291): a design spike
  ([`design/issue-291-chrome-extension-bridge.md`](design/issue-291-chrome-extension-bridge.md))
  compared it against the current Playwright path (with `channel: "chrome"` and encrypted
  `storageState` above) and a localhost-WebSocket variant, and concluded it is a post-MVP
  architecture option whose first implementation would be a developer-only, feature-flagged
  prototype — not an MVP scope change; browser-extension distribution stays post-MVP (§1).
  The extension would sit behind the same `PageDriver` seam as a second session surface, so
  the Playwright path is preserved, not replaced. The option is a front-door use of the
  user's own profile, not bot-detection evasion: no fingerprint/UA spoofing, no stealth, no
  wall bypass, and the automation is visibly indicated via the extension badge and an
  in-page banner (design §1/§7; [`security.md`](security.md) §7 unchanged). The
  reconsideration trigger — manual beta testing showing sites that still fail collection
  due to bot/risk checks with `channel: "chrome"` plus persisted `storageState`, with the
  failure attributed to the browser surface rather than selector/flow mismatch — **fired on
  2026-07-10**: the Product Owner's manual beta evaluation found no collection-rate
  improvement at all from either option (the implementing PRs #295/#297 had explicitly
  deferred real-site comparison to manual beta). The design's follow-up implementation
  Issues are filed as **#335–#340**; the first implementation stage remains the
  developer-only, feature-flagged prototype, and browser-extension distribution remains
  post-MVP. The design depends only on public Chrome extension /
  Native Messaging APIs — never on the Codex extension or any undocumented protocol.
- **Unsigned DMG with no auto-update for MVP**: signing/notarization, auto-update, App Store
  distribution, and zip-only delivery were considered but deferred. The unsigned DMG best
  matches the small private beta while making Gatekeeper friction explicit and avoiding
  release infrastructure that is not yet required. Reconsider when distribution moves beyond
  invited beta users, when manual upgrade friction blocks validation, or when Developer ID
  signing/notarization credentials become available for a release issue.

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

**Reveal flow**: a stored site-held Disclosure value is masked by default. Revealing it
(`revealValue`) requires re-verifying the master passphrase for that single reveal and is
refused outright for most-sensitive attributes (the card CVV). The renderer must show a
revealed value transiently and never persist it.

## 5. Slice A: Visibility (implemented)

Slice A's goal is not "automate a lot." It is to create the first threshold-crossing
experience: the user sees their scattered online footprint at once.

### 5.1 Flow

1. **Vault setup / unlock** (`VaultGate`).
2. **CSV import**: create Site Account and Credential seeds (`CsvImportPanel`); a saved
   local account page (HTML) can also be imported manually as a fallback
   (`SavedPageImportPanel`, when auto-login/collection cannot reach a page).
3. **Visibility run** (`CollectionPanel`, `VisibilityService`):
   - open an ephemeral Playwright browser session per selected Site Account
     (`BrowserEngine.openSession`);
   - navigate to the site and log in with the stored credential;
   - detect walls; hand off in the same page/context; the run pauses and the renderer
     receives a `handoff` event with instruction text; the user resolves the wall and the
     run resumes (§6);
   - find profile/account/billing/newsletter pages using deterministic discovery first,
     then (later) optional structure-only AI proposal;
   - collect field/text values locally (`disclosure-collector.ts`);
   - classify values into Disclosures and Account Relationships;
   - store encrypted records plus Evidence/Audit.
4. **Ledger view** (`LedgerPanel`): a spreadsheet-style table (sites as rows, the union of
   observed attributes as horizontally-scrollable columns) backed by `ledgerSiteDetails`
   (all sites' composed detail in one call); per-site composed detail (`ledgerSite`) and
   cross-site summaries (`ledgerSites`) remain available for `SiteManagementPanel`'s
   per-row "詳細" flow.
5. **Initial Reflection / filters** (`InsightsPanel`): `ledgerInsights` /
   `computeLedgerInsights` summarize stale, risky, over-disclosed, newsletter, billing, and
   not-fully-checked findings without turning them into pressure to approve blindly.

### 5.2 Collection strategy

Collection uses (currently, for Slice A) two tiers, with a third planned:

1. **Deterministic discovery**:
   - login form traits;
   - account/profile/billing/newsletter link text;
   - field labels, `autocomplete`, `name`, `id`, placeholder, nearby text
     (`src/agent/scan.ts`, `src/agent/classifier.ts`);
   - Japanese-only matching for MVP.
2. **Optional AI proposal** (planned): receives page structure, labels, terms text, and
   redacted snippets only; returns candidate page purpose, field mapping, and
   risk/Constraint findings; never sees raw personal values and never decides execution.
3. **Official/local site definitions** (§7) are a later tier for Slice A and are the
   primary tier already implemented for the not-yet-ported registration/withdrawal PoC.

Unclear values become `unknown` Disclosures or review tasks (surfaced to the user as
pending dynamic-attribute candidates), not guessed data.

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
text and evidence. The user resolves the step in the same headed browser session; the
renderer then calls `resumeVisibility` (continue) or `abortVisibility` (stop; never
bypasses). Detection is conservative and never attempts to solve, bypass, outsource, or
obscure a wall; see [`security.md`](security.md) §7.

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

1. scan the current page / flow with Playwright (`PageSnapshot`);
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
| CVV most sensitive | Stored encrypted; reveal is refused outright (§4); fill requires a dedicated accessor. |
| Raw PII never to AI | The agent/AI layer accepts structure-only requests; provider adapters validate redaction. |
| Egress limited | Architectural egress classes are target-site, ai-provider, and the identity-auth broker route to the Digital Agency (§9); the current static checker covers the implemented target-site / ai-provider classes and must add an identity-auth-broker category before broker code lands. No telemetry dependencies. |
| CSV contains plaintext passwords | Import buffer is local, encrypted immediately, never logged, discarded after processing (§3.4). |
| Local diagnosability without telemetry | Encrypted `diagnostic` records plus sanitized rotating operational logs and user-initiated support-bundle export (§3.5); no automatic upload. |
| No active-control bypass | Wall detection (§6) is separate from classification; detected walls stop or hand off. |
| Review gate / three guards / fourth boundary | Domain/Policy services decide (later slices, §8); the renderer only renders the gate. |
| ToS automation prohibition | Constraint record + high-risk UI; user decides; active controls still never bypassed. |
| No raw browser profile at rest | Ephemeral Playwright contexts (§2); future session persistence must be encrypted vault state. |

## 11. Field Detection And Measurement

Soroeru keeps the deterministic-vs-AI comparison because it directly protects agency:
wrong mapping makes the user choose over false information.

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
