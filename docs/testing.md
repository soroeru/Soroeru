# Testing

## GitHub Project defaults

Run the isolated parser and GraphQL orchestration tests with:

```bash
node --test tests/unit/project-issue-defaults.test.mjs
```

The tests use synthetic Issue payloads and an injected GraphQL function. They
cover metadata and legacy parsing, candidate classification and ambiguity,
safe defaults, next-day one-day dates, existing-item/iteration reuse, and
failure before any mutation when a required Project option or classification
is unavailable. Do not use a real Project token or real Issue body in tests.

This document owns the **testing strategy** for `Soroeru`: what to test, at which layer,
how aggressively, and how the suites map to the architecture. It is the source of truth for
*what* to test; the [`writing-good-tests`](../skills/writing-good-tests/SKILL.md) skill (§1.1)
is the source of truth for *how* to write a test.

> Soroeru is a local-first **agency engine**; the canonical product direction is
> [`requirements.md`](requirements.md) and the target architecture is
> [`architecture.md`](architecture.md). The capability slices ship in order **A Visibility →
> B Bulk Update → C Withdrawal → D Registration**, so test investment follows that order:
> the Visibility layers (`store/vault-v2.ts`, `domain/*`, `automation/*`, the IPC permission
> boundary) are the active risk surface, while the registration-first PoC layers (`agent/*`,
> `app/*`, the `run/measure.ts` E2E matrix) remain in the tree and under test for the later
> slices. This document describes the suite that **actually runs today** under `npm test`
> and CI (§7); keep it updated in lockstep as the codebase changes.

Out of scope here: the browser-based manual checklist itself (see
[`manual-test.md`](manual-test.md)) and the canonical command list (see
[`development.md`](development.md)).

## 1. Test Strategy

Tests exist to give confidence that the **risk-carrying behavior** works and that the
**security non-negotiables hold** — not to maximize a coverage number.

Module paths below are relative to `src/`, except the top-level directories `electron/`
(the trusted main-process layer — IPC, session, the main-side visibility service), `run/`,
`sites/`, and `tests/`, which are written from the repo root. Concentrate effort on:

- the encrypted vault, key derivation, recovery key, and migration (`store/vault-v2.ts`,
  `store/crypto.ts`, `store/recovery.ts`);
- the domain/trusted layer that owns the disclosure ledger, mandates, policy, and the
  Delegation Boundary (`domain/*`);
- the **IPC permission boundary** — the renderer must only reach narrow, allow-listed
  commands and must never receive raw personal values (`electron/ipc/*`, the domain-service
  allowlist);
- collection automation and wall detection / hand-off / resume (`automation/*`,
  `agent/scan.ts`, `agent/walls.ts`);
- deterministic and AI-driven field classification / mapping (`agent/classifier.ts`,
  `agent/mapper.ts`, `agent/ai/*`);
- the review-and-confirm gate and the three guards (`agent/gate.ts`, `agent/guards.ts`);
- CSV import safety and per-site records / mandates (`domain/csv-import.ts`,
  `agent/chrome-csv-importer.ts`, `agent/records.ts`);
- the network-egress and local-persistence boundaries and the anti-bypass denylist
  (PRIV-001/002, SEC-002 — `dev/{egress,privacy,bypass}-check.ts`).

Use **unit/integration tests** (§2.1) for deterministic logic, the trusted layer, and the
IPC boundary; the **Playwright E2E matrix** (§8) for end-to-end registration / bulk-update
flows against the local test sites; and the **manual checklist**
([`manual-test.md`](manual-test.md)) for headed-browser UX that needs human judgment. Use
**fake data only** everywhere (§4). Prefer integration over isolated unit tests where the
real collaborators are *managed* dependencies we own (the vault, the domain service, the
local test sites) — "Write tests. Not too many. Mostly integration."

### 1.1 Writing tests: use the `writing-good-tests` skill

When **writing or reviewing any test** in this repository, agents must use the repo-local
**`writing-good-tests`** skill
([`skills/writing-good-tests/SKILL.md`](../skills/writing-good-tests/SKILL.md); also exposed
to Claude Code via `.claude/skills/writing-good-tests`). The same requirement is mirrored as
a convention in [`development.md`](development.md) §5. It encodes the principles enforced here:

