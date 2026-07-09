# Development

> **⚠️ IN FLUX.** Target architecture / technology selection is owned by
> [`architecture.md`](architecture.md); the setup, layout, commands, and packaging below are
> updated by future `architecture.md`-driven implementation work, so do not assume the
> details below are final.

This document owns **local development workflow, repository layout,
implementation conventions, and the canonical quality gate list** for `Soroeru`.

Out of scope here: application architecture (see [`architecture.md`](architecture.md)),
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
must not be committed.

### 3.2 Soroeru desktop app (architecture.md §1 scaffold, #158)

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
Electron Forge and `@electron-forge/maker-dmg` (architecture.md §2). It packages the
Electron app, Vite renderer, compiled main/preload code, installed npm
dependencies, and a hermetic Playwright Chromium browser so beta users do not
need a system Node.js install.

```bash
nvm use            # Node 22 LTS (see .nvmrc); required for the DMG native deps
npm ci
npm run package:dmg
```

> **Node version matters for DMG packaging.** The maker chain
> (`@electron-forge/maker-dmg` → `electron-installer-dmg` → `appdmg`) pulls in
> `nan`-based native modules (`macos-alias`, `fs-xattr`) that do **not** compile
> against Node 23+ V8 headers. Because `appdmg` is an *optional* dependency, a
> too-new Node silently skips it at install time and the build later fails with
> `Cannot find module 'appdmg'`. Use Node 22 LTS (matches `.nvmrc` and CI). If
> you previously ran `npm ci` under Node 23+, switch to Node 22 and re-run
> `npm ci` so the native modules build. `npm run package:dmg` runs a preflight
> (`scripts/check-node-version.mjs`) that fails fast with this guidance.

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
├── .claude/
│   └── skills/        # committed relative symlinks exposing each repo skill to Claude Code
├── .github/
│   ├── ISSUE_TEMPLATE/
│   └── workflows/
├── .githooks/
├── docs/
├── skills/            # repo-local agent skills (issue-implementation + writing-good-tests)
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

The `.claude/skills/*` entries are committed relative symlinks into `skills/`
(e.g. `.claude/skills/writing-good-tests -> ../../skills/writing-good-tests`),
so a fresh clone restores them automatically — there is no manual setup step,
and skill content has a single source of truth under `skills/`.

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
- When writing or reviewing tests, use the repo-local **`writing-good-tests`** skill
  ([`skills/writing-good-tests/SKILL.md`](../skills/writing-good-tests/SKILL.md)) for
  *how* to write them — behavior over implementation, "not too many, mostly integration",
  condition-based waiting, and strategic mocking. The test **strategy** (what to test, by
  layer) stays in [`testing.md`](testing.md) §1–§2.
- Avoid committed generated output unless the project later documents a reason
  to keep it under version control.

## 6. Formatting And Linting

Format and lint checks exist for the Electron app sources and supporting app
configuration. Run them for code changes before committing, and use
`npm run format:write` only as a mechanical cleanup step before re-running the
check command.

Format check:

```bash
npm run format
```

Format write:

```bash
npm run format:write
```

Lint command:

```bash
npm run lint
```

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
allowlisting, local-persistence allowlisting, CAPTCHA / anti-bot bypass dependency
denylisting, and the dependency-audit gate (`audit:check`, see below). Treat any failure
as a release blocker; the owning policy is [`security.md`](security.md) §13.

### 8.1 Local dependency-audit gate (shift-left)

Dependency-vulnerability detection runs in CI (`SEC-003`, see
[`dependency-security.md`](dependency-security.md)). To catch new advisories locally
before CI, the same check is available as `npm run audit:check`
(= `npm audit --omit=dev --audit-level=high`) and is wired into `npm run release:check`
so the local release gate matches the CI gate.

Decision (why this shape):

- **Reuse, single source of truth.** Local and CI run the **same** `audit:check` script
  with the same threshold (`high`) and scope (`--omit=dev`, production = runtime +
  optional deps), so acceptance rules never drift between the two. Accepted build-time-
  only advisories are excluded by scope and tracked in [`security.md`](security.md) §12.0
  (no separate allowlist to maintain).
