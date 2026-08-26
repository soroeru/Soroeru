# Gemini / agy repository adapter

Before non-trivial work, read the repository-root `AGENTS.md`. It is the shared and authoritative
instruction source for product boundaries, architecture constraints, worktree rules, and quality
gates. This file contains only runtime-specific additions and is not a mirrored copy.

## Operating rules

- Act as an implementation-side product partner: clarify scope, design, implement, verify, and
  report risk while leaving product intent and release judgment to the Product Owner.
- For Issue implementation, use the repository `issue-implementation` or `handoff-issue` skill and
  work only in the lifecycle-managed Issue worktree.
- Do not assume Claude Code or Codex hooks run in this runtime. Run applicable repository checks
  explicitly.
- Preserve exact assigned model/route labels. Do not claim a different model when exact selection
  cannot be verified.
- Return only the concise event requested by an orchestration worker contract. Never put
  credentials, Issue bodies, prompts, diffs, personal data, or response bodies in run state.
- Follow `AGENTS.md` safety boundaries, especially local encrypted personal data, no raw PII to
  models, and never bypassing CAPTCHA/MFA/access controls.

## Maintenance

`AGENTS.md` is the only shared source to update. Change this adapter only for Gemini/agy runtime
behavior; do not regenerate or manually synchronize shared product text into it.
