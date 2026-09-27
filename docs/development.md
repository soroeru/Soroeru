# Development

This document owns **local development workflow, repository layout,
implementation conventions, and the canonical quality gate list** for `Soroeru`.
Commands in this document describe the current repository. Target architecture and staged
migration decisions remain owned by [`architecture.md`](architecture.md); where current and target
states differ, this document labels the transition explicitly.

Out of scope here: application architecture (see [`architecture.md`](architecture.md)),
product requirements (see [`requirements.md`](requirements.md)), test strategy
(see [`testing.md`](testing.md)), and GitHub workflow rules (see
[`github-operations.md`](github-operations.md)).

## 1. Development Policy

- Keep changes small enough to review as one coherent behavior, document, or
  workflow update.
- Use Issue branches named `issue-<number>-<short-slug>` in matching
  `.worktrees/issue-<number>-<short-slug>` worktrees.
- Keep product requirements, application architecture, test strategy, and
  security assumptions in the owning docs rather than repeating them in `README.md`.
- Browser automation (the target extension front door, current migration-stage Playwright
  path) and the user's configured AI provider are the
  scope decision of the product direction (see [`requirements.md`](requirements.md));
  do not introduce _other_ frameworks, dependencies, backend services, cloud sync,
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

After cloning, install locked dependencies and the Playwright browsers used by the current runtime
and development-only E2E suite. Issue #391 makes the Chrome extension the target production
front door; a follow-up retirement Issue will remove production Playwright/browser packaging,
but these commands remain current until that cutover lands:

```bash
npm ci
npx playwright install chromium firefox webkit
```

### Agent configuration

`AGENTS.md` is the concise shared instruction source. `CLAUDE.md` imports it with `@AGENTS.md` and
contains Claude-only session conventions; `.agents/rules/GEMINI.md` is a small Gemini/agy adapter,
not a synchronized copy. Area-specific guidance lives in Claude path rules and nested `AGENTS.md`
files so it loads only when relevant.

Claude Code project hooks in `.claude/settings.json` block commits from the human-only primary
clone and direct reads of the real-password CSV or local AI review artifacts. These agent-layer
guards complement, rather than replace, the Git hooks installed by `scripts/setup-hooks.sh`.
Quality gates remain in the Git pre-commit hook rather than being duplicated in Claude settings.

High-side-effect skills are manually invocable, and Issue lifecycle skills advertise their Issue
number argument. Repository skills intentionally do not grant broad `allowed-tools`: their GitHub,
Git, browser, and filesystem operations need the runtime's normal permission policy. The two
Claude subagents use role-limited tool lists and intentionally have no persistent memory; durable
decisions belong in reviewed Issues or repository documents. Add skill eval fixtures only with a
separate acceptance baseline and owner, so generated eval results do not become unreviewed policy.

Install local hooks only if the local AI review workflow is in use:

```bash
bash scripts/setup-hooks.sh
```

