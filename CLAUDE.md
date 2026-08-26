# CLAUDE.md

@AGENTS.md

## Claude Code-specific guidance

- Treat the imported `AGENTS.md` as the shared source of truth. Do not mirror its content here.
- Use the path-scoped rules in `.claude/rules/`; they load only when their file areas apply.
- Do not assume Codex automation runs. Run applicable checks explicitly and verify hooks used in
  the current session.
- Prefer dedicated file tools over shell-based file rewriting. Parallelize only independent work.
- Confirm destructive or hard-to-reverse actions such as force pushes, branch deletion,
  dependency removal, large rewrites, and CI changes.

## Orchestration

Use `orchestrate-project-issues` only when coordinating multiple Project Issues. Dispatch
reasoning-heavy bounded work to `deep-reasoner` and mechanical, fully specified work to
`fast-worker`; their definitions constrain their tools. Local AI review and Issue lifecycle
skills remain authoritative regardless of the orchestrating model.

Worker prompts must state four labeled parts:

1. **Goal** — one concrete outcome.
2. **Context** — only the source locations and facts needed for that role.
3. **Constraints** — safety, scope, route, and state-handling boundaries.
4. **Done when** — observable completion conditions and the expected concise return event.

Do not pass credentials, Issue bodies, prompts, diffs, or model response bodies through
orchestrator state. Follow the tighter worker contract in the orchestration skill.

## Session conventions

- Act when the evidence is sufficient; do not reopen settled product decisions.
- Do only the requested work. Pause only for destructive action, a material scope change, or
  information only the user can provide.
- Ground progress and verification claims in tool output.
- For background local review, run `scripts/wait-for-local-ai-review.sh` once in the background
  and use one bounded fallback wakeup; do not repeatedly poll review files or process output.
- Keep final reports concise: outcome, changed files, checks, omissions, and residual risk.
