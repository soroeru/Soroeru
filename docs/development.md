# Development

This document owns **local development workflow, repository layout,
implementation conventions, and the canonical quality gate list** for `autofill`.

> **Direction change (2026-06-12).** The project pivoted to `autofill`, a local-first
> autonomous agent (Playwright-based; see [`rfc/rfc-001-chrome-autofill-pivot.md`](rfc/rfc-001-chrome-autofill-pivot.md)).
> The MV3-extension build / layout / command details below are historical and are being
> updated alongside the PoC implementation (#33). General conventions (small reviewable
> changes, quality gates before committing, fake data only) still apply.

Out of scope here: application architecture (see [`extension.md`](extension.md)),
product requirements (see [`requirements.md`](requirements.md)), test strategy
(see [`testing.md`](testing.md)), and GitHub workflow rules (see
[`github-operations.md`](github-operations.md)).

## 1. Development Policy

- Keep changes small enough to review as one coherent behavior, document, or
  workflow update.
- Prefer issue-driven branches named `<agent>/issue-<number>-<short-slug>`.
- Keep product requirements, extension design, test strategy, and security
  assumptions in the owning docs rather than repeating them in `README.md`.
- Do not introduce frameworks, dependencies, backend services, AI classifiers,
  or browser automation services without an explicit scope decision.
- Do not broaden Chrome extension permissions without documenting the need.
- Keep form detection, field classification, manual-step detection, storage,
  and UI concerns separated so they can be tested independently.
- Never implement automatic submission, terms acceptance, CAPTCHA bypass, MFA
  bypass, or hidden high-impact actions.

## 2. Environment Setup

Required tools for current extension development:

- `git`
- `bash`
- `jq` for running the local AI review post-commit hook
- `shasum` on macOS or `sha256sum`
- Node.js
- npm
- TypeScript
- Chrome or Chromium for extension loading

After cloning, install dependencies:

```bash
npm install
```

Install local hooks only if the local AI review workflow is in use:

```bash
bash scripts/setup-hooks.sh
```

## 3. Run Locally

Build the unpacked extension:

```bash
npm run build
```

The build output is `dist/extension/`. Manual loading flow:

1. run `npm run build`;
2. open Chrome's extensions page;
3. enable developer mode;
4. load `dist/extension/` as an unpacked extension;
5. open the extension options page;
6. add, edit, delete, list, and clear fake profile fields.

The current implementation only includes the Manifest V3 shell, local profile
storage abstraction, and options page profile editor. Content-script scanning,
field filling, and background service worker behavior are not implemented yet.

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
├── src/
│   ├── manifest.json
│   ├── options/
│   ├── shared/
│   └── storage/
├── tests/
│   └── unit/
├── package.json
├── package-lock.json
└── tsconfig.json
```

Expected future structure as remaining extension boundaries are added:

```text
.
├── src/
│   ├── background/
│   ├── content/
│   ├── options/
│   ├── storage/
│   └── shared/
├── tests/
│   ├── fixtures/
│   ├── unit/
│   ├── integration/
│   └── e2e/
└── docs/
```

The exact structure may change as remaining extension boundaries are added.
Update this section when real directories are added.

## 5. Implementation Conventions

- Keep DOM scanning and metadata extraction isolated from rendering.
- Keep field classification rules isolated from content script orchestration.
- Keep manual-step detection separate from field classification.
- Keep storage access behind a small module so future migrations or encryption
  do not require changes across UI and content code.
- Use typed profile field definitions when TypeScript is introduced.
- Treat page text, attributes, and URL data as untrusted input.
- Keep injected UI styles scoped to avoid breaking host pages.
- Prefer explicit, user-triggered commands for filling.
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

For code changes, run the available gates:

- `npm run typecheck`
- `npm test`
- focused manual tests for affected browser behavior

`npm test` runs the extension build and Node unit tests.

Only report checks as run when the command actually exists and has been
executed. If a command is not available yet, state that plainly in the PR.

## 9. Local AI Review

Setup, behavior, and troubleshooting for the local cross-AI review hook live
in [`local-ai-review.md`](local-ai-review.md). The setup command is repeated
once in §2 above as part of environment setup; do not duplicate it elsewhere.

## 10. Operational Notes

- `state/` is local state and must not be committed.
- `state/ai-reviews/` contains local AI review artifacts.
- `node_modules/`, build outputs, coverage, and common caches are ignored by
  Git.
- Keep durable workflow lessons near the owning document, Issue, or PR instead
  of reintroducing a generic learning log without a clear owner.