- **Where it runs.** In `release:check` (the release gate), **not** on every commit:
  `npm audit` needs the network and adds latency, so per-commit auditing would be noisy
  and offline-hostile. A `pre-push` git hook is a reasonable **opt-in** addition (mirror
  the opt-in model in [`local-ai-review.md`](local-ai-review.md)); it is intentionally
  not enabled by default.
- **Offline behavior.** `audit:check` requires registry access. When offline it will
  fail; that is acceptable for a release gate (a release should be audited online). For
  ordinary offline development, run the other gates individually
  (`npm run typecheck`, `npm test`, the `poc -- check-*` gates) and run `audit:check`
  when back online. Do not add a network call to per-commit gates.
- **Conclusion.** CI (#180) is the enforcing line of defense; this local hook is the
  shift-left convenience that shares its exact command, so a developer sees the same
  pass/fail before pushing.

### 8.2 Pre-commit quality gate hook

The `.githooks/pre-commit` hook automatically runs three gates before every
commit:

1. `npm run format` — Prettier format check
2. `npm run lint` — ESLint
3. `npm run typecheck` — TypeScript (main + renderer tsconfigs)

If any gate fails, the commit is aborted with a message indicating which gate
failed.

`npm test` is intentionally excluded from the pre-commit hook because it
includes a full build step and adds significant latency. Run `npm test` manually
or via `npm run release:check` before pushing.

**Skipping the hook:**

- Include `[skip-hooks]` in the commit message — the hook reads
  `.git/COMMIT_EDITMSG` and skips all gates. This leaves an auditable trace in
  the commit history.
- `git commit --no-verify` — git's built-in bypass (leaves no trace in the
  message).

The hook also skips automatically during merge, rebase, and cherry-pick
operations.

The hook is activated by `scripts/setup-hooks.sh` (sets
`core.hooksPath=.githooks`). No additional setup is required.

For code changes, run the available gates:

- `npm run format`
- `npm run lint`
- `npm run typecheck`
- `npm test`
- `bash scripts/smoke-local-ai-review-branch-mapping.sh` for local AI review
  branch mapping changes
- `bash scripts/smoke-wait-for-local-ai-review.sh` for changes to the local AI
  review completion-waiting script (see
  [`local-ai-review.md`](local-ai-review.md) §10)
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

## 9. Review

### 9.1 Code Review

Code review (human or AI) prioritizes, in this order:

1. **correctness** — bugs, off-by-one, null / empty handling, race conditions,
   error paths that swallow failures
2. **regressions** — behavior changes that break existing callers, tests, or
   documented contracts
3. **security** — input validation, auth, secrets in logs, command injection,
   path traversal, permission bits on state files
4. **missing tests** — new behavior or new branches that have no test coverage

This mirrors the local AI review's code-review criteria
(`.githooks/prompts/local-review-claude.md` /
`local-review-codex.md` / `local-review-grok.md`); keep them in sync if any
change.

### 9.2 Requirements Review

Requirements review targets diffs to `docs/requirements.md` and checks, in
priority order:

1. **unambiguous** — each changed statement allows exactly one interpretation
   (no vague qualifiers, undefined terms, or inconsistent naming)
2. **verifiable** — fulfillment can be objectively checked by test,
   inspection, or measurement
3. **consistent** — no contradiction with the rest of `docs/requirements.md`
   or the product principles (agency, never bypass walls, local-first)
4. **failure paths specified** — errors, walls, cancellation, and partial
   completion are stated, not just the happy path
5. **scope explicit** — out-of-scope and unstated assumptions are surfaced

The criteria derive from ISO/IEC/IEEE 29148 requirement quality
characteristics, prioritized by defect impact. They mirror
`skills/requirements-review/SKILL.md`; keep the two in sync if either
changes. The local AI review hook applies the skill automatically to commits
touching `docs/requirements.md` (see
[`local-ai-review.md`](local-ai-review.md) §5).

### 9.3 Design Doc Review

Design doc review targets `docs/design/*.md` implementation-session design
docs and checks, in priority order:

