# Testing

This document owns the **testing strategy** for `Catashiro`: what to test, which test
types apply, and how the suites map to the architecture layers.

> **Direction change (2026-06-12).** The project pivoted to `Catashiro`, a local-first
> autonomous agent. End-to-end tests use **Playwright** (Chromium / Firefox / WebKit)
> against local test sites; see [`rfc/rfc-001-chrome-autofill-pivot.md`](rfc/rfc-001-chrome-autofill-pivot.md)
> §8. The MV3-extension-specific guidance below is historical and is being updated
> alongside the PoC implementation (#33). The risk-focused strategy and fake-data-only
> rule still apply.

Out of scope here: the browser-based manual checklist itself (see
[`manual-test.md`](manual-test.md)) and the canonical command list (see
[`development.md`](development.md)).

## 1. Test Strategy

Testing should focus on the parts that carry product and safety risk:

- deterministic and AI-driven field classification / mapping;
- wall detection (CAPTCHA / MFA / verification) and hand-off / resume;
- the review-and-confirm gate and the three guards;
- the encrypted store, recovery key, and provider settings;
- bulk update and per-site record diffing;
- network egress and local-persistence boundaries (PRIV-001/002, SEC-002).

Use unit tests (§2.1) for deterministic logic and isolated modules, the Playwright
E2E matrix (§8) for end-to-end flows against the local test sites, and the manual
checklist ([`manual-test.md`](manual-test.md)) for headed-browser UX that needs human
judgment. Use **fake data only** everywhere (§4).

## 2. Test Types

| Type | Purpose | Target |
| --- | --- | --- |
| Unit | Verify pure rules and small modules in isolation. | Field classification, normalization, wall detection, guards, store/crypto, AI mapper (stub provider). |
| E2E | Verify the agent end to end in a real browser (Playwright). | Registration, bulk update, wall handoff/resume, and the review-and-confirm gate against the local test sites (§8). |
| Manual | Verify UX and safety boundaries automation can't judge. | Review-and-confirm gate copy, wall handoff, local web UI, release readiness ([`manual-test.md`](manual-test.md)). |

### 2.1 Layer → test mapping (MAINT-001)

Each architecture layer (see [`extension.md`](extension.md) §1.1) is unit-testable in
isolation. Current coverage:

| Layer / seam | Modules | Tests |
| --- | --- | --- |
| Store (crypto boundary) | `store/crypto.ts`, `store/store.ts` | `catashiro-poc-crypto.test.ts` |
| Agent — deterministic mapper | `agent/classifier.ts`, `agent/guards.ts` | `catashiro-poc-classifier.test.ts`, `catashiro-poc-guards.test.ts` |
| Agent — AI mapper | `agent/ai/ai-mapper.ts`, `agent/ai/provider.ts` | `catashiro-poc-ai-mapper.test.ts` |
| Agent — wall detection | `agent/walls.ts` | `catashiro-poc-walls.test.ts` |
| Agent — phase timing (PERF-001) | `agent/perf.ts` | `catashiro-poc-perf.test.ts` |
| Shared contracts & seams | `types.ts`, `mapper.ts`, `normalization.ts` | `catashiro-poc-contracts.test.ts` |
| Automation (DOM scan) | `agent/scan.ts` | exercised via the E2E matrix (§8, `catashiro-poc-measure.test.ts`) |
| UI — local web app | `app/web-ui.ts` | `catashiro-poc-web-ui.test.ts` |
| UI — Add Site branch selection | `app/web-ui.ts` (`addSite`) | `catashiro-poc-add-site.test.ts` |
| UI — legacy terminal fallback | `app/ui.ts` | `catashiro-poc-ui.test.ts` |
| Agent — existing-account import | `agent/importer.ts` | `catashiro-poc-importer.test.ts` |
| Measurement / CI gate | `run/measure.ts` | `catashiro-poc-measure.test.ts` |
| Dev checks (PRIV-001/002, SEC-002) | `src/dev/{egress,privacy,bypass}-check.ts` | `catashiro-poc-{egress,privacy,bypass}.test.ts` |

`catashiro-poc-contracts.test.ts` additionally locks the cross-layer invariant that the
agent layer never receives raw personal values.

## 3. Test Environment

The automated test runner is Node's built-in test runner, run against compiled output
(see [`development.md`](development.md) for commands).

- **Unit**: Node built-in test runner (`node --test`) over `tests/unit/*.test.ts`,
  compiled to `dist/compiled/tests/unit/`.
- **E2E**: Playwright drives the local test sites (`sites/`) across Chromium / Firefox
  / WebKit; see §8.
- **Manual**: a headed browser against the local test sites, per
  [`manual-test.md`](manual-test.md).

## 4. Test Data And Fixtures

The local test sites under `sites/` (`sites/defs.ts` for form definitions and ground
truth, `sites/server.ts` to serve them) are the fixtures for both the E2E matrix (§8)
and manual testing. §8 lists each site's form shape and the requirements it exercises.

Rules for any test data, fixtures, or local test sites:

- use fake names, emails, phone numbers, addresses, company names, and department
  names — Japanese only (multi-locale form detection is out of scope for now, see
  [`requirements.md`](requirements.md) §5);
- never commit real personal data, real customer data, or screenshots/forms containing
  private data;
- CAPTCHA-like, MFA-like, terms, consent, and final-confirmation placeholders must not
  use real CAPTCHA or MFA services.

## 5. Commands

Test commands belong with the rest of the quality gates in
[`development.md`](development.md).

Current automated test command:

```bash
npm test
```

`npm test` builds the project, then runs unit tests from `tests/unit/` (Node's
built-in test runner).

For the `Catashiro` agent (§8 below), the E2E test matrix is run via:

```bash
npm run poc:matrix -- deterministic chromium   # CI: see §7
npm run poc:matrix -- both                     # local: all engines + AI variant if a key is configured
```

## 6. Manual Testing

Use [`manual-test.md`](manual-test.md) for browser-based checklists. Per AGENTS.md
"Manual Testing Expectations", manual checks are required when a change affects form
detection, filling, submission, the review-and-confirm gate, the three guards, wall
hand-off, or storage/encryption behavior.

For Mac private beta releases, [`manual-test.md`](manual-test.md) §0 is the owning
release QA checklist. It combines automated gates with manual install / uninstall, first
run, vault recovery, Add Site branching, registration, existing-account import, bulk
update, wall hand-off / resume, support-bundle review, and release-note limitation checks.
Run it against the packaged `.app` artifact before sharing a build with beta users.

## 7. CI

`.github/workflows/ci.yml` (TEST-001 / #45) runs on every pull request and on
push to `main`:

| Job | Steps | Covers |
| --- | --- | --- |
| `unit` | `npm run typecheck`, `npm test`, `npm run poc -- check-egress` (PRIV-001), `npm run poc -- check-persistence` (PRIV-002), `npm run poc -- check-bypass` (SEC-002) | All unit-testable layers in §2.1, including the AI mapper exercised against a `StubProvider` (`catashiro-poc-ai-mapper.test.ts`) — no real API key is used or required. |
| `e2e-deterministic` | `npx playwright install --with-deps chromium`, `npm run poc:matrix -- deterministic chromium` | The full registration + bulk-update E2E matrix (§8) against the local test sites, deterministic mapper, chromium only. `npm run poc:matrix` exits non-zero (`hasFailures`, `run/measure.ts`) if any site's registration, guard evaluation, bulk-update result/mandate, the trial-card decline path, or wall-detection/resume fixtures regress. |

**CI vs. local-only (decision for #45):**

- **In CI**: typecheck, unit tests (incl. the AI-mapper unit tests against a
  stub provider — this is the "AI variant via stub provider" the Claude
  review follow-up on #45 asked for), the PRIV-001/PRIV-002/SEC-002 static
  checks, and the deterministic E2E matrix on chromium.
- **Local-only**: `npm run poc:matrix -- both` across `chromium,firefox,webkit`
  (PORT-001 cross-engine coverage) and the AI variant against a real provider
  (`OPENAI_API_KEY` / `ANTHROPIC_API_KEY`, REQ-012) — both require either
  installing all three Playwright browser engines or a user-supplied AI
  provider key, neither of which CI provides. `npm run poc -- demo` (headed
  visual walkthrough) and the manual checklist (§6,
  [`manual-test.md`](manual-test.md)) also remain local/manual.
- Local AI review (`docs/local-ai-review.md`) remains local, as before.

## 8. Catashiro PoC Test Matrix (TEST-001 / #45)

`run/measure.ts` (`npm run poc:matrix`) is the E2E layer:
for each of the 10 local test sites (`sites/defs.ts`) it
runs registration end to end (discover → map → gate → fill → submit →
record), then runs the bulk-update scenario, the trial-card decline path, and
the wall-detection / wall-resume fixtures. Ground truth is embedded per field
in `sites/defs.ts` and compared against both the agent's mapping plan and what
the local test-site server actually received. The table below maps each
scenario to the requirements it exercises (see [`requirements.md`](requirements.md)
§6–7 for IDs).

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
| Add Site branch selection: notRegistered / registered / uncertain | `catashiro-poc-add-site.test.ts` | REQ-003, REQ-011 |
| Import review-before-save: approve with edits, decline, account page | `catashiro-poc-importer.test.ts` | REQ-011, SEC-003 |
| Deterministic vs. AI mapping-plan comparison | all 10 sites, `deterministic` vs `ai` variant | REQ-004, REQ-012 |
| AI mapper schema, key/transform validation, terms analysis (stub provider) | `catashiro-poc-ai-mapper.test.ts` | REQ-004, REQ-012, SEC-003 |
| Encrypted store, recovery key, encrypted export/import | `catashiro-poc-{crypto,recovery}.test.ts` | SEC-001, SEC-003 (recovery) |
| Network egress / local persistence / anti-bypass static checks | `catashiro-poc-{egress,privacy,bypass}.test.ts` | PRIV-001, PRIV-002, SEC-002 |
| `hasFailures` CI gate over the above | `catashiro-poc-measure.test.ts` | TEST-001 (this issue) |

All data, terms text, and prohibitions in the local test sites are fictional
(§4 fake-data-only rule) and exist only to exercise `Catashiro`; real-site
tests, real CAPTCHA/MFA services, and a performance dashboard are explicitly
non-scope for this issue (see Issue #45 non-scope; performance baselines are
tracked separately under PERF-001 / #18).

## 9. Phase-Timing Measurement (PERF-001 / #18)

Every `runRegistration` / `runUpdate` call reports per-phase elapsed time via
`AgentDeps.onPhase`, defined in `src/agent/perf.ts`:

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

`npm run poc:matrix` (`run/measure.ts`) accumulates these
into `SiteResultRow.phaseTimingsMs` / `UpdateResultRow.phaseTimingsMs`, prints
a per-site phase-timing table (`formatResult`), and persists them in
`state/catashiro-poc/matrix-*.json` — phase name and a millisecond number only,
satisfying PRIV-001/PRIV-002 (no raw personal values, page content, AI request
payloads, or provider API keys ever appear in these tables).

A phase that exceeds `AF_POC_SLOW_PHASE_MS` (default 5000ms) emits a
user-visible progress note via `deps.log` (`slowPhaseNote`) so a long-running
phase (e.g. a slow page render) does not look like the agent is stuck.
`catashiro-poc-perf.test.ts` covers `emptyPhaseTimings` and `slowPhaseNote`
(threshold behavior, per-phase labels, and that the note contains only the
phase label and a duration).

Baseline numbers for the ordinary (`01-basic`), wizard (`06-wizard`), and
dynamic (`07-dynamic`) fixtures are recorded in
[`verification-results.md`](verification-results.md). A
CI-mandatory performance gate, remote telemetry, and a full benchmark
dashboard are non-scope for this issue.
