# Agent / model routing

Treat agent and model availability as runtime capability, not repository truth. No Issue or
Project field names an agent or model; the automatic capability discovery path below is the only
source of routes for a normal orchestration run, and the orchestrating agent assigns Issues to
routes at run time.

## Automatic discovery (normal path)

1. Run `node scripts/project-issue-capabilities.mjs` (or let `project-issue-orchestrator.mjs` invoke
   discovery when no `--capabilities-file` / input capabilities are supplied). Adapters are evaluated
   in fixed order: **Codex → Claude → Grok → Gemini**.
2. Gemini is probed through the Antigravity CLI (`agy`) when present; a bare `gemini` binary is
   accepted if it is on `PATH`, but never invented.
3. Each adapter performs CLI existence, auth/availability, exact model selection, and canonical
   model verification under a fixed probe timeout. Only successful probes emit capability records of
   shape `{agent, requestedModel, model, role, selector, selectable, verifiable, timeoutMs}`.
4. Failures use closed reason codes only: `cli-not-found`, `auth-unavailable`,
   `model-not-selectable`, `model-mismatch`, `verification-timeout`, `probe-failed`. Diagnostics and
   run state must never store credentials, prompts, Issue bodies, diffs, or model response bodies.
5. Capability JSON is written atomically (`state/project-issue-capabilities.json` by default). A
   partial or previous file is never treated as a successful new discovery result.
6. One or more verified worker routes is enough to continue; failed adapters are omitted. Zero
   verified worker routes with runnable Issues fails closed as `no-worker-route-available` before any
   worktree mutation.

`--capabilities-file` remains for tests and intentional non-default runs. Do not hand-author a
Codex-only file for ordinary orchestration; discovery is the source of truth.

## Route rules

1. A route is usable only when both `selectable` and `verifiable` are true. `requestedModel` is the
   exact display label when one exists; `model` is the canonical identifier returned or accepted by
   the runtime. A canonical `model` without an exact `requestedModel` match is not an alias.
2. If the runtime cannot select or prove a requested model machine-readably, that route is
   unavailable (`verifiable: false` / omitted). Do not use a nearby model name and never relabel
   another model.
3. Apply `--unavailable-agent` and `--unavailable-model` only to the current run. They remove routes
   from the run's worker pool; they never trigger substitution. Re-run discovery next time.
4. Require a positive `timeoutMs` in every external CLI capability record. On timeout, emit a failure
   milestone, terminate only that CLI process (via `project-issue-dispatch.mjs` / the matching
   adapter), and preserve the Issue worktree; pick a handoff recipient from the remaining routes for
   `handoff-issue`.

## Dispatch

When dynamic assignment selects a non-Codex route, launch it through the same adapter that produced
the capability record, reusing the exact `selector` and `model`. Use
`node scripts/project-issue-dispatch.mjs --route-json '…' --issue N --release-policy … --next-milestone …`
or the `dispatchWorker` export. The worker receives only Issue number, agent/model route, release
policy, and next milestone.

Runtime interfaces differ. Do not hard-code a claim that Claude, Codex, Grok, Gemini, or Antigravity
is permanently available or unavailable.
