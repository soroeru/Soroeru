# Development

This document owns **local development workflow, repository layout,
implementation conventions, and the canonical quality gate list** for `Catashiro`.

> **Direction change (2026-06-12).** The project pivoted to `Catashiro`, a local-first
> autonomous agent (Playwright-based; see [`rfc/rfc-001-chrome-autofill-pivot.md`](rfc/rfc-001-chrome-autofill-pivot.md)).
> The MV3-extension build / layout / command details that used to live below have been
> removed along with that code (#68; history remains in git). This document now
> describes the `Catashiro` agent's setup, layout, and commands.

Out of scope here: application architecture (see [`extension.md`](extension.md)),
product requirements (see [`requirements.md`](requirements.md)), test strategy
(see [`testing.md`](testing.md)), and GitHub workflow rules (see
[`github-operations.md`](github-operations.md)).

## 1. Development Policy

- Keep changes small enough to review as one coherent behavior, document, or
  workflow update.
- Prefer issue-driven branches named `<agent>/issue-<number>-<short-slug>`.
- Keep product requirements, application architecture, test strategy, and
  security assumptions in the owning docs rather than repeating them in `README.md`.
- Playwright browser automation and the user's configured AI provider are the
  scope decision of RFC-001 v3; do not introduce *other* frameworks, dependencies,
  backend services, cloud sync, telemetry, or AI providers without an explicit
  scope decision.
- Keep field detection, field classification, wall detection (CAPTCHA / MFA),
  the encrypted store, and UI concerns separated so they can be tested independently.
- Automatic submission and acceptance of ordinary terms are allowed **only** after
  the user approves the review-and-confirm gate, subject to the three guards.
- Never implement CAPTCHA / MFA / bot-detection bypass, auto-submit on
  auto-creation-prohibited sites, auto-attestation of eligibility, sending raw
  personal values to the AI model, or storing data unencrypted.

## 2. Environment Setup

Required tools for `Catashiro` development:

- `git`
- `bash`
- `jq` for running the local AI review post-commit hook
- `shasum` on macOS or `sha256sum`
- Node.js
- npm
- TypeScript
- Playwright browser binaries (Chromium / Firefox / WebKit) for the agent
  runtime and E2E tests

MVP development targets Apple Silicon Macs running macOS 14 Sonoma or macOS 15 Sequoia.
Other development hosts may be useful for code review or docs, but release and manual QA
for the private beta must run on the supported Mac target.

After cloning, install dependencies and the Playwright browsers:

```bash
npm install
npx playwright install chromium firefox webkit
```

Install local hooks only if the local AI review workflow is in use:

```bash
bash scripts/setup-hooks.sh
```

## 3. Run Locally

```bash
npm run poc:serve                 # local 10-pattern test sites (http://127.0.0.1:4333/)
npm run poc:matrix -- both        # measurement runs (deterministic + AI variants)
npm run poc -- register 09-trial-card   # headed demo with the interactive gate
npm run poc -- app                 # app-shell lifecycle smoke test (unlock/browser/lock)
npm run poc -- ui                  # local browser web app UI (personal data, sites, settings, ...)
npm run poc -- ui:cli              # legacy developer terminal UI fallback
npm run poc -- check-egress        # PRIV-001 static network-egress allowlist check
npm run poc -- check-persistence   # PRIV-002 static local-persistence allowlist check
npm run poc -- check-bypass        # SEC-002 static CAPTCHA/anti-bot-evasion dependency denylist check
npm run release:check              # beta privacy/security release gate (typecheck, unit, static hardening checks)
```

Each `npm run poc ...` invocation runs `npm run build` first. State (the
encrypted store, measurement JSON) is written under `state/catashiro-poc/` and
must not be committed. See [`verification-results.md`](verification-results.md)
for full command reference and verification results.

## 3.1 Mac Beta Packaging

The first beta packaging path intentionally avoids adding Electron, Tauri, auto-update,
or a hosted backend. `npm run package:mac` creates a small macOS `.app` wrapper around
the existing compiled TypeScript app and local web UI:

```bash
npm ci
npx playwright install chromium
npm run package:mac
```

The script writes:

- `release/Catashiro.app`
- `release/Catashiro-mac-beta.zip`

The generated app starts `dist/compiled/run/cli.js ui deterministic 0`, binds the local
web UI to `127.0.0.1`, opens the default browser, and stores the encrypted beta vault
under `~/Library/Application Support/Catashiro` unless `CATASHIRO_STATE_ROOT` is set.
Shutdown uses the existing `CatashiroApp.shutdown()` path, which closes tracked
Playwright browser sessions and locks the vault.

The shared default path is implemented in `src/store/vault.ts`. Use
`CATASHIRO_STATE_ROOT=/path/to/local/folder` for manual migration tests or a
user-selected local vault folder; do not point it at shared cloud storage until a future
encrypted-sync issue defines the provider and egress controls.

Runtime expectations for the first private beta:

- Node.js 22 or newer must be installed on the beta Mac, or `CATASHIRO_NODE_BINARY` must
  point to a bundled Node executable. The launcher checks common Homebrew locations and
  shows a macOS alert if Node is missing.
- The ZIP is unsigned and not notarized until a later signing issue provides developer
  credentials and release automation. Beta install notes must state this plainly.
- `release/` is ignored by Git. Do not commit `.app`, ZIP, logs, vault files, or support
  bundles.
- This package is Mac-only; Windows/Linux/App Store/auto-update packaging is out of scope.

Before sharing any private beta build, run the release-candidate checklist in
[`manual-test.md`](manual-test.md) §0. It is the owning checklist for release
branch/tag/artifact steps, required local and GitHub checks, install/uninstall, first
run, vault recovery, Add Site branches, registration, import, update, wall hand-off,
support-bundle review, and beta release-note limitations. Keep this section focused on
commands and packaging facts; keep the executable QA checklist in `manual-test.md`.

## 4. Project Structure

Current repository shape:

```text
.
├── .github/
│   ├── ISSUE_TEMPLATE/
│   └── workflows/
├── .githooks/
├── docs/
├── scripts/
│   ├── package-mac.sh
│   └── setup-hooks.sh
├── sites/             # local 10-pattern test sites (defs.ts + server.ts)
├── src/
│   ├── agent/         # scanner, deterministic classifier, guards, gate, walls, filler, orchestration
│   │   └── ai/        # AI mapper + provider abstraction
│   ├── app/           # CatashiroApp / AppRunner / startWebUiServer / AppUI
│   ├── dev/           # PRIV-001/002, SEC-002 static checks
│   ├── store/         # encrypted store (crypto, recovery, store)
│   ├── profile.ts
│   └── types.ts
├── run/               # measurement runner + CLI
├── tests/
│   └── unit/
├── package.json
├── package-lock.json
├── release/           # generated Mac app/ZIP artifacts (gitignored)
└── tsconfig.json
```

Update this section when real directories are added or removed.

## 5. Implementation Conventions

- Keep DOM scanning and metadata extraction isolated from rendering.
- Keep field classification rules isolated from automation-layer orchestration.
- Keep wall detection (CAPTCHA / MFA) separate from field classification.
- Keep storage access behind a small module so future migrations or encryption
  do not require changes across UI and automation code.
- Use typed profile field definitions (`src/types.ts`).
- Treat page text, attributes, and URL data as untrusted input.
- Keep the local web UI's styles scoped to its own server-rendered pages.
- Prefer explicit, user-approved actions for filling and submission (the
  review-and-confirm gate).
- Use fake data in examples, tests, screenshots, and fixtures.
- Avoid committed generated output unless the project later documents a reason
  to keep it under version control.

## 6. Formatting And Linting

No formatter or linter command exists yet. Add and document one when the project
needs formatting or lint coverage beyond TypeScript checks.

Current format command: none.

Current lint command: none.

## 7. Type Checking

Typecheck command:

```bash
npm run typecheck
```

## 8. Quality Gates

For documentation-only changes, review the rendered Markdown and check for
stale file references.

For Mac beta scope, also confirm docs and release notes do not imply support for Windows,
Linux, mobile apps, hosted vaults, telemetry, or a browser-extension distribution.

Before a private beta build is distributed, run the full Mac beta checklist in
[`manual-test.md`](manual-test.md) §0 and record the tested commit SHA or beta tag in the
release notes.

For production privacy/security hardening, run:

- `npm run release:check`

This command is the beta release gate for typecheck, unit tests, network-egress
allowlisting, local-persistence allowlisting, and CAPTCHA / anti-bot bypass dependency
denylisting. Treat any failure as a release blocker; the owning policy is
[`security.md`](security.md) §13.

For code changes, run the available gates:

- `npm run typecheck`
- `npm test`
- focused manual tests for affected browser behavior
- for changes touching network calls, AI provider config, or `package.json`
  dependencies: `npm run poc -- check-egress` (PRIV-001, see
  [`security.md`](security.md) §6)
- for changes touching profile-value display/logging or local file writes:
  `npm run poc -- check-persistence` and re-check the `maskValue` /
  `maskForArtifact` policy (PRIV-002, see [`security.md`](security.md) §3)
- for changes touching `package.json` dependencies or wall detection / handoff:
  `npm run poc -- check-bypass` (SEC-002, see [`security.md`](security.md) §7)

`npm test` runs the build and Node unit tests.

Only report checks as run when the command actually exists and has been
executed. If a command is not available yet, state that plainly in the PR.

## 9. Local AI Review

Setup, behavior, and troubleshooting for the local cross-AI review hook live
in [`local-ai-review.md`](local-ai-review.md). The setup command is repeated
once in §2 above as part of environment setup; do not duplicate it elsewhere.

## 10. Operational Notes

- `state/` is local state and must not be committed.
- `state/ai-reviews/` contains local AI review artifacts.
- `release/` contains generated `.app` / ZIP artifacts and must not be committed.
- `node_modules/`, build outputs, coverage, and common caches are ignored by
  Git.
- Keep durable workflow lessons near the owning document, Issue, or PR instead
  of reintroducing a generic learning log without a clear owner.
