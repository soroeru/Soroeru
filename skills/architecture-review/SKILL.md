---
name: architecture-review
description: Use when docs/architecture.md (or another architecture / technology-selection document) is created or changed, or when asked to review an architecture decision. Not for requirements, per-Issue design docs, or code diffs.
user-invocable: true
---

# Architecture Review

Review `docs/architecture.md` (or a diff to it) against the five criteria
below. The criteria mirror `docs/development.md` §9.4 (Architecture Review);
if either changes, update the other in the same commit.

Judge everything against **Soroeru's actual context**: a single-user,
local-first, OSS Electron desktop app with an encrypted local vault. Do not
import server-scale expectations (horizontal scaling, HA clusters, fleet
observability). Where a classic concern genuinely does not apply, say
"not applicable" explicitly under Criterion coverage rather than inventing a
finding. The non-negotiables in `docs/requirements.md` §8 are fixed inputs —
review whether the architecture *satisfies* them, never whether they are
right.

## Review criteria (priority order)

1. **Requirements and constraint fit** — every architectural choice satisfies
   the non-negotiables (local-first encrypted vault, no telemetry / hosted
   backend, restricted egress, never-bypass walls, AI-optional deterministic
   default) and the quality attributes the requirements actually prioritize.
   Make trade-off points explicit: which quality was sacrificed for which,
   and is that consistent with the requirements' priorities?
2. **System boundaries and data flow** — process / trust boundaries are
   drawn (main vs renderer vs automation browser vs external sites / AI
   provider), and it is decidable where personal data may exist in what form
   (encrypted / in-memory / in a form field) and what every egress point is.
   Flag any component whose access to decrypted data is broader than its job.
3. **Dependencies** — each significant dependency is justified against
   alternatives, maintained, license-compatible with OSS distribution, and
   its security surface is understood; the stack stays within the doc's own
   decisions (no undocumented framework / tool / service).
4. **Failure modes and data integrity** — crash, forced quit, disk-full, and
   interrupted-write behavior for the vault (the user's single source of
   truth) is designed: atomic writes, versioned schema with a migration
   story, and detectable-not-silent corruption. Includes local
   diagnosability: how a user or agent investigates a failure without
   telemetry.
5. **Decision records** — each significant decision is captured so it can be
   revisited: context, considered alternatives, rationale, and what would
   trigger reconsideration (ADR-style, whether or not in ADR files).

Every criterion is judged: detailed findings go in the findings list (a few
strong ones over many shallow ones), and the closing `## Criterion coverage`
section states, for all five criteria, which findings violate it, or that it
is satisfied, or that it is not applicable and why.

## Output format

Follow the local AI review conventions
(`.githooks/prompts/local-review-claude.md`):

```
verdict: PASS | NEEDS_CHANGES | NIT_ONLY

## Findings

1. [<severity>] docs/architecture.md:<line> — <one-sentence problem statement>
   <2-4 sentences of explanation, including a concrete suggested fix>

## Criterion coverage

- **Requirements and constraint fit** — <"violated: findings N, M" / "satisfied" / "not applicable: reason">
- ... (all five criteria)
```

Severity (this list is controlling for architecture review): `blocker`
(violates a non-negotiable or risks the user's data) · `major` (a real risk
or unrecorded load-bearing decision likely to force rework) · `minor`
(clarity, small gaps) · `nit` (wording, optional). Verdict mapping: any
`blocker`/`major` → `NEEDS_CHANGES`; only `minor`/`nit` → `NIT_ONLY`; no
findings → `verdict: PASS` with a one-line reason. Cite doc line numbers (or
post-image diff lines when reviewing a diff). Do not review embedded sample
code as shipped code, per `.githooks/prompts/local-review-claude.md`,
"Reviewing documentation diffs".

## Common mistakes

- Applying server-side defaults: demanding scalability, uptime targets, or
  cloud cost analysis from a single-user desktop app. Their local analogues
  (UI responsiveness during automation, vault durability, disk/memory
  footprint) belong under criteria 1 and 4 when the requirements make them
  matter.
- Re-litigating the non-negotiables (e.g. proposing a hosted service for
  convenience) — they are inputs, not review targets.
- Treating "not applicable" as a failure — an explicit, reasoned
  non-applicability is a passing answer.
- Flagging a missing formal ADR directory when the decision, alternatives,
  and rationale are recorded in the doc itself — criterion 5 is about the
  content, not the file format.