- **"Write tests. Not too many. Mostly integration."** — favor a small number of high-value
  tests over exhaustive per-function coverage. This is the direct guard against the "too many
  unit tests" problem.
- **Test behavior, not implementation** — a test that breaks on a pure refactor (e.g.
  renaming an internal function) is testing implementation and is a deletion / consolidation
  candidate.
- **Condition-based waiting**, not arbitrary `setTimeout`/`sleep` — important for the
  Playwright flows and the session state machines, where timing is non-deterministic. Use the
  shared `waitFor` helper (`tests/unit/helpers/wait.ts`).
- **Mock strategically** — real *managed* dependencies (our own vault/store, domain service,
  local test sites, the in-process web UI server), mocks only for *unmanaged* externals (the
  AI provider, third-party sites/APIs). This matches our seam design (the AI mapper is tested
  against a `StubProvider`, §7) and the fake-data-only rule (§4).
- **One action per test**, Arrange-Act-Assert structure, no test-only methods leaking into
  production code. Shared setup lives in `tests/unit/helpers/` (e.g. the web-UI client), not
  copy-pasted per file.

The skill illustrates these principles with `vitest` / React Testing Library examples; this
repo's runner is Node's built-in `node --test` over `tests/unit/*.test.ts` (§3, §5), so
**adapt the example syntax to `node --test` while keeping the principles** (revisit as the
`architecture.md` React renderer matures).

### 1.2 Keep vs. reduce (the test-inventory criteria)

This table is the **input to test-inventory / consolidation work**. Apply it per test, not
per file: a single file can hold both keep-tier and reduce-tier cases.

| Tier | Applies to | Action |
| --- | --- | --- |
| **Keep — security non-negotiable** | CAPTCHA/MFA/bot-detection non-bypass; raw-PII-never-leaves-local (egress/persistence/bypass static checks, no raw PII to the AI model); encryption at rest + recovery; the IPC permission allowlist; the review-and-confirm gate and three guards; the absolute boundary on deleting Soroeru-internal data. | **Never delete to save time.** May be reorganized for readability, but the regression must stay covered. Treat these as the protected core. |
| **Keep — high-risk behavior** | Field classification / mapping correctness; wall detection → hand-off → resume; disclosure-ledger build + stale-value flagging; mandate/diff logic; CSV import mapping; vault migration. | **Keep**, expressed as behavior-level tests. Consolidate duplicates; split any test whose name joins two behaviors with "and". |
| **Reduce — implementation-coupled** | Tests that break on a pure rename/refactor; assertions on internal call order or private shape; "renders the mock" assertions. | **Rewrite to behavior** or delete. A test that only re-states the implementation earns nothing. |
| **Reduce — low-value duplication** | Trivial getters/constants/type round-trips; the same setup repeated across files; speculative scenarios with no real-usage evidence (YAGNI). | **Consolidate or delete.** Move shared setup into `tests/unit/helpers/`. Let real-usage feedback, not speculation, add edge cases. |
| **Watch — slow / flaky** | Tests that launch a real browser, start a local server, or do heavy crypto; anything using arbitrary `sleep`/`setTimeout`. | **Keep the behavior, fix the cost:** condition-based waiting, share fixtures/servers, and avoid per-test browser launches where a stub or the in-process server suffices. |

Two guardrails for any reduction: (1) it must not drop a "Keep — security non-negotiable"
regression, and (2) a shared helper must not hide *what* a test verifies — if extracting setup
makes the assertion unreadable, keep it inline.

## 2. Test Types

| Type | Purpose | Target |
| --- | --- | --- |
| Unit / integration | Verify rules, the trusted/domain layer, and the IPC boundary against real managed collaborators in-process. | Vault/crypto, domain service + ledger, IPC permission, field classification, wall detection, guards/gate, AI mapper (stub provider), the local web UI (in-process server). |
| E2E | Verify the agent end to end in a real browser (Playwright). | Registration, bulk update, wall handoff/resume, and the review-and-confirm gate against the local test sites (§8). |
| Manual | Verify UX and safety boundaries automation can't judge. | Review-and-confirm gate copy, wall handoff, local web UI, release readiness ([`manual-test.md`](manual-test.md)). |