1. **traceability** — design elements map to requirements / Issue acceptance
   criteria, with no orphan elements and no uncovered requirements
2. **contracts and responsibilities** — component responsibilities, API /
   interface contracts, and the data model are implementable without guessing
3. **failure handling and state transitions** — error paths, wall hand-off,
   interruption / resume, and state transitions are designed, not just the
   happy path
4. **alternatives considered** — rejected options and the rationale for the
   chosen approach are recorded
5. **test strategy** — how the design's behavior will be verified is stated

The criteria mirror `skills/design-doc-review/SKILL.md`; keep the two in sync
if either changes. The local AI review hook applies the skill automatically
to commits touching `docs/design/` (see
[`local-ai-review.md`](local-ai-review.md) §5).

### 9.4 Architecture Review

Architecture review targets `docs/architecture.md` and checks, in priority
order, judged against Soroeru's context (single-user, local-first Electron
desktop app):

1. **requirements and constraint fit** — choices satisfy the non-negotiables
   and prioritized quality attributes, with trade-off points explicit
2. **system boundaries and data flow** — trust boundaries, where personal
   data may exist in what form, and every egress point
3. **dependencies** — justified, maintained, license-compatible, security
   surface understood, stack within the doc's own decisions
4. **failure modes and data integrity** — vault durability under crash /
   interruption, schema versioning / migration, local diagnosability
5. **decision records** — significant decisions captured ADR-style with
   alternatives, rationale, and reconsideration triggers

A criterion that genuinely does not apply is answered "not applicable" with
a reason, not forced. The criteria mirror
`skills/architecture-review/SKILL.md`; keep the two in sync if either
changes. The local AI review hook applies the skill automatically to commits
touching `docs/architecture.md` (see
[`local-ai-review.md`](local-ai-review.md) §5).

### 9.5 Local AI Review

Setup, behavior, and troubleshooting for the local AI review hook live in
[`local-ai-review.md`](local-ai-review.md). The setup command is repeated
once in §2 above as part of environment setup; do not duplicate it elsewhere.

## 10. Issue Implementation

This section defines the repository-local single-Issue implementation workflow. The
matching Codex Skill lives in
[`skills/issue-implementation/SKILL.md`](../skills/issue-implementation/SKILL.md).

When the user asks an agent to implement one GitHub Issue, use this workflow
unless the user explicitly changes it:

1. Fetch the latest `main` branch.
2. Create a new branch named for the Issue content.
3. Implement the Issue.
4. After committing, check the commit command's own output for
   `[local-ai-review] queued ...`. If present, wait for that result by
   running `scripts/wait-for-local-ai-review.sh` (see
   [`local-ai-review.md`](local-ai-review.md) §10 for the script, and §6/§7 for
   the review-count cap and follow-up policy) rather than polling
   `state/ai-reviews/` turn-by-turn. This workflow allows up to two local AI
   review runs total: apply a fix pass for the first review's actionable
   findings and commit it *without* `LOCAL_AI_REVIEW_RUNNING=1` (a confirming
   second review runs on that fix commit); if that second review still has
   actionable findings, apply one more fix pass and commit it *with*
   `LOCAL_AI_REVIEW_RUNNING=1` so a third review never starts.
5. Push the finished local branch to GitHub and create a PR. Include
   `Closes #<issue>` in the PR body so GitHub closes the Issue automatically
   when the PR is merged. Also include the local AI review status for each
   run, actionable findings, and what was fixed. If review did not run or
   residual risk remains once the two-review cap is reached, state that
   clearly.

The workflow intentionally avoids an open-ended review loop, capped at two
review runs total. If the user gives multiple Issue numbers, ask which single
Issue to implement first.

## 11. Operational Notes

- `state/` is local state and must not be committed.
- `state/ai-reviews/` contains local AI review artifacts.
- `out/` and `release/` contain generated `.app` / DMG artifacts and must not be committed.
- `node_modules/`, build outputs, coverage, and common caches are ignored by
  Git.
- Keep durable workflow lessons near the owning document, Issue, or PR instead
  of reintroducing a generic learning log without a clear owner.
