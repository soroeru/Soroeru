# Application Architecture

This document owns **`Catashiro` application architecture and design decisions**: the
layer boundaries, the Playwright automation runtime, the encrypted store, the AI agent
boundary, and the registration / hand-off control flow.

Canonical product direction is
[`rfc-001-chrome-autofill-pivot.md`](rfc/rfc-001-chrome-autofill-pivot.md) (RFC-001 v3,
see §7). Out of scope here: product requirements (see [`requirements.md`](requirements.md)),
setup and repository layout (see [`development.md`](development.md)), and security
rationale (see [`security.md`](security.md)).

> **Direction change (2026-06-12).** `Catashiro` is no longer a Chrome Extension
> (Manifest V3). It is a **local Playwright-based application**. The previous MV3 design
> (content script / background service worker / options page) is historical and lives in
> git. Component and file layout were finalized during the PoC (#33, closed); this
> document describes those boundaries and the reference implementation (§1.1).

## 1. Architecture Overview

`Catashiro` is a local Mac desktop application for the MVP private beta, with four
layers:

```text
Catashiro (local app)
├── store layer
│   ├── personal data (name, address, phone, email, card incl. CVV, per-site credentials)
│   ├── per-site records (references + hashes, not duplicated raw values)
│   ├── authorization records (mandates)
│   ├── local candidate definitions and site/account-state metadata
│   └── all encrypted at rest (AES-256-GCM, master-passphrase-derived key)
│
├── definition / agent layer
│   ├── uses deterministic definitions and classifiers by default
│   ├── optionally calls the user's API Provider for ambiguous cases
│   ├── maps form fields and withdrawal flows to stored field types
│   ├── detects high-risk terms clauses and walls
│   └── receives form structure / terms text — never raw personal values
│
├── automation layer (Playwright)
│   ├── drives a headed browser (Chromium / Firefox / WebKit)
│   ├── navigates, fills values locally, submits after approval
│   ├── detects walls (CAPTCHA / MFA / verification) — never bypasses
│   └── pauses for hand-off and resumes in the same session
│
└── UI layer
    ├── personal-data management (incl. card data, credentials)
    ├── per-site inventory and bulk-update selection
    ├── the review-and-confirm gate
    ├── settings (master passphrase, vault location, AI provider API key)
    └── optional AI agent sidebar when API Provider mode is enabled
```

Keep shared logic — field classification, wall detection, the store/crypto boundary, and
the provider abstraction — isolated so it can be tested outside a live browser.

The MVP packaging target is a downloadable macOS app for about 10 invited beta users.
The architecture still keeps Playwright's Chromium / Firefox / WebKit automation boundary
because browser-engine independence is a product requirement, but Windows, Linux, mobile,
and browser-extension distribution are post-MVP.

### 1.1 Layer seams and shared contracts (MAINT-001)

The code at `src/`, `run/`, and `sites/` (originally developed under
`poc/autofill-agent/` during the PoC and promoted to the repository root in #68) is the
reference implementation of these boundaries.

The four layers communicate only through **typed contracts** declared in
`src/types.ts`: `ProfileKey`, `Transform`, `PageSnapshot` /
`FormField`, `MappingPlan`, `TermsAnalysis`, `WallDetection`, `GateRequest` /
`GateDecision`, `SiteRecord` / `FilledFieldRecord`, and `RegistrationMandate`. No layer
reaches across these types into another layer's internals.

Two seams keep the deterministic and AI variants interchangeable and testable:

- **`Mapper` seam** (`src/agent/mapper.ts`): `DeterministicMapper` and `AiMapper`
  implement the same interface (`discoverRegistrationLink`, `mapFields`, `analyzeTerms`).
  The orchestrator depends on the interface, so either variant can be swapped in and
  measured against the same scenarios.
- **Normalization seam** (`src/agent/normalization.ts`): every mapper output passes
  through `normalizeMappingPlan` / `normalizeTermsAnalysis` before the agent acts on it.
  This is the single place that drops invented keys, invalid transforms/roles, and
  field ids that are not on the page, and that folds `prohibitsAutoCreation` /
  `trial-subscription` into the high-risk flags. Both variants share it, so guard stop
  conditions are identical regardless of which mapper produced the plan.

**Cross-layer invariant (agent layer never sees raw values).** The agent layer receives
only `PageSnapshot` structure (labels / `name` / `id` / type / options / nearby text) and
terms text. Raw profile values are resolved from the decrypted store and injected by the
automation layer at fill time — they never enter a mapper input or an AI prompt. This
invariant is asserted in `tests/unit/catashiro-poc-contracts.test.ts`.

## 2. Automation Layer (Playwright)

- Playwright is the automation runtime **and** the test framework, chosen for
  browser-engine independence (Chromium / Firefox / WebKit). See `development.md` for
  commands once they exist.
- Run **headed** so the user can take over at a wall in the same session (shared cookies /
  session state), then the agent resumes.
- The automation layer is where raw personal **values** are injected into form fields.
  Values come from the decrypted store, not from the AI model.
- Registration runs new browser sessions; updates log in with stored per-site credentials.

## 3. Agent Layer (AI)

- AI is optional. The standard experience uses deterministic definitions, local
  candidate definitions, and rule-based classifiers without an AI API key.
- When enabled, AI mode uses the user's configured API Provider only (Anthropic Opus /
  Sonnet / Haiku, or OpenAI GPT-5.4 / 5.4-mini / 5.3-Codex) behind a
  provider-abstraction interface.
- Receives **form structure** (labels, `name`, `id`, type, nearby text) and **terms text**,
  and returns a mapping plan and high-risk findings. It does not receive raw personal
  values and is not given direct browser control (the automation layer executes the plan).
- Stateless requests only; no prompt caching of personal data, stored threads, or memory.
- AI mode is invoked only when the user enables `mode=ai` in settings and deterministic
  confidence is too low, a site/flow is unsupported, or the user explicitly asks for AI
  assistance. This keeps the default path predictable and limits the user's AI cost.
- App-embedded terminals and CLI Provider integrations (for example driving Claude Code or
  Codex CLI from inside `Catashiro`) are intentionally out of scope. API Providers are the
  supported AI integration path.

### 3.1 Mode Model

`Catashiro` exposes two product modes over the same execution and definition contracts:

- **Deterministic Mode** (default): uses official site definitions, local candidate
  definitions, form fingerprints, and rule-based classifiers. No AI API key or chat
  surface is required.
- **AI Mode** (optional): uses the same definitions plus the user's configured API
  Provider for ambiguous forms, unsupported withdrawal flows, terms-risk analysis, and
  candidate-definition generation.

The chat / agent sidebar is part of AI Mode only. Users without an API Provider should
see task-oriented UI for registration, inventory, update, and withdrawal workflows rather
than a low-capability placeholder chatbot.

### 3.2 Shared Definitions and Local Candidates

Deterministic Mode and AI Mode share one definition model (`SiteDefinition` /
`LocalCandidateDefinition` in `src/types.ts`) for:

- site and URL patterns (`match.domains` / `match.urlPatterns`);
- form signatures and field mappings (`registrationSignature`, `fieldRules`);
- withdrawal-flow steps (`withdrawalSteps`);
- wall-detection patterns (`wallSignals`);
- terms links and high-risk signals (`notes`; full terms analysis stays in
  `src/agent/guards.ts`).

The app resolves definitions before asking AI (`src/agent/definitions.ts`):

1. scan the current page / flow with Playwright (`PageSnapshot`);
2. `matchDefinition` builds a score from domain/URL pattern, path pattern, field-token,
   heading, button, and wall-signal hits — a definition must positively match
   `match.domains` or `match.urlPatterns` before any other signal counts;
3. `resolveDefinitions` scores checked-in official definitions
   (`src/agent/official-definitions.ts`) together with this vault's non-rejected local
   candidate definitions, best first;
4. `applyFieldRules` maps fields the matched definition has rules for (first matching
   rule wins, same convention as `src/agent/classifier.ts`); unmapped fields fall back to
   the deterministic/AI mapper;
5. ask the API Provider only for ambiguous or unsupported cases (future work: AI mode
   producing new local candidates from this resolution step).

AI output is stored as a **local candidate definition**, not as an official definition.
`candidateFromAiMapping()` converts a structure-only AI mapping result into a sanitized
encrypted local candidate after validation.
Candidate definitions are lifecycle-managed:

```text
unknown or changed site
  -> AI/user/observation creates local_candidate
  -> local runs validate or reject it
  -> user may opt in to submit a sanitized candidate
  -> human review and tests promote it to official/shared definition
```

`validateCandidateDefinition` (`src/agent/definitions.ts`) is the "local runs validate or
reject it" step: it checks that the candidate identifies a site, that every embedded
regex compiles, that field-rule profile keys are known/custom, and — per
[`security.md`](security.md) §9 — that no embedded string looks like a raw personal value
(email, card-number-like, or phone-number-like). `PocStore.upsertLocalCandidate`
(`src/store/store.ts`) runs this validation and throws `CandidateValidationError` rather
than persisting an invalid candidate; candidates are stored in the encrypted vault
(`localCandidates`) alongside profile data, site records, and mandates.

This avoids duplicate deterministic-vs-AI definition stores. AI Mode gets the
"early access" value by generating and using local candidates before they are promoted.
The sanitized opt-in submission and official-promotion steps remain future, explicit, and
opt-in (#80 non-scope); wiring `resolveDefinitions` into the agent's field-mapping
pipeline (`src/agent/mapper.ts` / `src/agent/agent.ts`) and AI-driven candidate generation
are tracked by later issues.

## 4. Store Layer (encrypted)

- All personal data, card data (incl. CVV), per-site credentials, the API key, per-site
  records, mandates, and local candidate definitions are encrypted at rest. Encryption is
  canonical in [`security.md`](security.md) §4 (Argon2id / PBKDF2-SHA-512 + AES-256-GCM,
  key in memory only).
- Per-site records hold **references + hashes**, not duplicated raw values, so bulk-update
  diffing works without multiplying sensitive data.
- Local candidate definitions do not contain raw profile values, but they reveal site
  visits, registration/update/withdrawal intent, and account-state context, so they live in
  the encrypted vault.
- Official shared definitions may be cached outside the vault because they should contain
  only public site structure and no user activity.
- The vault location is user-selected. Local disk is the default; future user-owned
  cloud-storage sync stores only encrypted vault bytes outside the app.
- Access goes through a small abstraction; never log decrypted values.

## 5. Registration Control Flow

1. The user gives a URL; the automation layer opens it.
2. The agent finds the registration page and analyzes the form.
3. Missing fields are requested from the user and saved for reuse.
4. The **review-and-confirm gate** shows the submission summary, terms links, and detected
   high-risk clauses.
5. On the user's single approval, the automation layer fills, accepts ordinary terms, and
   submits, applying the **three guards** (high-risk escalation; payment stop with the
   free-trial→subscription exception; no auto-attestation).
6. On auto-creation-prohibited sites, the agent fills only and the user submits.
7. A per-site record and a mandate are written.

## 6. Wall Hand-off and Resume

When CAPTCHA / MFA / identity / email / SMS verification is detected, the agent pauses,
surfaces an instruction overlay, and the user resolves the step in the same headed
session. The agent resumes from the paused step because progress state is held by the
agent, not the page. During a bulk update, the current site pauses, the user resolves,
that site resumes, then the run continues. Detection is conservative and never attempts to
solve or bypass; see [`security.md`](security.md) §7.

## 7. Bulk Update

The user selects sites and runs an update. For each, the agent diffs the per-site record
hashes against the latest stored values, opens the sites with changes, logs in with stored
credentials, updates the changed fields, and handles walls via §6.

## 8. Withdrawal Management (design direction, not yet implemented)

The per-site inventory should help the user identify services they no longer use and start
withdrawal tasks. The agent may find the withdrawal page, prepare a flow plan, fill
ordinary fields, and hand off at CAPTCHA / MFA / verification walls. Irreversible account
deletion, final withdrawal confirmation, auto-attestation, and any prohibited automated
action must remain gated by the user.

Withdrawal flows use the same shared definition model as registration/update flows:
official definitions when available, encrypted local candidates for user-specific
discoveries, and optional API Provider analysis only when deterministic resolution is
ambiguous or unsupported.

## 9. Advanced Local MCP Server (future)

A local MCP server is a future advanced-user extension, not part of the MVP. If added, it
must expose only narrow, permissioned tools from `Catashiro` to an external AI agent. It is
not an AI Provider and must not let an external CLI or agent bypass `Catashiro`'s own UI,
store boundary, or approval gates.

Initial MCP capability should be read-only or planning-oriented, such as:

- inventory summaries without raw personal values;
- stale-site and withdrawal-target discovery;
- current-page structure inspection;
- candidate mapping / withdrawal-flow proposals;
- task creation inside `Catashiro` for later user review.

MCP must not expose raw profile values, credentials, card numbers, CVV, decrypted vault
exports, direct browser control, or submit/withdraw actions that skip the
review-and-confirm gate.

## 10. Status

The PoC (#33, closed) delivered the reference implementation under `src/`, `run/`, and
`sites/` (§1.1) for its original scope: the deterministic and AI mappers, the encrypted
store, the review-and-confirm gate, the three guards, wall hand-off/resume, bulk update,
and the Playwright E2E matrix (see [`testing.md`](testing.md) §8). The form scanner and
rule-based classifier from the earlier MV3-era work were carried forward into
`src/agent/scan.ts` and `src/agent/classifier.ts` (§12).

The data-sovereignty additions from the 2026-06-12 pivot include the Mode Model (§3.1),
shared official/local-candidate definitions (§3.2, plus the related store-layer bullets in
§1 and §4), and withdrawal management (§8). Of these, §3.2's definition schema, matching
(`matchDefinition` / `resolveDefinitions`), field-rule application (`applyFieldRules`),
candidate validation (`validateCandidateDefinition`), and encrypted local-candidate
storage (`PocStore.upsertLocalCandidate` etc.) are implemented (#80) with a small set of
checked-in official definitions for the local test sites
(`src/agent/official-definitions.ts`). The Mode Model (§3.1), wiring
`resolveDefinitions`/`applyFieldRules` into the agent's mapping pipeline, AI-driven
candidate generation, the sanitized opt-in submission/promotion flow, and withdrawal
management (§8) remain design direction and are **not yet implemented**. Remaining work
is tracked by open issues, including those additions and wiring the local web UI (§13) to
`AppRunner`.

The MVP parent scope is a Mac-only private beta (see
[`requirements.md`](requirements.md) §1.1). Implementation issues should prefer Mac app
packaging, first-run setup, the local browser UI, and support/diagnostics needed for that
beta before expanding to other platforms or distribution channels.

## 11. App Shell (APP-001)

`src/app/` is the local app shell that the UI layer and the automation
layer both go through, rather than opening the store or launching browsers directly:

- **`app.ts` — `CatashiroApp`**: owns the encrypted store's unlock/lock lifecycle (incl.
  idle auto-lock, default 10 minutes, 0 disables) and tracks Playwright `Browser`
  instances so `shutdown()` can close them all and lock the store in one step. A wrong
  passphrase fails GCM authentication; `unlock()` fails closed with `CatashiroAppError`
  rather than falling back to an unauthenticated read. `touch()` resets the idle timer on
  user/agent activity. Browser launching and the idle timers are injectable
  (`launchBrowserFn`, `setTimeoutFn` / `clearTimeoutFn`) so the lifecycle is unit-testable
  without a real browser or real delays (`tests/unit/catashiro-poc-app.test.ts`).
- **`runner.ts` — `AppRunner`**: the UI <-> automation boundary. It owns the chosen
  `Mapper` and reads the store + browser lifecycle from `CatashiroApp`; the UI supplies
  `AppRunnerHooks` (the review-and-confirm `Gate`, the missing-data prompt, the optional
  wall `HumanHandoff`, and the optional `humanFinalSubmit` surrogate for
  auto-creation-prohibited sites). `register()` / `update()` call `app.touch()` and then
  delegate to the existing `runRegistration` / `runUpdate` in `agent/agent.ts` — the UI
  never constructs an `AgentDeps` or touches the store directly.

Local state (the encrypted store file, matrix output, etc.) lives under
`state/catashiro-poc/` (gitignored). AI provider/model selection is part of the encrypted
store's `ProviderSettings` (set via `PocStore.setProviderSettings`); the env-var based
`aiProviderFromEnv()` (`OPENAI_API_KEY` preferred, `ANTHROPIC_API_KEY` fallback) remains
for the PoC CLI and measurement runner, which run outside the UI flow.

The CLI's `app` subcommand (`npm run poc -- app`) is a lifecycle smoke test: unlock the
store (reporting `CatashiroAppError` on a bad passphrase), launch a headed Chromium
browser, navigate to `about:blank`, then `shutdown()` (close the browser and lock the
store).

## 12. Removal of Pre-Pivot MV3 Files

The pre-pivot Chrome Extension (Manifest V3) files that previously lived under `src/` —
`src/manifest.json`, `src/options/*`, `src/content/scanner.ts`,
`src/storage/profile-store.ts`, and `src/shared/*` — predated the RFC-001 v3 pivot to a
local Playwright application and were not part of the `Catashiro` runtime. They have been
removed (#68); their history remains in git. The form scanner and rule-based classifier
they contained informed the deterministic mapper now at `src/agent/scan.ts` and
`src/agent/classifier.ts`. `src/` is now used exclusively for the `Catashiro` agent
described in this document.

## 13. Local App UI (UI-001 / #17, UI-002 / #66)

Issue #66 starts replacing the terminal menu with a local browser UI. The default
launcher is now:

```bash
npm run poc -- ui [deterministic|ai] [port]
```

`src/app/web-ui.ts` starts a server-rendered local web app over
Node's built-in HTTP server. It binds to `127.0.0.1` by default, uses no frontend
framework, sets a restrictive content security policy, requires an in-memory CSRF token
on every POST, and reads/writes data only through `CatashiroApp.store`. The server is a
local UI facade, not a hosted backend or cloud service.

Current web UI foundation:

- **Onboarding / unlock** (#79) — `GET /` branches on `CatashiroApp.hasVault()` (whether
  `<stateDir>/store.json` exists yet):
  - **First run** (no vault file): a vault-setup form (`POST /setup`) asks for the master
    passphrase twice (min. 8 chars, must match), shows the local vault file path, and
    explains that losing the passphrase and the recovery key together means the data
    cannot be recovered. On success it creates and persists the store immediately and
    redirects to `設定` with a nudge to set up a recovery key next.
  - **Returning user** (vault file exists): the existing master-passphrase unlock
    (`POST /unlock`) or recovery-key unlock (`POST /unlock-recovery`) forms, with the same
    reset-guidance copy.
  - The dashboard shows a persistent reminder banner linking to `設定` until a recovery
    key has been generated, and states the idle auto-lock duration
    (`CatashiroApp.idleLockMs`) when enabled.
- **Tabs** — the primary navigation is `個人情報`, `登録済みサイト`, and `設定`.
- **Personal data** — the page has a top-right `編集` button and a single whole-page
  registration-info form. All known fields and custom fields are edited together, with
  the `保存` button at the bottom. Listings always use `maskValue`; revealing sensitive
  values requires passphrase re-entry via `PocStore.verifyPassphrase()`.
- **登録済みサイト** — shows per-site records, status, mandate count, filled-field count,
  and stale-field candidates from `staleFilledFields()`. The page always shows a
  `サイトを追加` guided action near the top; it asks whether the user already has an
  account, routes unregistered users into autonomous registration, and records existing
  accounts as `accountState=imported`. A `一括更新` action appears below it only when
  stale update candidates exist, otherwise "差分のあるサイトはありません" is shown.
- **サイト追加 (#83)** — `POST /site/add` is the entry point for the guided flow. When
  the user chooses "まだ持っていない", it delegates to the new-registration session below.
  When the user chooses "すでに持っている", it stores an imported site inventory record
  without guessing credentials or attempting login. "わからない" is treated
  conservatively: the UI asks the user to choose before any workflow starts.
- **既存アカウントの個人情報インポート (#84)** — `src/agent/importer.ts` provides the
  local extraction/review/save core for existing-account import. `AppRunner.importExistingAccount()`
  navigates to a user-opened account/profile page, scans form structure, asks the mapper
  for field keys using structure only, then reads raw field values locally in Playwright.
  Card fields and account passwords are excluded from import. `saveImportedProfileValues()`
  persists only review-approved values into the encrypted profile store and records an
  `accountState=imported` inventory entry with hashes, never duplicated raw values.
- **新規登録 (#81)** — `POST /registration/start` launches a headed Playwright browser
  (`CatashiroApp.launchBrowser("chromium")`), opens a new page, and runs
  `AppRunner.register()` in the background via `RegistrationSession`
  (`src/app/registration-session.ts`). Because `AppRunner.register()` runs to completion
  in one call but pauses on its `gate.decide` / `promptUser` / `handoff` hooks,
  `RegistrationSession` resolves each hook with a `Promise` and exposes the current pause
  point through `getState()`. The sites tab renders whichever state is current
  (`running`, `awaiting-data`, `awaiting-gate`, `awaiting-handoff`, `done`, or `error`)
  and auto-refreshes every 2 seconds while `running`. Each pause point is resolved by its
  own POST route:
  - `POST /registration/provide-data` — answers a missing-data prompt (or skips it),
    saving the value as a new custom field for reuse;
  - `POST /registration/gate-decision` — approves or declines the review-and-confirm
    gate. The web UI renders the gate as plain-language sections (#82): "送信する項目"
    (masked submission fields), "規約・ポリシー" (clickable terms/policy links), "⚠
    自動承認を停止した項目" (guard 1 high-risk clauses with quoted evidence), "お支払いに
    ついて" (guard 2 payment classification, including the trial-card `cardApproved`
    checkbox), "自動アカウント作成について" (the auto-creation-prohibited notice), and "ご
    自身でご確認のうえチェックしてください" (guard 3 per-attestation checkboxes, unchecked
    by default). `renderGate()` (`src/agent/gate.ts`) remains the CLI-only text renderer
    used by `ui:cli` / `CliGate`;
  - `POST /registration/handoff-resolve` — resumes or aborts after the user clears a
    detected CAPTCHA / MFA / verification wall in the same browser session;
  - `POST /registration/dismiss` — closes a finished (`done` / `error`) run, closing the
    page and browser.

  Only one registration run is tracked at a time; starting a new one while another is
  in progress (and not yet dismissed) is rejected with a warning.
- **Settings** — save provider/model/API key plus deterministic-vs-AI mode into the
  encrypted store, reveal API key only after passphrase re-entry, generate / verify /
  remove recovery keys, and shows the local vault file path for reference.

Bulk-update execution (#88) uses the same `AppRunner.update()` automation boundary as
the CLI fallback. The Web UI renders stale site/field candidates from
`staleFilledFields()`, posts the selected fields to `POST /bulk/start`, and tracks an
in-memory `BulkUpdateSession` while each site runs independently. The session exposes
per-site running, confirmation-gate, wall-handoff, done, and error states through:

- `POST /bulk/gate-decision` — approves or declines the current site's update gate;
- `POST /bulk/handoff-resolve` — resumes or aborts the current site after the user
  resolves CAPTCHA / MFA / verification in the same browser session;
- `POST /bulk/dismiss` — closes a completed bulk-update browser and clears the session.

The legacy developer CLI menu remains available as:

```bash
npm run poc -- ui:cli [deterministic|ai]
```

`src/app/ui.ts` (`AppUI`) is that fallback CLI menu over
`CatashiroApp` + `AppRunner`. Its injectable `UiIo` remains covered by
`tests/unit/catashiro-poc-ui.test.ts`; the browser UI routes (including the
`RegistrationSession` / `BulkUpdateSession` state machines and run routes) are covered by
`tests/unit/catashiro-poc-web-ui.test.ts` and `tests/unit/catashiro-poc-registration.test.ts`.
