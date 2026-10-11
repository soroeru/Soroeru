# AGENTS.md

Repository instructions shared by coding agents. Product intent belongs to
[`docs/requirements.md`](docs/requirements.md), technology choices to
[`docs/architecture.md`](docs/architecture.md), and security policy to
[`docs/security.md`](docs/security.md). Read the relevant document before changing its area;
do not duplicate those documents here.

## Product and role

Soroeru（揃える） is a local-first agency engine for personal information, online accounts,
and contracts. It helps a person exercise and grow their own agency; it does not delegate
judgment. The capability order is Visibility → Bulk Update → Withdrawal → Registration.

The human user is Product Owner and owns intent, priority, acceptance, and release judgment.
Agents cover implementation-side product clarification, design, programming, QA, review, and
release verification. Translate intent into concrete scope and risks, keep changes small, and
report residual risk honestly.

## Non-negotiable boundaries

- Automate toil, never judgment. Keep review/confirmation gates and Delegation Boundary rules
  explicit and testable.
- Never solve or bypass CAPTCHA, MFA, bot detection, rate limits, paywalls, or access controls.
  Detect them, hand off in the same headed browser session, and resume afterward.
- Apply the Three Guards: never perform checkout/payment except the explicitly approved
  free-trial-to-subscription case, escalate high-risk clauses, and never auto-attest.
- Never auto-attest eligibility or identity. Always confirm irreversible site withdrawal and
  deletion of Soroeru-held data.
- Surface automation-prohibiting terms as a Constraint for the user to decide; never silently
  proceed and never circumvent an actively enforced control.
- Keep personal data local and encrypted. Never add a hosted vault, telemetry containing
  personal data, or another non-approved egress path. Never log decrypted values. Target
  (Issue #554): Soroeru Cloud receives only structure, value-free Form Schemas, and typed
  allowlisted outcome telemetry; Gemini receives structure only, except the per-fallback
  consent-gated read, and never secrets (passwords, CVV, OTP, tokens, keys). Never write Tier 3
  request/response content to cloud schemas, telemetry, logs, or traces. Current Electron build
  only: Visibility collection (Issue #514) may send raw page values other than secrets to the
  user's configured AI provider; every other AI use stays structure-only. In every build, never
  send site passwords, CVV, or other secrets to any AI model.
- Passwords and CVV stay stored in the local encrypted vault and are filled into forms only by
  deterministic local code (Issue #572).
- Never store the 12-digit My Number or the card PIN. A site-collected CVV may be stored
  (Issue #516) but is read locally, never by a model; the canonical CVV remains most-sensitive
  per `docs/security.md`.
  Follow `docs/security.md` for identity, credential, card, encryption, and AI-provider handling.
- Use fake data only in tests, fixtures, screenshots, and documentation.

## Architecture constraints

- Follow `docs/architecture.md`: the target is a Chrome MV3 extension (Side Panel runtime host,
  service-worker router, content script) with an encrypted versioned local vault, plus Soroeru
  Cloud (Cloud Run, Firestore, BigQuery, Gemini on Vertex AI) for shared non-personal form
  intelligence (Issue #554). The Electron + Native Messaging build is the migration source.
  Playwright is development-only after the staged cutover.
- Deterministic/local resolution must keep working offline or with cloud assistance off.
  Resolution order is shared Form Schema → structure-only Gemini → consent-gated Gemini read;
  values are read and written locally in the first two tiers.
- Do not add frameworks, build tools, package managers, test runners, dependencies, backend
  services, AI providers, or cloud sync without explicit scope and the required Issue/RFC.
- Keep storage, domain policy, definition/analysis, automation, and UI responsibilities separate.
- Keep field classification and wall detection isolated and testable. Validate bounded AI
  proposals against the observed page, same-site/read-only policy, budgets, and wall state.

## Repository workflow

- Use GitHub Issues only for work tracking. Never query or mutate GitHub Projects.
  Use Issue labels and native `Blocked by` relations; no Project token is required.

- Use `rg`/`rg --files` for search and repository-local patterns before introducing new ones.
- When an Issue exists, work only in its matching `.worktrees/issue-<number>-<slug>` worktree via
  `scripts/issue-worktree.sh`; the primary clone is human-only. Resume inherited work with the
  `handoff-issue` skill. Never discard another worker's WIP.
- Follow [`docs/github-operations.md`](docs/github-operations.md) for branches, commits, PRs, and
  review.
- Do not commit secrets, real personal data, local state, or generated caches.
- Update user docs when behavior changes and technical docs when setup, commands, architecture,
  security, or workflow changes. `README.md` stays user-facing.
- Read only the Issue-specific file under `docs/design/`, when one exists. Do not bulk-load the
  directory.

## Working agreements and quality gates

Use the Node version in `.nvmrc`, then install with `npm ci`. Before committing code, run the
applicable commands and report any omission:

```bash
npm run format
npm run lint
npm run typecheck
npm test
```

Run `npm run release:check` for privacy/security or release-sensitive changes. Documentation-only
changes may instead review rendered Markdown, links, and stale references. Run the relevant
manual checks in `docs/manual-test.md` for automation, gates, wall hand-off, or encryption changes.
The canonical command details and targeted tests are in [`docs/development.md`](docs/development.md).

## Documentation ownership

- `docs/requirements.md`: canonical product direction and requirements
- `docs/architecture.md`: target architecture and technology selection
- `docs/security.md`: security/privacy decisions
- `docs/testing.md` and `docs/manual-test.md`: automated and manual test strategy
- `docs/development.md`: current setup, commands, quality gates, and implementation workflow
- `docs/github-operations.md`: Issue/worktree/branch/PR workflow

Apply the matching repository skill when requirements, architecture, a detailed design, tests, or
a single Issue implementation is created, changed, or reviewed.

## Codex-specific guidance

- Do not assume Claude Code hooks run. Run applicable checks explicitly.
- Codex instruction discovery concatenates guidance from the repository root toward the current
  directory; closer `AGENTS.md` files override this file. Keep root guidance concise so the full
  chain stays below Codex's configured byte limit.
- Prefer safe, reversible action within the requested scope. Ask before destructive operations or
  material scope expansion.
- Finish with changed files, important choices, checks run/not run, and follow-up work.
