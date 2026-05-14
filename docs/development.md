# Development

This document owns local development workflow and implementation conventions.

Architecture decisions belong in [`extension.md`](extension.md). Product
requirements belong in [`requirements.md`](requirements.md).

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

The implementation toolchain is not installed yet. At the time of this
document, the repository does not contain `package.json` or `manifest.json`.

Required tools for current documentation and local hook work:

- `git`
- `bash`
- `jq` for running the local AI review post-commit hook
- `shasum` on macOS or `sha256sum`

Expected future extension toolchain:

- Node.js and npm or another documented package manager
- TypeScript
- Chrome or Chromium for extension loading
- a test runner selected when implementation starts

After cloning, install local hooks only if the local AI review workflow is in
use:

```bash
bash scripts/setup-hooks.sh
```

Do not run `npm install` until a `package.json` exists.

## 3. Run Locally

There is no runnable extension build yet. Once `manifest.json` and the build
tooling exist, this section should contain the exact build command and Chrome
loading steps.

Expected manual loading flow after implementation starts:

1. build the extension into the documented output directory;
2. open Chrome's extensions page;
3. enable developer mode;
4. load the unpacked extension directory;
5. open a local fixture or safe test page;
6. verify detection, suggestions, selected filling, and manual-step handling.

Current local run command: none.

## 4. Project Structure

Current repository shape:

```text
.
├── .github/
│   ├── ISSUE_TEMPLATE/
│   └── workflows/
├── .githooks/
├── docs/
└── scripts/
```

Expected structure once implementation begins:

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

The exact structure may change when tooling is chosen. Update this section when
real directories are added.

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

No formatter or linter command exists yet because the JavaScript / TypeScript
tooling has not been added.

When tooling is introduced, document the exact commands here and keep them in
sync with `package.json`.

Current format command: none.

Current lint command: none.

## 7. Type Checking

No typecheck command exists yet. TypeScript is the preferred implementation
direction, but the repository should not claim a passing typecheck until the
tooling and command exist.

Current typecheck command: none.

## 8. Quality Gates

For documentation-only changes, review the rendered Markdown and check for
stale file references.

For future code changes, expected gates are:

- format
- lint
- typecheck
- unit tests
- integration tests where affected
- extension build
- focused manual tests for browser behavior

Only report checks as run when the command actually exists and has been
executed. If a command is not available yet, state that plainly in the PR.

## 9. Local AI Review

Install hooks with:

```bash
bash scripts/setup-hooks.sh
```

Detailed hook behavior belongs in [`local-ai-review.md`](local-ai-review.md).

## 10. Operational Notes

- `state/` is local state and must not be committed.
- `state/ai-reviews/` contains local AI review artifacts.
- `node_modules/`, build outputs, coverage, and common caches are ignored by
  Git.
- Keep durable workflow lessons near the owning document, Issue, or PR instead
  of reintroducing a generic learning log without a clear owner.