### 2.1 Layer → test mapping (MAINT-001)

Layers follow the target architecture
([`architecture.md`](architecture.md) §1). "Slice"
indicates the capability slice the layer primarily serves — **A** (Visibility) is the active
surface; **B/C/D** layers are present for the later slices.

| Layer / seam | Slice | Modules | Tests |
| --- | --- | --- | --- |
| VaultService (crypto boundary) | A | `store/vault-v2.ts`, `store/crypto.ts`, `store/crypto-runtime.ts`, `store/recovery.ts`, `store/vault-persistence.ts`, `store/file-vault-persistence.ts`, `store/store.ts` (v1/legacy store, still in-tree) | `soroeru-vault-v2`, `soroeru-vault-browser-crypto` (legacy Vault v2 fixtures, injected persistence, static no-`node:`/`Buffer` check), `soroeru-poc-crypto`, `soroeru-poc-recovery`, `soroeru-poc-candidates` (encrypted per-vault candidates) |
| DomainService (trusted layer: ledger, mandates, policy) | A | `domain/domain-service.ts`, `domain/entities.ts`, `domain/normalize.ts`, `domain/ledger-insights.ts`, `domain/insights-types.ts` | `soroeru-domain-service`, `soroeru-ledger-insights` |
| Main-side VisibilityService + IPC permission boundary (renderer ⇄ main) | A | `electron/visibility-service.ts`, `electron/ipc/*`, domain-service allowlist | `soroeru-visibility-service`, `soroeru-ipc-permission`, `soroeru-ledger-ipc` |
| AutomationService (collect / login / saved-page / walls) | A | `automation/disclosure-collector.ts`, `automation/page-driver.ts`, `automation/saved-page-importer.ts`, `automation/visibility-runner.ts`, `agent/scan.ts` | `soroeru-disclosure-collector`, `soroeru-visibility-runner`, `soroeru-saved-page-importer`, `soroeru-saved-page-guide-fixture`, `soroeru-scan-display-values` |
| CSV import (Visibility entry point) | A | `domain/csv-import.ts`, `agent/chrome-csv-importer.ts` | `soroeru-csv-import`, `soroeru-poc-chrome-csv-importer` |
| Agent — deterministic mapper / classifier | B/D | `agent/mapper.ts`, `agent/classifier.ts`, `agent/normalization.ts` | `soroeru-poc-classifier`, `soroeru-poc-contracts` |
| Agent — AI mapper / provider (stub) | B/D | `agent/ai/ai-mapper.ts`, `agent/ai/provider.ts` | `soroeru-poc-ai-mapper`, `soroeru-poc-provider` |
| Agent — wall detection | A/D | `agent/walls.ts`, `automation/wall-detection.ts` | `soroeru-poc-walls` |
| Agent — guards & gate (registration safety) | D | `agent/guards.ts`, `agent/gate.ts` | `soroeru-poc-guards`, `soroeru-poc-gate` |
| Agent — records / inventory / mandate | B/D | `agent/records.ts` | `soroeru-poc-records`, `soroeru-poc-inventory` |
| Agent — site/field definitions | A/D | `agent/definitions.ts`, `agent/official-definitions.ts` | `soroeru-poc-definitions` |
| Agent — existing-account import | A/B | `agent/importer.ts` | `soroeru-poc-importer` |
| Agent — phase timing (PERF-001) | all | `agent/perf.ts` | `soroeru-poc-perf`, `soroeru-poc-measure` |
| App shell / sessions | B/C/D | `app/app.ts`, `app/registration-session.ts`, `app/bulk-update-session.ts`, `app/withdrawal-session.ts`, `app/runner.ts` | `soroeru-poc-app`, `soroeru-poc-registration`, `soroeru-poc-task-progress`, `soroeru-poc-withdrawal` |
| UI — local web app | all | `app/web-ui.ts` | `soroeru-poc-web-ui`, `soroeru-poc-add-site` |
| UI — legacy terminal fallback | — | `app/ui.ts` | `soroeru-poc-ui` |
| Diagnostics / support bundle | all | `app/diagnostics.ts` | `soroeru-poc-diagnostics` |
| App diagnostics log (unencrypted, Issue #314) | A | `logging/logger.ts`, `logging/file-logger.ts`, wired into `automation/visibility-runner.ts`, `electron/visibility-service.ts`, `electron/session.ts`, `electron/main.ts` | `soroeru-file-logger`, plus the logger-spy assertions in `soroeru-visibility-runner` and the export round-trip in `soroeru-ipc-permission` |
| Dev checks (PRIV-001/002, SEC-002) | all | `dev/{egress,privacy,bypass}-check.ts` | `soroeru-poc-egress`, `soroeru-poc-privacy`, `soroeru-poc-bypass` |
| Measurement / CI gate (E2E) | B/D | `run/measure.ts` | `soroeru-poc-measure` |

Shared test helpers live in `tests/unit/helpers/` (e.g. `web-ui-client.ts` for the in-process
web UI, `wait.ts` for condition-based waiting). `soroeru-poc-contracts` additionally locks the
cross-layer invariant that the agent layer never receives raw personal values, and the
egress/privacy/bypass checks lock the security non-negotiables as static tests.

## 3. Test Environment

The automated test runner is Node's built-in test runner, run against compiled output
(see [`development.md`](development.md) for commands).

- **Unit / integration**: Node built-in test runner (`node --test`) over
  `tests/unit/*.test.ts`, compiled to `dist/compiled/tests/unit/`. These exercise real
  managed collaborators in-process (the vault, the domain service, the local web UI server).
- **E2E**: Playwright drives the local test sites (`sites/`) across Chromium / Firefox /
  WebKit; see §8. Browser-driven tests require the Playwright Chromium browser to be installed
  (`npx playwright install chromium`); CI caches it (§7).
- **Manual**: a headed browser against the local test sites, per
  [`manual-test.md`](manual-test.md).

## 4. Test Data And Fixtures

The local test sites under `sites/` (`sites/defs.ts` for form definitions and ground truth,
`sites/server.ts` to serve them) are the fixtures for both the E2E matrix (§8) and manual
testing. §8 lists each site's form shape and the requirements it exercises.

Rules for any test data, fixtures, or local test sites:

- use fake names, emails, phone numbers, addresses, company names, and department names —
  Japanese only (multi-locale form detection is out of scope for now, see
  [`requirements.md`](requirements.md) §5);
- never commit real personal data, real customer data, or screenshots/forms containing
  private data;
- CAPTCHA-like, MFA-like, terms, consent, and final-confirmation placeholders must not use
  real CAPTCHA or MFA services.

## 5. Commands

Test commands belong with the rest of the quality gates in
[`development.md`](development.md).

Current automated test command:

```bash
npm test
```

`npm test` builds the project, then runs unit/integration tests from `tests/unit/` (Node's
built-in test runner).

For the registration / bulk-update agent (§8 below), the E2E test matrix is run via:

```bash
npm run poc:matrix -- deterministic chromium   # CI: see §7
npm run poc:matrix -- both                     # local: all engines + AI variant if a key is configured
```

For the Electron app's own UI (Issue #303), a local-only E2E harness drives the built
app with Playwright's built-in Electron support (`_electron.launch()`, no extra
dependency) through the Visibility happy path — vault setup → CSV import → collection
against the local `01-basic` test site → disclosure ledger in the UI and persisted to
an isolated `SOROERU_STATE_ROOT` vault:

