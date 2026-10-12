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

## Product and implementation boundaries

- Product/authorization decisions belong in `docs/requirements.md`, data handling in
  `docs/security.md`, and component boundaries in `docs/architecture.md`. Read the relevant
  owner before changing that area; do not copy the full policy into agent instructions.
- Distinguish target policy from shipped behavior. A documentation change does not authorize
  an unimplemented data path. Implement and test its scope, revocation and failure handling first.
- Never bypass access controls, auto-attest identity/eligibility, or disclose secrets to AI.
  Keep required consequential confirmations and local encrypted storage testable.
- Use fake data only in tests, fixtures, screenshots and documentation. Never log decrypted values.
- Do not introduce frameworks, dependencies, providers, services or vault sync without explicit
  Issue scope. Keep domain policy, storage, classification, wall detection and UI separate.

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
- Keep implementation plans, design detail, evaluations and review evidence in the Issue/PR.
  Do not create per-Issue document files or archives; update owning docs only for durable decisions.

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

Apply the matching repository skill when requirements, architecture, an Issue design, tests, or
a single Issue implementation is created, changed, or reviewed.

## Codex-specific guidance

- Do not assume Claude Code hooks run. Run applicable checks explicitly.
- Codex instruction discovery concatenates guidance from the repository root toward the current
  directory; closer `AGENTS.md` files override this file. Keep root guidance concise so the full
  chain stays below Codex's configured byte limit.
- Prefer safe, reversible action within the requested scope. Ask before destructive operations or
  material scope expansion.
- Finish with changed files, important choices, checks run/not run, and follow-up work.
