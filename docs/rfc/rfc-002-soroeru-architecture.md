# RFC-002: Soroeru Architecture And Technology Selection

Status: Accepted
Date: 2026-06-26
Owner: Soroeru / Soroeru maintainers

## Summary

Soroeru is not primarily a form-filling app. It is a local-first **agency engine** that
turns formal choices about personal information, accounts, and online contracts into
choices the user can actually exercise.

This RFC selects the MVP architecture and technology stack from that requirement:

- **Runtime / language**: TypeScript on Node.js, packaged as an **Electron** desktop app.
- **UI**: Electron renderer with React + Vite + TypeScript, using accessible component
  primitives and a table/form stack appropriate for ledger and policy surfaces.
- **Automation**: Playwright Library in headed mode, run from the Electron main process
  through a narrow Soroeru automation service.
- **Browser session policy**: ephemeral Playwright contexts by default; hand-off/resume
  happens in the same live headed session, but browser profiles/cookies are not persisted
  outside the encrypted vault.
- **Vault**: a versioned encrypted record vault, not a plaintext SQLite database. Each
  logical entity is stored as an AES-256-GCM encrypted record under an Argon2id-derived
  master key, with PBKDF2-HMAC-SHA-512 as the Web-Crypto-only fallback.
- **Domain core**: typed services for Personal Attributes, Site Accounts, Disclosures,
  Account Relationships, Mandates, Evidence/Audit, Policy/Preference, Delegation
  Boundary, and Reflection.
- **AI**: deterministic-first. Optional Anthropic/OpenAI provider adapters receive only
  page structure, terms text, and redacted snippets; raw personal values never leave the
  local process.
- **Packaging**: unsigned macOS DMG for MVP, built without requiring Node.js on the user's
  machine. Signing, notarization, auto-update, non-macOS builds, and hosted services are
  out of scope for the MVP.

