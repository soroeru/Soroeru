# Development

> **⚠️ IN FLUX / partially superseded (2026-06-25).** The product is re-founded as
> **Soroeru（揃える）** (canonical direction: [`requirements.md`](requirements.md)). Target
> architecture / technology selection is now owned by
> [`rfc/rfc-002-soroeru-architecture.md`](rfc/rfc-002-soroeru-architecture.md). The setup,
> layout, commands, and packaging below describe the **previous Catashiro** codebase. They
> remain usable for the existing code, but the target stack, build, and packaging are
> updated by future RFC-002 implementation work; do not assume the details below are final.
> The repository identifier stays `soroeru`.

This document owns **local development workflow, repository layout,
implementation conventions, and the canonical quality gate list** for `Soroeru`.

> **Direction change (2026-06-12).** The project pivoted to `Catashiro`, a local-first
> autonomous agent (Playwright-based; see [`requirements.md`](requirements.md)).
> The MV3-extension build / layout / command details that used to live below have been
> removed along with that code (#68; history remains in git). This document now
> describes the `Soroeru` agent's setup, layout, and commands.

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
  scope decision of the product direction (see [`requirements.md`](requirements.md));
  do not introduce *other* frameworks, dependencies, backend services, cloud sync,
  telemetry, or AI providers without an explicit scope decision.
- Keep field detection, field classification, wall detection (CAPTCHA / MFA),
  the encrypted store, and UI concerns separated so they can be tested independently.
- Automatic submission and acceptance of ordinary terms are allowed **only** after
  the user approves the review-and-confirm gate, subject to the three guards.
- Never implement CAPTCHA / MFA / bot-detection bypass, silently proceeding past a
  detected automation-prohibiting ToS clause instead of surfacing it as a Constraint for
  the user to decide, auto-attestation of eligibility, sending raw personal values to the
  AI model, or storing data unencrypted.

## 2. Environment Setup

Required tools for `Soroeru` development:

- `git`
- `bash`
- `jq` for running the local AI review post-commit hook
- `shasum` on macOS or `sha256sum`
- Node.js 22 LTS for local development and macOS release packaging
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
encrypted store, measurement JSON) is written under `state/soroeru-poc/` and
must not be committed. See [`verification-results.md`](verification-results.md)
for full command reference and verification results.

### 3.2 Soroeru desktop app (RFC-002 scaffold, #158)

The Soroeru Electron app (main / preload / renderer) lives alongside the PoC
during the migration:

```bash
npm run dev            # build main + preload, start Vite dev server, launch Electron
npm run build:app      # tsc (main) + Vite preload bundle + Vite renderer build
npm run lint           # ESLint over electron/ and src/renderer/
npm run format         # Prettier check over the new app sources
npm run typecheck      # tsc for the node/main build AND the renderer build
```

Layout: `electron/` is the trusted main process (owns the Vault v2 lifecycle and
the typed IPC bridge); `src/renderer/` is the untrusted React UI surface that
reaches the vault only through `window.soroeru` (preload `contextBridge`). The
renderer window runs with `contextIsolation: true`, `nodeIntegration: false`,
and `sandbox: true`; the sandboxed preload is bundled to a self-contained
CommonJS file (`vite build --mode preload`). The vault file defaults to
`app.getPath("userData")/vault.json` (`.../Application Support/Soroeru`) and
still honors the `SOROERU_STATE_ROOT` override. App build output under `dist/`
is not committed.

## 3.1 Mac Beta Packaging

The Soroeru private-beta packaging path is an unsigned macOS DMG built with
Electron Forge and `@electron-forge/maker-dmg` (RFC-002 §2.6). It packages the
Electron app, Vite renderer, compiled main/preload code, installed npm
dependencies, and a hermetic Playwright Chromium browser so beta users do not
need a system Node.js install.

```bash
npm ci
npm run package:dmg
```

The script writes:

- `out/` Forge intermediate app / maker output
- `release/Soroeru-<version>.dmg`

`npm run package:dmg` runs `npm run build:app`, installs bundled Chromium with
`PLAYWRIGHT_BROWSERS_PATH=0`, invokes Electron Forge for `darwin`, then copies
the generated DMG to `release/Soroeru-<version>.dmg`. The package is unsigned
and not notarized for the MVP.

The packaged app name is `Soroeru.app`, with bundle identifier
`app.soroeru.soroeru`; the repository/package identifier remains `soroeru`.
The app uses Electron's embedded Node runtime. At runtime, packaged builds set
`PLAYWRIGHT_BROWSERS_PATH` to the bundled
`node_modules/playwright-core/.local-browsers` directory unless the environment
already overrides it. The vault defaults to
`~/Library/Application Support/Soroeru/vault.json`; `SOROERU_STATE_ROOT`
remains available for local migration tests and user-selected local vault
folders. Do not point it at shared cloud storage until a future encrypted-sync
Issue defines the provider and egress controls.

