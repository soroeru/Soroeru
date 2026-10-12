---
name: architecture-review
description: Use when docs/architecture.md (or another architecture / technology-selection document) is created or changed, or when asked to review an architecture decision. Not for requirements, per-Issue design docs, or code diffs.
user-invocable: true
---

# Architecture Review

Review `docs/architecture.md` (or its diff) against the five criteria below.
This skill owns the criteria; development links here without duplicating them.

Judge Soroeru's Chrome MV3 Side Panel client, encrypted local vault and Google
Cloud form assistance against UX-first requirements. Distinguish implemented
behavior from target design. Explicitly scoped Product Owner policy changes are
review inputs, not automatically forbidden weakening of historical constraints.

When the document names repository files, APIs, or implemented behavior,
verify those claims against the current code before judging — a confirmed
gap outranks a speculative one — and cite the code where it changes a
finding.

## Review criteria (priority order)

1. **Requirements and constraint fit** — every architectural choice satisfies
   the current product/data-handling boundaries and the quality attributes the requirements actually prioritize.
   Make trade-off points explicit: which quality was sacrificed for which,
   and is that consistent with the requirements' priorities?
2. **System boundaries and data flow** — process / trust boundaries are
   drawn (Side Panel vs worker vs content script vs sites vs Cloud/Vertex), and it is decidable where personal data may exist in what form
   (encrypted / in-memory / in a form field) and what every egress point is.
   Flag any component whose access to decrypted data is broader than its job.
3. **Dependencies** — each significant dependency is justified against
   alternatives, maintained, license-compatible with OSS distribution, and
   its security surface is understood; the stack stays within the doc's own
   decisions (no undocumented framework / tool / service).
4. **Failure modes and data integrity** — crash, forced quit, disk-full, and
   interrupted-write behavior for the vault (the user's single source of
   truth) is designed: atomic writes, versioned schema with a migration
   story, and detectable-not-silent corruption. Includes local diagnosability and bounded, value-free Cloud outcomes.
5. **Decision records** — each significant decision is captured so it can be
   revisited: context, rationale and reconsideration triggers. Keep concise durable
   decisions in architecture and implementation detail in the Issue/PR.

Every criterion is judged: detailed findings go in the findings list (a few
strong ones over many shallow ones), and the closing `## Criterion coverage`
section states, for all five criteria, which findings violate it, or that it
is satisfied (optionally "satisfied except finding N (minor)" when only
minor/nit findings touch it), or that it is not applicable and why.

## Output format

Record the review in the Issue/PR using this format:

```
verdict: PASS | NEEDS_CHANGES | NIT_ONLY

## Findings

1. [<severity>] docs/architecture.md:<line> — <one-sentence problem statement>
   <2-4 sentences of explanation, including a concrete suggested fix>

## Criterion coverage

- **Requirements and constraint fit** — <"violated: findings N, M" / "satisfied" / "satisfied except finding N (minor)" / "not applicable: reason">
- ... (all five criteria)
```

Severity (this list is controlling for architecture review): `blocker`
(the document's chosen design violates a non-negotiable or would lose or
expose the user's data) · `major` (a real risk left undesigned, or an
unrecorded load-bearing decision, likely to force rework — an *omission* is
at most `major`; `blocker` is reserved for what the document affirmatively
chooses) · `minor` (clarity, small gaps) · `nit` (wording, optional). Verdict mapping: any
`blocker`/`major` → `NEEDS_CHANGES`; only `minor`/`nit` → `NIT_ONLY`; no
findings → `verdict: PASS` with a one-line reason. Cite doc line numbers (or
post-image diff lines when reviewing a diff). Do not review embedded sample code as shipped code.

## Common mistakes

- Treating the remaining Electron source as the target architecture.
- Claiming a future consent, telemetry or migration path already ships.
- Requiring a separate ADR/design directory instead of a concise decision in its owner.
- Re-litigating an explicitly authorized UX policy change instead of reviewing its risks.