This supersedes the previous registration-first Electron epic (#156-#162) and absorbs the
control-plane direction from #163 into a requirements-first Soroeru architecture. Those
Issues should be closed or rebaselined after this RFC is accepted, and new implementation
Issues should be created for Soroeru Slice A.

## 1. Requirements That Drive The Architecture

The architecture is derived from [`../requirements.md`](../requirements.md), especially:

- North Star: agency acquisition, not delegation of will.
- Slice order: **A Visibility -> B Bulk Update -> C Withdrawal cleanup -> D New
  registration**.
- First slice: import a Google/Chrome Password Manager CSV, auto-log in, collect the
  user's registered personal information, build a Disclosure ledger, and surface filtered
  lists such as newsletter and recurring-billing sites.
- Delegation Boundary: L0 confirm-required by default; L1 in-policy automation only after
  user-initiated expansion; L2 out of MVP.
- Hard safety line: never bypass CAPTCHA, MFA, bot detection, rate limits, paywalls, or
  access controls.
- ToS stance: detected automation-prohibiting terms are surfaced as Constraints for the
  user to decide; they are not silently hard-blocked and active controls are never
  bypassed.
- Local-first: no hosted vault, telemetry, analytics, crash reporting, or raw personal
  data egress.

The resulting design treats Soroeru as:

- a **control layer** for user agency and policy;
- a **memory layer** for local encrypted personal-data state;
- an **execution layer** for browser toil;
- a **reflection layer** where the user learns what changed and what they can now do.

## 2. Decision Matrix

### 2.1 Runtime / language

| Option | Fit | Rejected / accepted reason |
| --- | --- | --- |
| Node.js + TypeScript + Electron | Strong | Playwright's primary runtime is Node-compatible; Electron main can run Playwright, vault services, and provider SDKs without a sidecar. TypeScript keeps page snapshots, MappingPlan, Disclosure, Policy, and IPC contracts shared. |
| SwiftUI app + Node Playwright sidecar | Medium | Excellent macOS integration, but Playwright still requires a separate automation runtime. The sidecar boundary makes vault/automation lifecycle, packaged browsers, logging, and crash cleanup harder for the first slice. |
| Tauri shell + Node Playwright sidecar | Medium | Smaller shell, but the MVP still needs Node plus Playwright browsers. Once the sidecar and browser bundle are included, the main advantage shrinks while IPC/process lifecycle complexity increases. |
| Rust-first native core | Medium later | Attractive for a long-lived vault/policy core, but Slice A's highest-risk work is browser automation and hand-off. Adding Rust now increases FFI/IPC surface before the domain model has implementation evidence. |

**Decision**: adopt **Node.js + TypeScript + Electron** for the MVP. This is a
requirements-derived decision, not asset lock-in: the same stack best satisfies headed
automation, single-process lifecycle control, macOS packaging, and typed product-domain
iteration for Slice A.

### 2.2 UI layer

| Option | Fit | Rejected / accepted reason |
| --- | --- | --- |
| React + Vite + TypeScript in Electron renderer | Strong | Soroeru's UI is mostly ledger tables, filters, forms, confirmation gates, policy settings, and reflection surfaces. React's ecosystem is strongest for accessible component primitives, form validation, and virtualized tables. |
| SwiftUI | Medium | Native and elegant, but it creates a split-language product while automation remains Node/Playwright. Better revisited if the long-term app becomes OS-integration-heavy and automation is modularized. |
| Server-rendered local HTTP UI | Weak | Useful for development, but a product UI served over localhost widens the attack surface and feels less like a local trusted place for agency reflection. |

**Decision**: use **React + Vite + TypeScript** inside Electron. The renderer runs with
`contextIsolation`, `sandbox`, and `nodeIntegration: false`; all privileged operations go
through typed preload IPC.

Recommended UI libraries for Slice A implementation Issues:

- accessible primitives: Radix UI / shadcn-style wrappers or an equivalent audited set;
- tables: TanStack Table / Virtual or equivalent;
- forms and validation: react-hook-form + zod or equivalent schema validation.

The specific package names are implementation details, but any alternative must satisfy
accessibility, table scale, and typed validation.

### 2.3 Browser automation

| Option | Fit | Rejected / accepted reason |
| --- | --- | --- |
| Playwright Library, headed | Strong | Provides a unified automation API across Chromium/Firefox/WebKit and supports a live headed session the user can take over for MFA/CAPTCHA. |
| WebExtension + Native Messaging | Medium later | Semantically close to "the user's own browser," but harder for first-run distribution, cross-browser parity, install permissions, and autonomous collection across many sites. Better as a later companion adapter. |
| Raw browser extension only | Weak | Cannot own the encrypted vault, cross-site workflow queue, provider calls, or macOS app packaging cleanly. |
| Selenium / WebDriver | Weak | Viable automation, but Playwright has stronger modern page/context APIs and is already the product's testing basis. |

**Decision**: use **Playwright Library** as the runtime automation layer. The default
packaged engine is Chromium for Slice A packaging simplicity; Firefox/WebKit remain
compatibility targets behind the same `BrowserEngine` abstraction and in the test matrix
where feasible.

**Session policy**:

- Use a Soroeru-owned headed browser launched from the app.
- Use ephemeral contexts by default.
- Keep cookies/session state only for the active workflow unless a later Issue explicitly
  designs encrypted session persistence.
- If session persistence is introduced later, store exported `storageState` encrypted in
  the vault; never leave raw browser profiles or cookies as durable plaintext state.
- Hand-off/resume happens in the same live page/context. If the app exits, the run is
  safely stopped and must be resumed or retried from encrypted workflow state, not from a
  raw browser profile.

### 2.4 Local encrypted storage

| Option | Fit | Rejected / accepted reason |
| --- | --- | --- |
| Versioned encrypted record vault | Strong | Matches AES-256-GCM + Argon2id requirements, avoids native DB dependencies, and supports entity-by-entity migrations and audit records. In-memory indexes are enough for MVP-scale ledgers. |
| Single encrypted JSON document | Medium | Simple but too coarse for Disclosure rows, audit events, migration, and future compaction. |
| SQLCipher SQLite database | Medium later | Good relational fit and widely used for encrypted SQLite files, but it adds native packaging complexity and does not by itself satisfy the exact existing AES-GCM/KDF policy without careful key handling. |
| Plain SQLite with encrypted columns | Weak for MVP | Query flexibility comes at the cost of easy mistakes: plaintext metadata leakage, ad hoc column policies, and more migration surface. |

**Decision**: create **Vault v2: a versioned encrypted record vault**.

Vault v2 keeps the current security shape but makes the logical model first-class:

- file header: version, KDF parameters, vault metadata, optional recovery wrapper;
- record envelope: `recordId`, `entityKind`, `schemaVersion`, `iv`, `ciphertext`, `tag`,
  `createdAt`, `updatedAt`;
- encrypted payload kinds: `personalAttribute`, `siteAccount`, `credential`,
  `disclosure`, `accountRelationship`, `mandate`, `policy`, `preference`, `capability`,
  `constraint`, `evidence`, `reflection`, `workflowCheckpoint`, `providerSettings`,
  `localDefinition`, `diagnostic`;
- in-memory indexes after unlock for account/domain/attribute queries;
- encrypted export/import remains the only export path.

All raw values are inside encrypted payloads. Soroeru may store keyed hashes/fingerprints
inside encrypted payloads for comparison and audit. Anything needed before unlock must be
non-sensitive and minimal; if unsure, encrypt it.

SQLCipher can be revisited after Slice A if ledger scale, query performance, or concurrent
access becomes real. Until then, the encrypted record vault better preserves the
requirements while reducing native-packaging risk.

### 2.5 AI provider abstraction

| Option | Fit | Rejected / accepted reason |
| --- | --- | --- |
| Deterministic-first + optional Anthropic/OpenAI adapters | Strong | Matches requirements and keeps raw values local. AI helps classify structure, summarize terms, and propose Constraints; Policy/Delegation decides. |
| Always-on cloud AI | Weak | Violates deterministic default and risks dependence / blind approval. |
| On-device-only AI | Medium later | Privacy-attractive, but platform availability and model capability are not stable enough to make it the MVP dependency. |
| CLI/agent integration | Weak | Hard to constrain permissions and structured outputs; explicitly out of MVP scope. |

**Decision**: deterministic-first. AI adapters are optional, user-configured, stateless, and
structure-only. Provider responses are proposals; Soroeru services validate and decide.

### 2.6 Packaging / distribution

| Option | Fit | Rejected / accepted reason |
| --- | --- | --- |
| Electron DMG, unsigned for MVP | Strong | Matches macOS-only MVP, removes user Node prerequisite, and can bundle app resources and the default Playwright browser. |
| Existing ZIP wrapper | Weak | Requires Node on the user's machine and preserves the old local-web-app delivery model. |
| Signed/notarized DMG | Strong later | Correct for public distribution, but explicitly out of MVP due to Developer Program cost and release scope. |
| Mac App Store | Weak for MVP | Too much review/sandbox/distribution overhead for an automation-heavy private beta. |

**Decision**: target an **unsigned macOS DMG** for the MVP, with clear Gatekeeper
instructions and no auto-update. Use **Electron Forge maker-dmg** as the default packaging
path because it is Electron-owned, has explicit DMG maker support, and keeps the first
packaging implementation close to the chosen runtime. A later implementation Issue may
switch to another packager only if Playwright browser bundling or CI artifact generation
blocks Forge, and must document the requirement reason. The RFC-level requirement is a DMG
artifact that runs without a system Node.js install.

### 2.7 Development tooling

| Concern | Options considered | Decision |
| --- | --- | --- |
| Package manager | npm / pnpm / Yarn | **npm** for MVP. The repo already has a lockfile, GitHub Actions support is simple, and the dependency graph is not large enough to justify a migration. Revisit only if workspace scale demands it. |
| Renderer build | Vite / webpack / custom esbuild | **Vite** for renderer development and production builds because it is the most direct match for React + TypeScript in Electron and keeps the product UI iteration loop fast. |
| Main/preload build | `tsc` / tsup / esbuild / Vite multi-target | **`tsc` first** for main/preload and shared services, because type-correctness is more important than bundling early. Add bundling only when Electron packaging proves it is needed. |
| Unit tests | Node built-in test runner / Vitest / Jest | **Node built-in test runner** for domain/vault/service tests until UI/component testing needs a browser-like runner. It keeps the dependency surface small. |
| Browser E2E | Playwright Test / custom Playwright runner | **Playwright Test** for new Soroeru E2E and packaging smoke where possible; custom runners are allowed only for measurement tools that need product-specific output. |
| Formatting / linting | none / Prettier + ESLint | Add **Prettier + ESLint** in the first implementation Issue that introduces React/Electron source files. Until the commands exist, docs must not claim they are available. |

This tooling choice is intentionally conservative: it changes the product architecture
without also changing every development habit at once. Future Issues may replace a tool,
but must state the Soroeru requirement that makes the change necessary.

## 3. Target Architecture

```text
Soroeru.app (Electron)
├── main process (trusted)
│   ├── VaultService
│   │   ├── encrypted record vault
│   │   ├── unlock / lock / recovery / migration
│   │   └── in-memory indexes while unlocked
│   ├── DomainService
│   │   ├── Personal Attributes
│   │   ├── Site Accounts
│   │   ├── Disclosures
│   │   ├── Account Relationships
│   │   ├── Mandates / Evidence / Audit
│   │   ├── Policy / Preference
│   │   ├── Delegation Boundary
│   │   └── Reflection
│   ├── AutomationService (Playwright)
│   │   ├── login / collect / update / withdraw / register
│   │   ├── wall detection -> hand-off -> resume
│   │   └── ephemeral browser contexts by default
│   ├── DefinitionService
│   │   ├── deterministic site/page/field definitions
│   │   ├── encrypted local candidate definitions
│   │   └── promotion / validation pipeline
│   ├── AiAnalysisService (optional)
│   │   └── structure-only provider calls
│   └── IpcApi (typed, narrow commands)
│
├── preload
│   └── contextBridge exposing typed Soroeru API only
│
└── renderer (untrusted UI surface)
    ├── vault setup / unlock
    ├── CSV import and queue review
    ├── Disclosure ledger and filters
    ├── Reflection surfaces
    ├── Delegation Boundary settings
    ├── review-and-confirm gates
    └── provider/settings UI
```

Trust rule: the renderer never receives broad filesystem, network, browser, or vault
authority. It requests operations through typed IPC and receives redacted/sanitized views
unless the user explicitly reveals sensitive fields through a re-authenticated flow.

## 4. Domain Model And Persistence Mapping

### 4.1 Entity overview

| Domain entity | Persistence payload | Notes |
| --- | --- | --- |
| Personal Attribute | `personalAttribute` | Canonical value, label, type, updatedAt, sensitivity. Value encrypted. |
| Site Account | `siteAccount` | Site/domain, login anchor, display name, relationship summary. No copied raw PII. |
| Credential | `credential` | Username/password imported from CSV or entered by user. Value encrypted, linked to Site Account. |
| Disclosure | `disclosure` | Account + attribute + site-held value reference/hash + as-of + evidence. This is the core ledger edge. |
| Account Relationship | `accountRelationship` | Newsletter, recurring billing, last-used, membership state, confidence, evidence. |
| Constraint | `constraint` | ToS automation prohibition, wall encountered, payment/high-risk terms, unknown state. |
| Mandate | `mandate` | What the user authorized: collection, update, withdrawal, registration, policy expansion. |
| Evidence / Audit | `evidence` | References, hashes, page URLs, timestamps, masked snippets; no raw unencrypted values. |
| Policy / Preference | `policy`, `preference` | Safe defaults, user selections, suggestion history, promotion state. |
| Delegation Boundary / Capability | `capability` | Operation-specific L0/L1 status, understanding checks, reductions. |
| Reflection | `reflection` | Initial footprint and post-action change records. |
| Workflow checkpoint | `workflowCheckpoint` | Queue and resumability metadata, never raw browser profile state. |

### 4.2 Disclosure row shape

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

### 4.3 Evidence and audit

Evidence should make decisions inspectable without turning logs into a second vault leak:

- store page URL, timestamp, field labels, field type, masked snippet, normalized hash;
- never store screenshot pixels, full HTML, cookies, tokens, or raw values by default;
- if a future feature needs richer evidence, it must be encrypted and explicitly scoped.

### 4.4 CSV import

The importer accepts Google/Chrome Password Manager CSV columns:

```text
name,url,username,password,note
```

Required behavior:

- parse locally only;
- validate size and row count before processing;
- encrypt credentials immediately as `credential` records;
- create or update Site Account seeds;
- never log username/password/note values;
- discard the raw CSV buffer after import;
- do not re-export plaintext credentials.

Soroeru should ask the user to delete the original exported CSV after successful import,
but it must not silently delete a user-selected file outside its vault.

## 5. Slice A: Visibility Design

Slice A's goal is not "automate a lot." It is to create the first threshold-crossing
experience: the user sees their scattered online footprint at once.

### 5.1 Flow

1. **Vault setup / unlock**.
2. **CSV import**: create Site Account and Credential seeds.
3. **Queue review**: show imported site count, domains, and sensitive-data handling.
4. **Visibility run**:
   - launch a headed Playwright browser;
   - for each selected Site Account, create an ephemeral context;
   - navigate to the site and log in with the stored credential;
   - detect walls; hand off in the same page/context; resume after the user resolves them;
   - find profile/account/billing/newsletter pages using definitions first, then safe
     deterministic link discovery, then optional structure-only AI proposal;
   - collect field/text values locally;
   - classify values into Disclosures and Account Relationships;
   - store encrypted records plus Evidence/Audit.
5. **Ledger view**: show per-site composed view and cross-site filters.
6. **Initial Reflection**: summarize stale, risky, over-disclosed, newsletter, and billing
   findings without turning them into pressure to approve blindly.

### 5.2 Collection strategy

Collection uses three tiers:

1. **Official/local definitions** for known sites and page types.
2. **Deterministic discovery**:
   - login form traits;
   - account/profile/billing/newsletter link text;
   - field labels, `autocomplete`, `name`, `id`, placeholder, nearby text;
   - Japanese-only matching for MVP.
3. **Optional AI proposal**:
   - receives page structure, labels, terms text, and redacted snippets only;
   - returns candidate page purpose, field mapping, and risk/constraint findings;
   - never sees raw personal values and never decides execution.

Unclear values become `unknown` Disclosures or review tasks, not guessed data.

### 5.3 Account Relationship filters

Slice A must produce at least these derived Options:

- sites with likely active newsletter subscription;
- sites with likely recurring billing / free-trial conversion;
- sites with stale phone/address/card;
- sites not checked because a wall or unknown flow stopped collection.

Each filter item links back to evidence and the next safe action. The UI should create the
"suddenly I can" feeling without collapsing judgment into a single bulk-approve button.

### 5.4 Delegation for Slice A

Visibility is still a world-touching action because it logs in and reads data.

- Default: L0 for the first collection run.
- L1 may be opened for "collect registered information from imported sites" after the user
  understands what is collected and where it is stored.
- L1 never bypasses walls and never silently proceeds past detected automation-prohibiting
  ToS; Constraints are surfaced for user decision.
- Soroeru-internal data deletion always requires explicit confirmation.

## 6. Security And Privacy Mapping

| Requirement | Architecture decision |
| --- | --- |
| Local encrypted vault | Vault v2 encrypted records; no hosted service. |
| Memory-hard KDF | Argon2id primary; PBKDF2-HMAC-SHA-512 fallback only where required. |
| Derived key in memory only | VaultService owns unlock/lock lifecycle; renderer never receives the key. |
| CVV most sensitive | Stored encrypted; reveal/fill requires dedicated accessor and optional passphrase re-check. |
| Raw PII never to AI | AiAnalysisService accepts structure-only requests; provider adapters validate redaction. |
| Egress limited | Network calls categorized as target-site or ai-provider; no telemetry dependencies. |
| CSV contains plaintext passwords | Import buffer is local, encrypted immediately, never logged, discarded after processing. |
| No active-control bypass | WallDetectionService is separate from classification; detected walls stop or hand off. |
| Review gate / three guards / fourth boundary | PolicyService and DelegationBoundaryService decide; UI renders the gate. |
| ToS automation prohibition | Constraint record + high-risk UI; user decides; active controls still never bypassed. |
| No raw browser profile at rest | Ephemeral Playwright contexts; future session persistence must be encrypted vault state. |

## 7. Field Detection And Measurement

Soroeru keeps the deterministic-vs-AI comparison because it directly protects agency:
wrong mapping makes the user choose over false information.

Measurement plan:

- define local fixtures for Slice A page types: login, profile, address, phone, card,
  newsletter, billing, MFA wall, ToS constraint;
- run deterministic and AI-assisted mapping against the same PageSnapshot shape;
- record success rate, mis-mapping rate, unknown/stop rate, wall hand-off accuracy;
- prefer "unknown / ask" over confident wrong mapping;
- no raw values in measurement artifacts.

Existing `src/agent/scan.ts`, `src/agent/classifier.ts`, wall detection, guard analysis,
CSV importer, and privacy static checks are reusable candidates, but they must be
re-shaped around the Disclosure ledger and Slice A before being treated as product code.

## 8. Build, Test, And Quality Gates

### 8.1 MVP commands to introduce

Implementation Issues should add or update commands along these lines:

```bash
npm run typecheck
npm test
npm run test:e2e
npm run check:egress
npm run check:persistence
npm run check:bypass
npm run package:dmg
npm run release:check
```

Names may differ, but the owning docs must describe the real commands only after they
exist.

### 8.2 Test coverage

Required coverage for Slice A:

- vault v2 migration/unlock/lock/recovery/export/import;
- CSV import safety (size, parse, encrypt, discard, no plaintext export);
- Disclosure stale-state derivation;
- Account Relationship filters;
- Delegation Boundary L0/L1 expansion/reduction;
- ToS Constraint surfacing;
- wall detection and hand-off/resume;
- AI redaction tests;
- no telemetry / no bypass dependency checks;
- Electron IPC permission tests (`contextIsolation`, no broad renderer authority);
- DMG smoke on macOS before private beta sharing.

Docs-only changes may continue to use `git diff --check`.

## 9. Relationship To Prior Work

| Prior Issue | Decision |
| --- | --- |
| #156 Electron + Vite desktop Epic | Superseded as written because it is registration-first. Rebaseline into new Soroeru implementation Issues if Electron remains the selected shell. |
| #157 core service extraction | Reuse the intent (headless services), but re-scope around Soroeru DomainService and Slice A. |
| #158 Electron + React skeleton | Rebaseline under this RFC; still directionally aligned. |
| #159 Playwright integration | Rebaseline around Visibility auto-login/collection, ephemeral contexts, and encrypted workflow checkpoints. |
| #160 renderer Part 1 | Rebaseline; first renderer work is vault + CSV import + Disclosure ledger, not old profile/settings pages. |
| #161 renderer Part 2 | Rebaseline; registration gate moves later, Reflection/filters move earlier. |
| #162 unsigned DMG packaging | Keep the unsigned macOS DMG target; update from ZIP cutover to Soroeru Electron packaging. |
| #163 Personal Data Control Plane RFC | Absorbed conceptually. Soroeru keeps control-plane separation, but the MVP execution adapter is Playwright/Electron rather than WebExtension-first. |

Recommended next Issues after this RFC:

1. Vault v2 and Soroeru domain entities.
2. Electron shell + typed IPC + vault unlock.
3. CSV import -> Site Account/Credential seeds.
4. Slice A Playwright auto-login/collection runner with wall hand-off.
5. Disclosure ledger UI + filters + initial Reflection.
6. DMG packaging and Soroeru docs/test checklist.

## 10. Traceability

| Requirement | RFC coverage |
| --- | --- |
| REQ-001 Personal Attributes encrypted | §§2.4, 4, 6 |
| REQ-002 Password CSV import safety | §§4.4, 5.1, 6 |
| REQ-003 Auto-login + wall hand-off | §§2.3, 5.1, 6 |
| REQ-004 Disclosure ledger | §§4.1-4.3, 5 |
| REQ-005 Per-site composed view / stale flags | §§4.2, 5.3 |
| REQ-006 Account Relationship filters | §§4.1, 5.3 |
| REQ-007 Reflection | §§3, 5.1, 5.3 |
| REQ-008 Delegation Boundary | §§5.4, 6 |
| REQ-009 Policy/Preference formation | §§3, 4.1 |
| REQ-010 Bulk update | §§4.2, 9 next Issues |
| REQ-011 Withdrawal cleanup | §§3, 9 next Issues |
| REQ-012 New registration | §§2.3, 6, 9 prior work |
| REQ-013 Deterministic default / optional AI | §§2.5, 5.2, 7 |
| REQ-014 Automation-prohibiting ToS as Constraint | §§5.4, 6 |

## 11. References

- [Playwright Library](https://playwright.dev/docs/library)
- [Playwright BrowserType API: persistent contexts](https://playwright.dev/docs/api/class-browsertype)
- [Electron process model](https://www.electronjs.org/docs/latest/tutorial/process-model)
- [Electron context isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation)
- [Electron Forge makers](https://www.electronforge.io/config/makers)
- [Electron Forge DMG maker](https://www.electronforge.io/config/makers/dmg)
- [React: Build a React app from Scratch](https://react.dev/learn/build-a-react-app-from-scratch)
- [Vite Guide](https://vite.dev/guide/)
- [Node.js test runner](https://nodejs.org/api/test.html)
- [Tauri macOS application bundle](https://v2.tauri.app/distribute/macos-application-bundle/)
- [Apple: Distributing software on macOS](https://developer.apple.com/macos/distribution/)
- [Apple: Notarizing macOS software before distribution](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
- [Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [MDN WebExtensions Native messaging](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging)
- [SQLCipher](https://www.zetetic.net/sqlcipher/)
- [libsodium password hashing](https://libsodium.gitbook.io/doc/password_hashing)
- [MDN Web Crypto API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API)