Runtime expectations for the first private beta:

- Node.js is not required on the beta Mac.
- The DMG is unsigned and not notarized until a later signing issue provides
  Developer ID credentials and release automation. Beta install notes must
  state this plainly.
- Gatekeeper may block first launch. Use Finder right-click -> Open, or for
  local testing only run `xattr -dr com.apple.quarantine /Applications/Soroeru.app`.
- `out/` and `release/` are ignored by Git. Do not commit `.app`, DMG, logs,
  vault files, or support bundles.
- This package is Mac-only; Windows/Linux/App Store/auto-update packaging is out of scope.

**Release automation.** Pushing a `v*` tag (e.g. `git tag v0.2 && git push origin v0.2`)
triggers the `release-mac` GitHub Actions workflow on `macos-latest`. It runs the full
release gate, builds the unsigned DMG, then uploads `release/Soroeru-<version>.dmg`
to the GitHub release for that tag. If you create the release on the GitHub UI first
(to write release notes), the workflow adds the artifact without overwriting your title
or notes. If you push the tag without a pre-created release, the workflow creates one
with auto-generated notes and marks it as a pre-release. No repository secrets are
required; the workflow uses the built-in `GITHUB_TOKEN`.

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
├── skills/            # repo-local Codex skills for project workflows
├── scripts/
│   ├── rename-dmg.mjs
│   └── setup-hooks.sh
├── website/           # static landing page for Mac beta download (website/index.html)
├── sites/             # local 10-pattern test sites (defs.ts + server.ts)
├── src/
│   ├── agent/         # scanner, deterministic classifier, guards, gate, walls, filler, orchestration
│   │   └── ai/        # AI mapper + provider abstraction
│   ├── app/           # SoroeruApp / AppRunner / startWebUiServer / AppUI
│   ├── dev/           # PRIV-001/002, SEC-002 static checks
│   ├── store/         # encrypted store (crypto, recovery, store)
│   ├── profile.ts
│   └── types.ts
├── run/               # measurement runner + CLI
├── tests/
│   └── unit/
├── package.json
├── package-lock.json
├── out/               # Electron Forge intermediate output (gitignored)
├── release/           # generated DMG artifacts (gitignored)
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
- `bash scripts/smoke-local-ai-review-branch-mapping.sh` for local AI review
  branch mapping changes
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

Setup, behavior, and troubleshooting for the local AI review hook live in
[`local-ai-review.md`](local-ai-review.md). The setup command is repeated
once in §2 above as part of environment setup; do not duplicate it elsewhere.

### 9.1 Issue Implementation Loop

This section defines the repository-local Issue implementation loop. The
matching Codex Skill lives in
[`skills/issue-implementation-loop/SKILL.md`](../skills/issue-implementation-loop/SKILL.md).

When the user asks an agent to implement one or more GitHub Issues in order,
use this loop for each Issue unless the user explicitly changes the workflow:

1. Fetch the latest `main` branch.
2. Create a new branch named for the Issue content.
3. Implement the Issue.
4. After committing, wait for local AI review and fix findings until the review
   status is `NIT_ONLY` or `PASS`; repeat at most three times.
5. Push the finished local branch to GitHub and create a PR. Include
   `Closes #<issue>` in the PR body so GitHub closes the Issue automatically
   when the PR is merged.
6. If PR CI fails, fetch the error logs, fix the failure, push again, and repeat
   until CI succeeds.
7. After CI succeeds, complete the PR according to the requested workflow and
   merge policy; if the requested workflow says to close the PR, close it
   instead of merging.
8. Repeat steps 1-7 for the next requested Issue without asking whether to
   start the next Issue, while still respecting sandbox, destructive-action,
   merge, and other approval requirements.

This loop intentionally closes PRs instead of merging them. Use it only when
the requested Issues can be implemented independently from the latest `main`;
if later Issues depend on earlier changes, merge or otherwise integrate those
changes before starting the dependent Issue. Step 6 has no fixed retry count,
but the session-limit check and normal blocker handling still apply.

## 10. Operational Notes

- `state/` is local state and must not be committed.
- `state/ai-reviews/` contains local AI review artifacts.
- `out/` and `release/` contain generated `.app` / DMG artifacts and must not be committed.
- `node_modules/`, build outputs, coverage, and common caches are ignored by
  Git.
- Keep durable workflow lessons near the owning document, Issue, or PR instead
  of reintroducing a generic learning log without a clear owner.