The Chrome extension bridge is the **target production browser front door** (decision #391),
but the current implementation remains a migration-stage feature flag and is not yet the
default. Developer validation may enable its Electron-side UNIX
socket listener with `SOROERU_ENABLE_CHROME_BRIDGE=1`; the bridge still requires
the native-host handshake token and rejects unknown commands. To route a
Visibility run through `ExtensionPageDriver` (Issue #338) instead of Playwright,
also set `SOROERU_CHROME_BRIDGE_TAB_ID` to the positive Chrome tab id already
bound/authorized in the extension. This environment-variable tab selection is explicitly
temporary: production requires an extension-created binding offer, exact-origin permission,
Electron confirmation, and a memory-only tab lease. Without that env var the current
Playwright path is unchanged; there is no silent fallback after the extension cutover.

## 3. Run Locally

### 3.0 GitHub Project issue defaults

`.github/workflows/project-issue-defaults.yml` runs on `issues.opened` and on
manual `workflow_dispatch` (with `issue_number`). Because GitHub Actions does
not expose the organization-level `projects_v2_item` webhook as a repository
workflow trigger, it also runs a 15-minute scheduled reconciliation to configure
Issues that were added to the Project manually. The reconciliation selects only
Project items missing Priority, Size, or Feature group. When exactly one Project
is configured, every Issue is added to it; deterministic classification is used
only to choose among multiple configured Projects. It resolves Project, field,
option, item, and iteration IDs by name through GraphQL; IDs are intentionally
not stored in the repository. The workflow sets Priority, Size, Feature group,
and Start/Target date. It also sets Iteration when an exact-name iteration
already exists; it never changes Project field configuration using the
short-lived App token. Feature group is copied from the bounded
`project-metadata` block in the Issue body. Agent/model assignment is decided at
orchestration run time and is **not** stored in the Project or the Issue body;
the former `AI Assignees` / `AI Sub Assignees` fields are abolished (the
Product Owner deletes those two single-select fields from the Project settings
UI once — the automation ignores them either way, and legacy Issues that still
contain AI Assignee lines or an `implementation-assignment` block are processed
with those fields ignored, never rejected).

The Visibility Project is organization-owned (`soroeru` org, Project number in
`config/github-projects.json`). The workflow authenticates with a **short-lived
GitHub App installation token** from the dedicated App
`soroeru-project-automation` (not a long-lived PAT and not bare `GITHUB_TOKEN`
for Project writes).

The workflow is fail-close: every read and validation completes before the
first GraphQL mutation (a validation failure performs zero mutations), and a
final readback confirms all written fields converged. A partial failure
returns `{"status":"retryable-error","reason":...}` — with the unconverged
Project field names for `project-fields-unconverged` — and rerunning the
workflow reconciles by reusing the existing Project item and exact-name
iteration. Exercise the implementation locally with:

```bash
node --test tests/unit/project-issue-defaults.test.mjs
node scripts/project-issue-defaults.mjs --event path/to/issues-opened.json
```

#### GitHub App setup (repository administrators)

1. Create a GitHub App (example name: `soroeru-project-automation`) owned by
   an account that can install it on the **`soroeru` organization**.
2. **Repository permissions:** Metadata (read), Issues (read). Leave other
   repository permissions at No access.
3. **Organization permissions:** Projects (read and write). Account permissions
   do not need a Projects entry for this automation.
4. Disable the App webhook (Active off) unless you intentionally subscribe to
   events outside this workflow.
5. Install the App on organization **`soroeru`**, repository access **Only
   select repositories** → **`Soroeru` only**.
6. Register **repository** Actions secrets on `soroeru/Soroeru` (not
   organization-wide secrets unless multiple repos intentionally share the App):
   - `SOROERU_PROJECT_APP_ID` — numeric App ID
   - `SOROERU_PROJECT_APP_PRIVATE_KEY` — full PEM private key, including
     header/footer lines
7. Do not commit the private key, paste it into Issues/PR bodies, or print
   tokens / keys / Issue bodies in Actions logs or artifacts.

The workflow pins `actions/create-github-app-token` by commit SHA and passes
the installation token as `GH_PROJECT_TOKEN` to
`scripts/project-issue-defaults.mjs`. Long-lived `SOROERU_PROJECT_TOKEN` is
not used.

#### Rotate or revoke the App private key

1. In the GitHub App settings, generate a new private key (or remove the
   compromised key).
2. Update `SOROERU_PROJECT_APP_PRIVATE_KEY` on `soroeru/Soroeru` with the new
   PEM only (never commit it).
3. Delete old private keys from the App settings once the new secret is in
   place.
4. To stop automation entirely: uninstall the App from `soroeru`, or remove
   both secrets, or suspend/delete the App.

#### Re-run Project defaults for an existing Issue

Use Actions → **project-issue-defaults** → **Run workflow** and set
`issue_number` to a number in **this** repository (for example `413`). The
script rejects non-positive numbers, missing Issues, pull-request numbers, and
repository mismatches before any Project mutation. Idempotent re-runs reuse the
existing Project item and reconverge fields.

To run the same reconciliation used by the schedule immediately, leave
`issue_number` empty and enable `reconcile_project`. This scans all Project
pages and updates only Issue items with a missing managed field.

```bash
gh workflow run project-issue-defaults.yml --repo soroeru/Soroeru -f issue_number=413
```

#### Troubleshooting

| Symptom                                                                   | Likely cause                                                                                                                                                                                                      |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Token step fails / missing App credentials                                | `SOROERU_PROJECT_APP_ID` or `SOROERU_PROJECT_APP_PRIVATE_KEY` unset or PEM malformed                                                                                                                              |
| Token step `Not Found` on `/repos/.../installation`                       | App is not installed on org `soroeru` with repository `Soroeru` selected (install must be on the org, not only a personal account)                                                                                |
| `{"status":"retryable-error","reason":"project-token-required"}`          | `GH_PROJECT_TOKEN` not passed into the Node step                                                                                                                                                                  |
| `github-graphql-forbidden` after a successful token step                  | Organization **Projects** write missing, App install incomplete, or Projects V2 access denied for the installation                                                                                                |
| `github-graphql-failed` / `github-graphql-not-found`                      | GraphQL rejected the request; confirm `config/github-projects.json` owner / number and App Projects permission. A bad field shape (e.g. `projectsV2(number:)` instead of `projectV2(number:)`) also surfaces here |
| `project-not-found` / empty project                                       | `config/github-projects.json` owner, `ownerType`, or `number` does not match the org Project                                                                                                                      |
| `invalid-issue-number` / `issue-not-found` / `pull-request-not-supported` | Manual `issue_number` input is wrong; no Project mutation ran                                                                                                                                                     |
| `project-fields-unconverged`                                              | Partial write; re-run the workflow for the same Issue number                                                                                                                                                      |

Never expand logging to dump Issue bodies, GraphQL variables with secrets, or
installation tokens when diagnosing failures.

Python-based Skill validation uses `uv` and the repository-managed PyYAML
development dependency:

```bash
uv sync
uv run python "$HOME/.codex/skills/.system/skill-creator/scripts/quick_validate.py" skills/create-issue
uv run python "$HOME/.codex/skills/.system/skill-creator/scripts/quick_validate.py" skills/orchestrate-project-issues
```

Multi-Issue Project orchestration is dry-run first. Feed only the minimal,
sanitized Project item schema to the deterministic planner; individual workers
fetch their own Issue body and comments immediately before implementation:

Copy `config/project-issue-orchestrator.example.yaml` to
`state/project-issue-orchestrator.yaml` and fill in the Project/run values. The
CLI and `orchestrate-project-issues` skill discover that path automatically.
Use `--config path/to/other.yaml` only when intentionally selecting another
configuration file. Explicit CLI flags override YAML values.
The run configuration accepts `unavailableModels` and `unavailableAgents` as
either `none` or a YAML list; these exclusions are runtime hints for that run
and are recomputed from fresh capability records on the next run.

Dependency closure comes from each Issue's GitHub `Blocked by` relationships,
not from Issue body text. A `CLOSED` blocker is treated as completed; an
`OPEN` blocker stops the dry-run with a deterministic dependency reason.

```bash
# Unconditional path: full re-discovery of every adapter (Codex → Claude → Grok → Gemini),
# each gated by a real headless execution probe, not just an auth/model-list check.
# Writes state/project-issue-capabilities.json atomically; do not hand-limit to Codex.
node scripts/project-issue-capabilities.mjs
# Optional: JSON on stdout only
# node scripts/project-issue-capabilities.mjs --stdout

# Normal path: the orchestrator reuses that cache file by default instead of
# re-probing every adapter on every run. --refresh forces a full re-discovery;
# --invalidate-agent drops and re-probes only the agent(s) that just failed at
# dispatch time (see below), leaving the rest of the cache untouched.
GH_PROJECT_TOKEN=... node scripts/project-issue-orchestrator.mjs \
  --dry-run --issues 380,382,384,386,387 \
  --unavailable-model MODEL --unavailable-agent Codex --existing-worktree 396 \
  --parent-agent Codex --parent-model MODEL
# node scripts/project-issue-orchestrator.mjs ... --refresh
# node scripts/project-issue-orchestrator.mjs ... --invalidate-agent Grok
# Optional override for tests / intentional non-default runs:
#   --capabilities-file path/to/verified-capabilities.json
# Optional: apply a milestone in memory only (still no state write) during dry-run:
#   --simulate-milestone --milestone-json '{"issue":396,"type":"merged"}'
node scripts/project-issue-orchestrator.mjs --input path/to/sanitized-plan.json \
  --dry-run --max-parallel 2 --release-policy merged
# Launch a selected external worker with the exact discovered selector:
# node scripts/project-issue-dispatch.mjs \
#   --route-json '{"agent":"Grok","model":"grok-4.5","selector":"…","selectable":true,"verifiable":true,"timeoutMs":30000}' \
#   --issue 413 --release-policy merged --next-milestone pr-created \
#   --role reviewer --execution-mode direct-review --review-pass 1
#   (implementation roles add --skill issue-implementation | handoff-issue;
#    a reviewer never gets one. A fix pass adds --fix-cycle <N>.)
node --test tests/unit/project-issue-orchestrator.test.mjs \
  tests/unit/project-issue-capabilities.test.mjs \
  tests/unit/project-issue-defaults.test.mjs \
  tests/unit/project-issue-graph.test.mjs \
  tests/unit/project-issue-roles.test.mjs
```

Items carry no per-Issue agent/model assignment: the plan orders runnable
Issues by Priority (P0 first) then Issue number under the dependency
constraints, and the result includes `workerRoutes` — the run-scoped pool of
verified worker capability records after `--unavailable-agent` /
`--unavailable-model` exclusions and Parent-agent exclusion. The Parent agent
runtime is excluded by agent identity, including all of its models and
selectors: a Codex Parent means no Codex worker route. The orchestrating agent
assigns each runnable Issue to one of the remaining routes at run time. If the
remaining pool is smaller than `maxParallel`, the run proceeds with the
available capacity; if Issues are runnable but the pool is empty the run stops
with `no-worker-route-available` before any worktree mutation.

Capability discovery lives in `scripts/project-issue-capabilities.mjs` and
`scripts/project-issue-runtime-adapters/` (fixed order Codex → Claude → Grok →
Gemini; Gemini via Antigravity `agy` when present). An adapter that passes
auth/model-list checks is still not enough: every selectable route also runs a
**headless execution probe** for its exact model selector (`runHeadlessExecProbe` in
`project-issue-runtime-adapters/shared.mjs`) — spawn the CLI with no TTY and a
minimal, locally-generated tool-use task ("create this exact file with this
exact marker" in a throwaway sandbox directory), then check the artifact. Only
a route that actually completed that task under `DEFAULT_HEADLESS_PROBE_TIMEOUT_MS`
(120s) becomes verified; the probe never persists the generated prompt, the
marker, or stdout/stderr. Claude candidates are probed independently because
model entitlement, quota, or usage-credit availability can differ within the
same authenticated CLI; one successful Claude model never verifies another.
This is why `claude`, `grok`, and `agy` selectors now
include a permission-bypass flag (`--permission-mode bypassPermissions` /
`--dangerously-skip-permissions`) and, for `grok`, `-p`/`--single` instead of a
bare positional prompt — without them the CLI either stops at an edit-approval
prompt with no human to answer it, or (for `grok`) tries to open an interactive
session that requires a real TTY.

Only verified routes enter the pool; closed diagnostic reasons include
`cli-not-found`, `auth-unavailable`, `model-not-selectable`, `model-mismatch`,
`verification-timeout`, `probe-failed`, and the headless-probe-specific
`tty-required` (the CLI demanded a real terminal), `non-agentic-print-mode`
(exited cleanly but never produced the artifact — observed for `agy --print`
without the skip-permissions flag or with the flags mis-ordered), and
`headless-exec-failed` (any other unexplained failure, including a model-specific
credit or quota rejection). Failed diagnostics contain only the closed reason
and model label, never CLI response bodies. Two launch quirks
found by live verification: `agy`'s `--print` is a Go-style _string_ flag
that consumes the next argv token as the prompt, so it must be the final
selector token with the prompt appended directly after it; and `codex exec`
refuses to run outside a trusted/git directory, so the Codex probe passes
`--skip-git-repo-check` (probe-only — real dispatch runs inside the Issue's
git worktree and needs no such flag). Dispatch of a selected route reuses the same exact
selector through `scripts/project-issue-dispatch.mjs`. Capability files use
`agent` (Codex/Claude/…) rather than API-provider names. A capability may use
`requestedModel` for the exact display label and `model` for the runtime's
canonical model identifier, for example:

```json
{
  "agent": "Grok",
  "requestedModel": "Grok 4.5",
  "model": "grok-4.5",
  "role": "worker",
  "selector": "grok --model grok-4.5",
  "selectable": true,
  "verifiable": true,
  "timeoutMs": 30000
}
```

The permission-bypass flags described above are baked into the **selector
itself**, not just the probe invocation — `project-issue-dispatch.mjs`
launches every real worker/parent for these agents with that exact same
selector, so a dispatched Claude, Grok, or Antigravity worker always runs
with permission prompts fully bypassed, the same way `codex exec` already
does. This is required for unattended dispatch to work at all (there is no
human present to answer an approval prompt), not a change specific to this
repository's risk posture; the review-and-confirm gate, the three guards, and
the never-bypass-walls rule for the Soroeru _product_ these workers implement
are unaffected.

The written capabilities file also carries `cli` (per-agent `{path, version}`
from `--version`) and `probedAt`. `project-issue-orchestrator.mjs` uses those
to decide whether to reuse the file as-is (default), targeted-re-probe only
the agents whose CLI path/version drifted, that `--invalidate-agent` named, or
whose last cached diagnostic was `"failed"` (never trusted as permanent), or
(with `--refresh`) ignore the cache and re-probe every adapter. A dry run
never writes the cache regardless of which of those three paths it took.
`loadOrRefreshCapabilities` in `project-issue-capabilities.mjs` implements
this; `discoverCapabilities` remains the unconditional "probe now" primitive
it wraps.

The LangGraph runner automatically sends the affected agent through this
targeted invalidation path when an actual worker dispatch fails. The graph
fan-in serializes refreshes from parallel dispatch failures, replaces its
checkpointed capability pool with the merged refresh result, and then selects
handoff routes. The failed model is excluded immediately for the current run,
while the cache is also rewritten so a later run cannot reuse the pre-failure
record. Sibling models remain available only when that probe verifies them
again. If invalidation itself fails, orchestration fails closed instead of
continuing with a cache it could not make safe.

The requested label must still be explicitly present in the capability record;
the canonical runtime identifier alone is not an alias or fallback. The legacy
shape with only `model` remains supported when it already contains the exact
requested model label.
The `project-metadata` body marker carries only Priority / Size / Feature
group via `scripts/project-issue-assignment.mjs`; legacy AI Assignee lines and
the `implementation-assignment` block are ignored. The planner, GitHub fetch,
and local state lock live in `project-issue-plan.mjs`,
`project-issue-github.mjs`, and `project-issue-state.mjs`; the CLI entrypoint
is `project-issue-orchestrator.mjs`.

#### LangGraph StateGraph runner (Issue #439)

`scripts/project-issue-graph.mjs` models the same orchestration as an explicit
LangGraph `StateGraph` (config → capability discovery → Project fetch →
dependency validation → plan → route assignment → `Send` fan-out dispatch →
event wait → integration gate → dependent release → summary), with
checkpointing and `thread_id`-based resume. It calls the same planning,
capability, milestone, and dispatch functions as the classic CLI — runtime
adapters, worktree lifecycle, and CLI process launch stay outside the graph.
The classic `project-issue-orchestrator.mjs` CLI is unchanged and remains the
dry-run/compatibility path.

Judgment stays with the orchestrating agent: the run pauses (`interrupt`) for
dynamic route assignment (unless `--auto-assign` picks deterministically from
the verified pool), for every integration-gate verdict, and while waiting for
worker events. Resume payloads are validated against deterministic state — an
assignment or handoff proposal can only reference a verified worker route
belonging to an agent other than the Parent, and an exhausted pool fails the
run closed before any worktree mutation.

```bash
# Start a run: pauses at the first interrupt and prints the interrupt payload,
# pending dispatch instructions, and a summary snapshot.
node scripts/project-issue-graph.mjs --thread-id run-2026-07-22 \
  --issues 380,382 --max-parallel 2 --release-policy merged \
  --parent-agent Codex --parent-model gpt-5 --auto-assign
# Add --single-worker to disable role programs (one worker owns the Issue).
# Resume the same thread with a worker event or a gate verdict:
# node scripts/project-issue-graph.mjs --thread-id run-2026-07-22 \
#   --resume-json '{"type":"role-complete","issue":380,"role":"implementer"}'
# node scripts/project-issue-graph.mjs --thread-id run-2026-07-22 \
#   --resume-json '{"type":"role-complete","issue":380,"role":"reviewer","verdict":"PASS"}'
# node scripts/project-issue-graph.mjs --thread-id run-2026-07-22 \
#   --resume-json '{"accepted":true}'
# Other events: {"type":"worker-started","issue":380,"pid":1234}
#               {"type":"worker-interrupted","issue":380,"reason":"timeout",
#                "proposedRoute":{"agent":"Claude","model":"sonnet"}}
#               {"type":"milestone","issue":380,"milestone":"merged"}
#               {"type":"check"}   # lost-notification fallback: probe workers
node --test tests/unit/project-issue-graph.test.mjs \
  tests/unit/project-issue-roles.test.mjs
```

Each runnable Issue gets a deterministic execution mode and role program
(`scripts/project-issue-roles.mjs`): `direct-review` runs `implementer` →
`reviewer` for low-risk small work, and `plan-implement-review` runs `planner` →
`implementer` → `reviewer` for anything above low risk or larger. Every role is
a separate CLI process on its own verified route — `implementer` and `reviewer`
differ whenever more than one route is verified — so a reviewer cannot see the
implementer's reasoning. The reviewer is dispatched without `--skill` and works
read-only in the existing worktree. The reviewer posts its findings as one pull
request comment headed `role=reviewer pass=<N> verdict=<…>` (`gh pr comment`);
only the verdict enters graph state. Review is bounded at two passes:
`NEEDS_REVISION` buys one implementer fix cycle, `REJECTED` blocks, and an
integration-gate rejection reopens the program under the same budget. A
fix-cycle implementer is dispatched with `--fix-cycle <N>`, reads the findings
with `gh pr view --comments`, pushes to the existing branch instead of opening a
second PR, and records what it changed in a `role=implementer fix-cycle=<N>`
comment. With a
role program active, `pr-created` is reached by finishing the program (the
reviewer's `PASS` opens the gate); reporting that milestone early is rejected
with `role-program-active`. Under `--release-policy merged` the run keeps
waiting for the external `merged` milestone after the program ends.

Checkpoints are stored per thread under `state/project-issue-graph/` by a
file-backed saver (`project-issue-graph-checkpointer.mjs`) so a run survives a
process restart; resume re-verifies recorded worker processes via a
PID-reuse-safe probe (`{"type":"check"}`), never by PID alone. Graph state and
checkpoints carry only non-sensitive orchestration data (Issue
numbers/titles/URLs, routing labels, milestones, timestamps, exact usage) —
never Issue bodies, prompts, diffs, or credentials. A worker interruption
keeps the Issue worktree untouched and hands off on a remaining verified route
from another agent in `handoff-issue` mode; the Parent agent is never a handoff
target. Dependents are released only after the integration gate accepts the
release-policy milestone.

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
dependencies, and—until the #391 retirement stage—a hermetic Playwright Chromium browser so
beta users do not need a system Node.js install.

```bash
nvm use            # Node 22 LTS (see .nvmrc); required for the DMG native deps
npm ci
npm run package:dmg
```

> **Node version matters for DMG packaging.** The maker chain
> (`@electron-forge/maker-dmg` → `electron-installer-dmg` → `appdmg`) pulls in
> `nan`-based native modules (`macos-alias`, `fs-xattr`) that do **not** compile
> against Node 23+ V8 headers. Because `appdmg` is an _optional_ dependency, a
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

## 3.2 Chrome Extension Front-Door Migration Setup

The Chrome extension bridge is the **selected production direction** (Issue #391), currently
still exercised through the developer setup from Issue #340. It enables automation via the
user's actual Chrome profile instead of sandboxed Playwright Chromium. This setup is for
development/parity evidence only; unpacked loading and environment-variable tab selection are
not the supported product installation or binding UX. To use it during local development:

1. **Build the extension and the native-messaging host bundle:**

   ```bash
   npm run build:extension
   npm run build:host
   ```

   `build:extension` bundles the extension to `dist/extension/`. `build:host` bundles the
   native-messaging host relay into one self-contained file,
   `dist/native-host/host.cjs` — required because setup copies a **single file** into
   app-support and Chrome launches it from there (the per-module compiled output under
   `dist/compiled/native-host/` cannot run standalone).

2. **Load the extension in developer mode:**
   - Open Chrome and navigate to `chrome://extensions/`.
   - Enable **Developer mode** (toggle in the top right).
   - Click **Load unpacked** and select the `dist/extension/` directory.
   - Note the extension ID shown on the extension card (you will need it below).
   - An unpacked extension's ID is derived from the **absolute directory path**: loading
     `dist/extension/` from a different checkout or worktree produces a **different ID**.
     After such a change, re-enter the new ID in settings and re-run step 4 (**host を登録して接続を始める**)
     to update the native host manifest's `allowed_origins` with the latest stored ID (re-registration uses the latest stored ID without requiring an app restart).

3. **Start the app and save the bridge settings:**

   ```bash
   npm run dev
   ```

   `npm run dev` also builds the host bundle and the dev app resolves it from
   `dist/native-host/host.cjs` automatically, mirroring the packaged app;
   `SOROERU_CHROME_BRIDGE_HOST_BINARY` remains an explicit override.

   Open **設定 → Chrome と接続**, enter the extension ID from step 2, select
   **Chrome 拡張ブリッジを有効にする**, and save. Restart Soroeru when the settings panel
   asks you to; listener enablement and the extension ID are applied at process startup. The
   non-sensitive setting is stored locally under Electron's Soroeru `userData` directory and is
   available before vault unlock. It defaults to OFF.

   `SOROERU_ENABLE_CHROME_BRIDGE` and `SOROERU_CHROME_EXTENSION_ID` remain developer overrides.
   When present they take precedence over the saved value and the settings panel identifies the
   overridden field. Both are strict and fail closed: enablement accepts only `0` or `1`, and the
   extension ID must be 32 lowercase characters in Chrome's `a`–`p` alphabet. For example:

   ```bash
   SOROERU_ENABLE_CHROME_BRIDGE=1 SOROERU_CHROME_EXTENSION_ID=<extension-id-from-step-2> \
   npm run dev
   ```

   In a **packaged app** (`npm run package:dmg`), the host bundle ships inside the DMG at
   `Soroeru.app/Contents/Resources/native-host/host.cjs` and is used automatically;
   `SOROERU_CHROME_BRIDGE_HOST_BINARY` remains an override. The bridge stays off by default until
   the reachability, #381 invariant, binding, permission, packaging, and distribution gates in
   `architecture.md` §2.2 pass.

4. **In the app (order matters — register first, then reload the extension):**
   - Go to **設定 → Chrome と接続** and select **host を登録して接続を始める**.
   - The manifest is registered at
     `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/jp.soroeru.bridge.json`,
     pointing at the copy in `~/Library/Application Support/Soroeru/native-host/` (never
     into `.app`, which App Translocation can relocate). Registration is what writes the
     saved extension ID into the manifest's `allowed_origins`; reloading the extension
     before this step reconnects against the stale manifest and fails.
   - Then reload the extension (or restart its service worker) in `chrome://extensions`
     so it reconnects to the freshly registered host.
   - The handshake completes when the extension confirms the native-messaging connection.
   - When done, choose **切断して登録物を掃除** to unregister and remove the host binary.
   - Turning the bridge setting OFF runs the same cleanup first. OFF is saved only after listener,
     permission, and native-host cleanup completes; failed or uncertain cleanup remains visible and
     leaves the saved setting ON. Restart to make OFF the next startup state.

**Troubleshooting the connection:**

- Extension console shows `Unchecked runtime.lastError: Access to the specified native
messaging host is forbidden.` — the extension's current ID is not in the registered
  manifest's `allowed_origins` (stale registration, typically after the extension was
  loaded from a new path or the ID in settings changed). Verify the saved ID matches the
  card in `chrome://extensions`, re-run **host を登録して接続を始める**, then reload the
  extension. Compare against
  `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/jp.soroeru.bridge.json`.
- App stays at 「接続中」 with no error — the extension has not (re)connected yet; reload
  it in `chrome://extensions`, or use the extension popup's **アプリに再接続**. The
  popup's reconnect cannot fix a stale manifest; only app-side registration rewrites it.
- Connecting reports `feature-disabled` — the bridge listener or extension ID was not
  active at process startup (settings apply on restart), or the dev host bundle
  `dist/native-host/host.cjs` is missing (`npm run dev` builds it; `npm run build:host`
  builds it standalone).
- A successful registration writes `registering native host` /
  `native host registered successfully` lines to the app log (**ログをダウンロード** in
  the app, or `~/Library/Application Support/Soroeru/logs/soroeru.log`). If those lines
  are absent, registration never ran in the current app instance.

**Runtime caveat:** Chrome launches the installed host with launchd's minimal `PATH`, so
an `env node` shebang would fail silently on most machines. Registration therefore
rewrites the installed copy's shebang to an **absolute Node path** (resolved from the
app's `PATH`, then `/usr/local/bin`, `/opt/homebrew/bin`, `/usr/bin`) and **fails with a
clear error** when no Node runtime is found. If you later move or upgrade your Node
install, re-run the connection setup so the shebang is re-resolved. A system Node is
required only for the current migration-stage helper; the product helper must be
self-contained before cutover.

**Security note:** The unpacked extension ID is not stable across machines, so never commit
a hardcoded development ID. Product cutover requires Chrome Web Store distribution, a stable
allowlisted ID, and signed/notarized app/helper distribution beyond invited beta. The DMG
bundles only the inert relay file; nothing is registered with Chrome until the user starts
setup from settings.

**Node transition:** keep Node 22 as the repository and DMG baseline while the current
`appdmg` native dependency chain and bundled Playwright Chromium remain. Node 24 LTS is the
candidate for extension/native-helper validation, but adopt it repository-wide only after the
helper is self-contained, production Playwright packaging is retired, a Node-24-compatible DMG
maker is selected, and host/typecheck/unit/native-handshake/DMG checks pass. Node 26 is not
selected while it is Current rather than LTS.

See [`manual-test.md`](manual-test.md) §0.1–0.2 for the full QA checklist, including
permission verification, tab binding, cleanup, and policy compliance (`npm run poc -- check-egress` etc.).

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
  _how_ to write them — behavior over implementation, "not too many, mostly integration",
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
Linux, mobile apps, hosted vaults, telemetry, or additional-browser extension distribution.

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
  reviewer routing changes
- `bash scripts/smoke-local-ai-review-issue-epoch.sh` for Issue epoch and
  review-budget changes
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

1. Inspect lifecycle state. Existing work uses `handoff-issue`; new work uses
   `scripts/issue-worktree.sh create` through `issue-implementation`.
2. Move every operation to the helper's absolute Issue worktree path.
3. Implement the Issue there; the primary clone remains human-only.
4. After committing, check the commit command's own output for
   `[local-ai-review] queued ...`. If present, wait for that result by
   running `scripts/wait-for-local-ai-review.sh` (see
   [`local-ai-review.md`](local-ai-review.md) §10 for the script, and §6/§7 for
   the review-count cap and follow-up policy) rather than polling
   `state/ai-reviews/` turn-by-turn. This workflow allows up to two local AI
   review runs per handoff epoch: apply a fix pass for the first review's actionable
   findings and commit it _without_ `LOCAL_AI_REVIEW_RUNNING=1` (a confirming
   second review runs on that fix commit); if that second review still has
   actionable findings, apply one more fix pass and commit it _with_
   `LOCAL_AI_REVIEW_RUNNING=1` so a third review never starts.
5. Push the finished local branch to GitHub and create a PR. Include
   `Closes #<issue>` in the PR body so GitHub closes the Issue automatically
   when the PR is merged. Also include the local AI review status for each
   run, actionable findings, and what was fixed. If review did not run or
   residual risk remains once the two-review cap is reached, state that
   clearly.

The workflow intentionally avoids an open-ended review loop, capped at two
review runs per handoff epoch. A successful new-session handoff (including the
same agent after a session limit) starts a fresh `0/2` epoch; same-session
re-entry is idempotent. If the user gives multiple Issue numbers, ask which
single Issue to implement first.

## 11. Operational Notes

- `state/` is local state and must not be committed.
- `state/ai-reviews/` contains local AI review artifacts.
- `out/` and `release/` contain generated `.app` / DMG artifacts and must not be committed.
- `node_modules/`, build outputs, coverage, and common caches are ignored by
  Git.
- Keep durable workflow lessons near the owning document, Issue, or PR instead
  of reintroducing a generic learning log without a clear owner.

### Jev triage provider terms and activation

Issue #535 adds the isolated adapter and contracts; #536 connects them to the graph.
No Jev request is made by the existing orchestration CLI in this stage. The configuration
loader accepts the following optional section, and the plan CLI accepts `--triage off|shadow|assisted`. CLI mode overrides YAML while preserving
the pinned model and budget. Defaults are off, `jev-1.13.0`, and 20 attempts.

```yaml
run:
  triage:
    mode: off
    model: jev-1.13.0
    maxRequests: 20
```

For adapter callers, create one `createTriageRunner` per run with a durable `persistState`
callback and reload its `{runId, reserved, providerUnavailable}` snapshot when resuming.
The callback must finish saving before it resolves; save failure prevents the request.
Reserve-before-send deliberately charges an attempt slot even when the child rejects
input or the process is interrupted. Never recreate an empty counter under an existing
run ID. The graph will own this persistence in #536. `assisted` currently returns
`input-not-approved`; it cannot adopt decisions yet. `off` neither starts a child nor
uses a slot. `TYPESAFE_API_KEY` belongs in the process environment, never YAML, argv,
Issue content, checkpoint, telemetry, or worker environments.

Only reviewed public development Issues may be sent. Use fake data in examples; the
preflight detector is incomplete and cannot certify the absence of personal information.
Private repositories, changed revisions, obvious sensitive text, empty context, and large
inputs return a fixed fallback reason without a provider call. Errors contain no raw
provider body. A missing key falls back locally; 401/403 and 429/529 disable the provider
for the run. Other errors consume their reserved slot with no retry. Usage is the API's
validated integer count or `unavailable`; cost is not fabricated from missing data.

**Terms reviewed 2026-09-27; no account settings changed or live paid requests made.**
The [API reference](https://docs.typesafe.ai/api) specifies Bearer-authenticated structured
questions and answers. We pin the resolved model, enforce the response contract, and use
the fixed HTTPS endpoint with redirects disabled. This does not establish model quality;
Japanese fixtures and routing evidence are evaluated separately in #537.

The [Master Customer Agreement](https://typesafe.ai/legal/mca) dated 2026-09-23 permits API
use subject to its documentation and limits. It requires customer authority over input;
model training requires prior consent. It also permits continued use of input for deriving
telemetry, fraud prevention, and legal compliance, and allows retention in standard backups.
The [Privacy Policy](https://typesafe.ai/legal/privacy-policy) says input is not used for
training and describes purpose-based retention rather than a fixed deletion period.
The [DPA](https://typesafe.ai/legal/data-processing) likewise gives no general zero-day
retention promise. [Zero data retention is an enterprise arrangement](https://docs.typesafe.ai/legal),
not a guarantee inferred from possessing an API key. Before enabling shadow mode, the
operator must check the terms and retention arrangement that apply to their own account,
and decide whether the reviewed public Issue text is suitable for that processing.
No code accepts terms, purchases credits, or changes billing settings for the operator.
