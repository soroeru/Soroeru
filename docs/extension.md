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
> git. Detailed component and file layout are finalized during the PoC (#33); this
> document describes the intended boundaries.

## 1. Architecture Overview

`Catashiro` is a local application with four layers:

```text
Catashiro (local app)
├── store layer
│   ├── personal data (name, address, phone, email, card incl. CVV, per-site credentials)
│   ├── per-site records (references + hashes, not duplicated raw values)
│   ├── authorization records (mandates)
│   └── all encrypted at rest (AES-256-GCM, master-passphrase-derived key)
│
├── agent layer (the user's AI; provider-abstracted)
│   ├── finds the registration page
│   ├── maps form fields to stored field types (AI variant)
│   ├── detects high-risk terms clauses
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
    └── settings (master passphrase, AI provider API key)
```

Keep shared logic — field classification, wall detection, the store/crypto boundary, and
the provider abstraction — isolated so it can be tested outside a live browser.

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

- Uses the user's configured provider only (Anthropic Opus / Sonnet / Haiku, or OpenAI
  GPT-5.4 / 5.4-mini / 5.3-Codex) behind a provider-abstraction interface.
- Receives **form structure** (labels, `name`, `id`, type, nearby text) and **terms text**,
  and returns a mapping plan and high-risk findings. It does not receive raw personal
  values and is not given direct browser control (the automation layer executes the plan).
- Stateless requests only; no prompt caching of personal data, stored threads, or memory.
- A **deterministic** field-mapping variant (reusing the existing scanner and rule-based
  classifier) is built alongside the AI variant and compared for accuracy (RFC §8).

## 4. Store Layer (encrypted)

- All personal data, card data (incl. CVV), per-site credentials, the API key, per-site
  records, and mandates are encrypted at rest. Encryption is canonical in
  [`security.md`](security.md) §4 (Argon2id / PBKDF2-SHA-512 + AES-256-GCM, key in memory
  only).
- Per-site records hold **references + hashes**, not duplicated raw values, so bulk-update
  diffing works without multiplying sensitive data.
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

## 8. Status

This is design intent. Concrete component structure, file layout, and the reusable scanner
/ classifier integration are finalized during the PoC (#33). Reusable assets from the
earlier work (the form scanner and rule-based classifier) feed the deterministic mapping
variant.

## 9. App Shell (APP-001)

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

## 10. Removal of Pre-Pivot MV3 Files

The pre-pivot Chrome Extension (Manifest V3) files that previously lived under `src/` —
`src/manifest.json`, `src/options/*`, `src/content/scanner.ts`,
`src/storage/profile-store.ts`, and `src/shared/*` — predated the RFC-001 v3 pivot to a
local Playwright application and were not part of the `Catashiro` runtime. They have been
removed (#68); their history remains in git. The form scanner and rule-based classifier
they contained informed the deterministic mapper now at `src/agent/scan.ts` and
`src/agent/classifier.ts`. `src/` is now used exclusively for the `Catashiro` agent
described in this document.

## 11. Local App UI (UI-001 / #17, UI-002 / #66)

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

- **Onboarding / unlock** — master-passphrase unlock or recovery-key unlock, with plain
  language copy about local encrypted storage and no cloud sync.
- **Tabs** — the primary navigation is `個人情報`, `登録済みサイト`, and `設定`.
- **Personal data** — the page has a top-right `編集` button and a single whole-page
  registration-info form. All known fields and custom fields are edited together, with
  the `保存` button at the bottom. Listings always use `maskValue`; revealing sensitive
  values requires passphrase re-entry via `PocStore.verifyPassphrase()`.
- **登録済みサイト** — shows per-site records, status, mandate count, filled-field count,
  and stale-field candidates from `staleFilledFields()`. The page always shows a
  `新規登録` form near the top; a `一括更新` action appears below it only when stale
  update candidates exist, otherwise "差分のあるサイトはありません" is shown.
- **Settings** — save provider/model/API key into the encrypted store, reveal API key
  only after passphrase re-entry, and generate / verify / remove recovery keys.

Registration execution, web review-and-confirm gate decisions, missing-data prompts,
bulk-update execution, and wall hand-off/resume are designed in
[`issue-66-local-web-app-ui.md`](issue-66-local-web-app-ui.md) and will be wired through
`AppRunner` in the next slice. Until that reaches parity, the legacy developer CLI menu
remains available as:

```bash
npm run poc -- ui:cli [deterministic|ai]
```

`src/app/ui.ts` (`AppUI`) is that fallback CLI menu over
`CatashiroApp` + `AppRunner`. Its injectable `UiIo` remains covered by
`tests/unit/catashiro-poc-ui.test.ts`; the browser UI routes are covered by
`tests/unit/catashiro-poc-web-ui.test.ts`.