```bash
npm run e2e:app-ui   # local-only: builds the app, launches it, drives the renderer UI
```

The run opens a real Electron window plus the headed collection browser, uses fake
data only, and leaves its per-run state under `state/soroeru-poc/e2e-app-ui/` for
debugging (`state/` is git-ignored).

For the Visibility **exploration** flow (Issue #251), a second local-only harness
extends the same `_electron.launch()` pattern against a dedicated multi-page fixture
(`sites/server.ts`'s `/explore-flow/*`, not one of the 10 `SITES` — see
[`docs/design/issue-251-app-ui-exploration-e2e.md`](design/issue-251-app-ui-exploration-e2e.md)):
login → mypage → profile/address/payment, where the payment page shows a CAPTCHA-style
wall on its first visit and clears on the next. The test drives the real hand-off
banner ("ウォールの解決が必要です") and its "解決して再開" button to resume, then asserts
the resulting disclosures were sourced from all three pages and persisted to the vault,
with the card number reduced to its last 4 digits and the CVV never present:

```bash
npm run e2e:app-ui-exploration   # local-only: multi-page exploration + wall handoff/resume
```

Per-run state is kept under `state/soroeru-poc/e2e-app-ui-exploration/` for debugging.

For the app diagnostics log (Issue #314), a third local-only harness reuses the same
`_electron.launch()` pattern to drive a real Visibility collection failure through the app
UI (a CSV row pointing at `127.0.0.1:1`, a loopback port nothing listens on, so the run
deterministically fails with "unreachable" / "navigation-failed" — no external network or
DNS dependency), smoke-tests the new Settings tab's "ログをダウンロード" button through the
real UI, and asserts the on-disk plain-text log it reads contains a `site unreachable`
entry with that reason — and never the raw email/password. (The assertion reads the log
file directly rather than capturing a Playwright `download` event: Electron routes an
`<a download>` click through its native `will-download` session API, not the standard
Chromium download manager Playwright observes.)

```bash
npm run e2e:app-ui-logging   # local-only: drives a login failure, verifies the downloadable log
```

Per-run state is kept under `state/soroeru-poc/e2e-app-ui-logging/` for debugging.

## 6. Manual Testing

Use [`manual-test.md`](manual-test.md) for browser-based checklists. Per AGENTS.md
"Manual Testing Expectations", manual checks are required when a change affects form
detection, filling, submission, the review-and-confirm gate, the three guards, wall hand-off,
or storage/encryption behavior.

For Mac private beta releases, [`manual-test.md`](manual-test.md) §0 is the owning release QA
checklist. It combines automated gates with manual install / uninstall, first run, vault
recovery, Add Site branching, registration, existing-account import, bulk update, wall
hand-off / resume, support-bundle review, and release-note limitation checks. Run it against
the packaged `.app` artifact before sharing a build with beta users.

## 7. CI

`.github/workflows/ci.yml` (TEST-001 / #45) runs on every pull request and on push to
`main`:

| Job | Steps | Covers |
| --- | --- | --- |
| `unit` | `actions/cache` for `~/.cache/ms-playwright`, `npm run typecheck`, `npm test`, `npm run poc -- check-egress` (PRIV-001), `npm run poc -- check-persistence` (PRIV-002), `npm run poc -- check-bypass` (SEC-002) | All unit/integration layers in §2.1, including the AI mapper exercised against a `StubProvider` (`soroeru-poc-ai-mapper`) — no real API key is used or required. The Playwright browser cache shortens the Chromium install step on a cache hit. |
| `e2e-deterministic` | `actions/cache` for `~/.cache/ms-playwright`, `npx playwright install --with-deps chromium`, `npm run poc:matrix -- deterministic chromium` | The full registration + bulk-update E2E matrix (§8) against the local test sites, deterministic mapper, chromium only. `npm run poc:matrix` exits non-zero (`hasFailures`, `run/measure.ts`) if any site's registration, guard evaluation, bulk-update result/mandate, the trial-card decline path, or wall-detection/resume fixtures regress. `--with-deps` installs the Ubuntu packages Chromium needs on a fresh runner. |

**CI vs. local-only (decision for #45):**

- **In CI**: typecheck, unit/integration tests (incl. the AI-mapper tests against a stub
  provider), the PRIV-001/PRIV-002/SEC-002 static checks, and the deterministic E2E matrix on
  chromium. Both Playwright jobs cache `~/.cache/ms-playwright` so repeated runs can skip most
  browser downloads when the cache hits.
- **Local-only**: `npm run poc:matrix -- both` across `chromium,firefox,webkit` (PORT-001
  cross-engine coverage) and the AI variant against a real provider (`OPENAI_API_KEY` /
  `ANTHROPIC_API_KEY`, REQ-012) — both require either installing all three Playwright browser
  engines or a user-supplied AI provider key, neither of which CI provides. `npm run poc -- demo`
  (headed visual walkthrough) and the manual checklist (§6) also remain local/manual.
  `npm run e2e:app-ui` (§5, Issue #303) is likewise local-only for now: it launches a native
  Electron GUI plus a headed collection browser, which the Ubuntu CI runners would only
  support with extra display plumbing (Xvfb) we are not paying for yet. Run it as a
  manual / pre-release check. `npm run e2e:app-ui-exploration` (§5, Issue #251) and
  `npm run e2e:app-ui-logging` (§5, Issue #314) are the same decision for the same reason.
- Local AI review (`docs/local-ai-review.md`) remains local, as before.

## 8. Registration / Bulk-Update E2E Matrix (TEST-001 / #45)

`run/measure.ts` (`npm run poc:matrix`) is the E2E layer for the registration-first slices
(B/D): for each of the 10 local test sites (`sites/defs.ts`) it runs registration end to end
(discover → map → gate → fill → submit → record), then runs the bulk-update scenario, the
trial-card decline path, and the wall-detection / wall-resume fixtures. Ground truth is
embedded per field in `sites/defs.ts` and compared against both the agent's mapping plan and
what the local test-site server actually received. The table below maps each scenario to the
requirements it exercises (see [`requirements.md`](requirements.md) §6–7 for IDs). The upper
rows (sites `01`–`10`, bulk update, the wall fixtures, login/account routes) are the Playwright
E2E scenarios; the lower rows (Add Site, import review, AI mapper, crypto/recovery/vault,
egress/privacy/bypass, the `hasFailures` gate) are the supporting **`node --test`
unit/integration checks** that gate the same requirements — listed here for the requirement
traceability, not because they run in a browser.

| Scenario | Site(s) / fixture | Requirements |
| --- | --- | --- |
| Standard `<label for>` form, single address field | `01-basic` | REQ-003, REQ-004, REQ-006, PORT-001 |
| Split name/kana/postal/phone, structured address, email confirmation | `02-split` | REQ-004 (split-field transforms) |
| Legacy table layout, no label/id/placeholder/autocomplete | `03-cryptic` | REQ-004 (nearby-text classification) |
| Shuffled field order, placeholder-only labels | `04-shuffled` | REQ-004 |
| `select`/`radio`/`checkbox`-heavy form; "ご職業" is not in the seeded store | `05-choices` | REQ-004, REQ-005 (missing-field prompt + reuse) |
| Multi-step wizard (step1 → step2 → confirm → submit) | `06-wizard` | REQ-003, REQ-004 |
| SPA-like dynamic rendering (form appears ~400ms after load) | `07-dynamic` | REQ-003 (dynamic DOM) |
| High-risk terms (auto-renewal, third-party sharing) + "18歳以上" attestation | `08-terms` | REQ-006, REQ-007 guards 1 & 3, SAFE-001 |
| Free trial → paid subscription, card fields incl. CVV | `09-trial-card` | REQ-007 guard 2 (+ approved exception), SEC-001 (CVV) |
| Terms prohibit automated account creation → fill-only | `10-no-auto` | REQ-008 |
| Bulk update across all 10 sites after profile changes | "差分一括更新" (all sites) | REQ-010 (mandate), REQ-011 (diff-based update) |
| Trial-card decline path (future charge not approved) | `09-trial-card` decline | REQ-007 guard 2 negative path |
| CAPTCHA / OTP / email-verification fixtures | `/wall-fixture/*` | REQ-009, SEC-002 |
| Wall appears mid-flow → handoff → resume → success | `/wall-flow/` | REQ-009, SEC-002 |
| Login page fixture (per-site `/login` route) | all 10 sites | REQ-009 (login-wall hand-off) |
| Login + MFA wall fixture | `/login-wall/` | REQ-009, SEC-002 |
| Account settings extraction (per-site `/account` route) | all 10 sites | REQ-011 (import from read-only page) |
| Add Site branch selection: notRegistered / registered / uncertain | `soroeru-poc-add-site` | REQ-003, REQ-011 |
| Import review-before-save: approve with edits, decline, account page | `soroeru-poc-importer` | REQ-011, SEC-003 |
| Deterministic vs. AI mapping-plan comparison | all 10 sites, `deterministic` vs `ai` variant | REQ-004, REQ-012 |
| AI mapper schema, key/transform validation, terms analysis (stub provider) | `soroeru-poc-ai-mapper` | REQ-004, REQ-012, SEC-003 |
| Encrypted store, recovery key, encrypted export/import | `soroeru-poc-crypto`, `soroeru-poc-recovery`, `soroeru-vault-v2` | SEC-001, SEC-003 (recovery) |
| Network egress / local persistence / anti-bypass static checks | `soroeru-poc-egress`, `soroeru-poc-privacy`, `soroeru-poc-bypass` | PRIV-001, PRIV-002, SEC-002 |
| `hasFailures` CI gate over the above | `soroeru-poc-measure` | TEST-001 (this issue) |

All data, terms text, and prohibitions in the local test sites are fictional (§4
fake-data-only rule) and exist only to exercise `Soroeru`; real-site tests, real CAPTCHA/MFA
services, and a performance dashboard are explicitly non-scope (see Issue #45 non-scope;
performance baselines are tracked separately under PERF-001 / #18).

## 9. Phase-Timing Measurement (PERF-001 / #18)

Every `runRegistration` / `runUpdate` call reports per-phase elapsed time via
`AgentDeps.onPhase`, defined in `agent/perf.ts`:

| Phase | Covers |
| --- | --- |
| `discover` | navigate to the site, find the registration / edit link, navigate to it |
| `scan` | snapshot the page, wait for fields, clear any wall |
| `map` | run the mapper (`mapCurrentPage`) over the current page |
| `terms` | fetch terms-link text and run `analyzeTerms` |
| `gate` | build the `GateRequest` and render the review-and-confirm gate (excludes the human/scripted `gate.decide()` wait) |
| `fill` | fill mapped fields and set checkboxes (including intermediate wizard-step fills) |
| `submit` | click the final / save button and wait for the result page |
| `record` | update the site record, build the mandate, and persist the store |

`npm run poc:matrix` (`run/measure.ts`) accumulates these into
`SiteResultRow.phaseTimingsMs` / `UpdateResultRow.phaseTimingsMs`, prints a per-site
phase-timing table (`formatResult`), and persists them in `state/soroeru-poc/matrix-*.json` —
phase name and a millisecond number only, satisfying PRIV-001/PRIV-002 (no raw personal
values, page content, AI request payloads, or provider API keys ever appear in these tables).

A phase that exceeds `AF_POC_SLOW_PHASE_MS` (default 5000ms) emits a user-visible progress
note via `deps.log` (`slowPhaseNote`) so a long-running phase (e.g. a slow page render) does
not look like the agent is stuck. `soroeru-poc-perf` covers `emptyPhaseTimings` and
`slowPhaseNote` (threshold behavior, per-phase labels, and that the note contains only the
phase label and a duration).

A CI-mandatory performance gate, remote telemetry, and a full benchmark dashboard are
out of scope.

## 10. Strategy Decisions

Standing decisions for this strategy (Product Owner may revisit any in review):

- **Deliverable form** — this strategy lives in `docs/testing.md`, the repo's existing
  canonical testing doc. No separate testing RFC file is introduced (designs/specs are
  captured in Issues, not new spec files); `architecture.md` §12 remains the
  architecture-level source for the test approach and this document is its day-to-day
  expansion.
- **Coverage target** — **qualitative, risk-focused (§1, §1.2), no numeric coverage-percentage
  gate.** Coverage numbers reward exhaustive low-value tests, which is the opposite of the
  "not too many" goal. The CI gates that matter are the security static checks
  (PRIV-001/002, SEC-002) and the E2E `hasFailures` gate, not a line-coverage threshold.
- **Unit vs. E2E boundary** — unit/integration owns the trusted/domain layer, the IPC
  boundary, classification, guards/gate, vault/crypto, and the in-process web UI; the
  Playwright E2E matrix (§8) owns real-browser end-to-end registration/bulk-update flows and
  wall hand-off/resume. When a behavior is covered at both levels, prefer the lower level and
  keep the E2E case only for the genuinely end-to-end assertion. **Redesigning the E2E matrix
  itself (`run/measure.ts`) is out of scope here**; raise a separate Issue if unit/E2E
  responsibilities are found to overlap materially.
