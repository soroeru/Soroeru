# Agent / model routing

Treat agent and model availability as runtime capability, not repository truth. No Issue or
Project field names an agent or model; the capability enumeration below is the only source of
routes, and the orchestrating agent assigns Issues to routes at run time.

1. Enumerate the current runtime's callable agent, CLI, and model selectors without starting implementation. Create a capability record `{agent, requestedModel, model, role, selector, selectable, verifiable, timeoutMs}` for the parent route and for every worker route. The `agent` field is the runtime name (Codex / Claude / Gemini / Grok), not an API vendor name. `requestedModel` is the exact display label when one exists; `model` is the canonical identifier returned or accepted by the runtime.
2. A route is usable only when both `selectable` and `verifiable` are true. Record the selector actually requested and, when exposed, the selected model in `model`. A canonical `model` identifier without an exact `requestedModel` match is not an alias. Fable parent and worker routes use the same record shape.
3. If the runtime cannot select or verify a requested model, that route is unavailable; do not use a nearby model name and never relabel another model.
4. Apply `--unavailable-agent` and `--unavailable-model` only to the current run. They remove routes from the run's worker pool (for example the agent that just hit a session limit); they never trigger substitution. Re-run capability detection next time.
5. Require a positive `timeoutMs` in every external CLI capability record. On timeout, emit a failure milestone, terminate only that CLI process, and preserve the Issue worktree; the orchestrating agent then picks a handoff recipient from the remaining routes for the `handoff-issue` run.

Runtime interfaces differ. Do not hard-code a claim that Claude Fable, Codex, Grok, Gemini, or Antigravity is permanently available or unavailable.
