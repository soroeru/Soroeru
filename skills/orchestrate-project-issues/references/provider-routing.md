# Agent / model routing

Treat agent and model availability as runtime capability, not repository truth.

1. Enumerate the current runtime's callable agent, CLI, and model selectors without starting implementation. Create a capability record `{agent, requestedModel, selector, selectable, verifiable, timeoutMs}` for every parent and worker route. The `agent` field is the Issue primary (Codex / Claude / Gemini / Grok), not an API vendor name.
2. Match the Issue's `primary` (as `agent`) and `model` exactly. Record the selector actually requested and, when exposed, the selected model returned by the runtime. Fable parent and worker routes use the same record and are runnable only when both `selectable` and `verifiable` are true.
3. If the runtime cannot select or verify the requested model, return `routing-unavailable`; do not use a nearby model name.
4. Apply `unavailableModels` only to the current run. Re-run capability detection next time.
5. Require a positive `timeoutMs` in every external CLI capability record. On timeout, emit a failure milestone, terminate only that CLI process, and preserve the Issue worktree for the configured AI Sub Assignee's `handoff-issue` run.

Runtime interfaces differ. Do not hard-code a claim that Claude Fable, Codex, Grok, Gemini, or Antigravity is permanently available or unavailable.
