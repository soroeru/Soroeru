---
name: design-doc-review
description: Use when a detailed design doc under docs/design/ is created or changed — after Plan mode produces one, before implementing from one, or when asked to review a design doc. Not for requirements or code diffs.
user-invocable: true
---

# Design Doc Review

Review a `docs/design/*.md` detailed design document (an implementation-session
design doc per `docs/github-operations.md` §3) against the five criteria below.
The criteria mirror `docs/development.md` §9.3 (Design Doc Review); if either
changes, update the other in the same commit.

## Scope

- **Review target: one design doc** — the whole doc when newly created, the
  diff when an existing doc changed.
- Design substance expressed in code blocks (interface signatures, state
  machines, failure paths) **is** design — judge it under the criteria below.
  What is out of scope is implementation-level bugs inside pseudocode
  (off-by-one, missing null check, algorithmic correctness), per
  `.githooks/prompts/local-review-claude.md`, "Reviewing documentation
  diffs"; flag embedded code only when it contradicts the prose, references
  a nonexistent or renamed API / file, or would mislead the implementer.
- Gather traceability inputs before judging: the Issue named in the doc
  header (`gh issue view <n> --comments`), the requirements sections the doc
  cites, and — when the doc names existing files or APIs — the current code,
  to catch drift against what is already implemented.

## Review criteria (priority order)

1. **Traceability** — every design element maps back to a requirement, Issue
   goal, or acceptance criterion, and every in-scope requirement is covered.
   Flag orphan design elements (scope creep) and uncovered requirements.
2. **Contracts and responsibilities** — component responsibilities, API /
   interface / IPC contracts, and the data model are explicit enough to
   implement against without guessing. Flag interfaces named but not typed,
   and responsibilities split across components with no stated owner.
3. **Failure handling and state transitions** — error paths, walls
   (CAPTCHA / MFA hand-off), interruption / cancellation / resume, and state
   transitions are designed, not just the happy path. Flag states with no
   exit, and operations whose failure leaves data inconsistent.
4. **Alternatives considered** — rejected options are recorded with the
   rationale for the chosen approach. Flag load-bearing decisions (new
   dependency, schema shape, process boundary) presented with no alternative.
5. **Test strategy** — the doc says how its behavior will be verified (which
   layers, which cases, what is manual-only). Flag designs whose acceptance
   criteria have no corresponding test approach.

Every criterion is judged: detailed findings go in the findings list (a few
strong ones over many shallow ones), and the closing `## Criterion coverage`
section states, for all five criteria, either which findings violate it or
that it is satisfied.

## Output format

Follow the local AI review conventions
(`.githooks/prompts/local-review-claude.md`):

```
verdict: PASS | NEEDS_CHANGES | NIT_ONLY

## Findings

1. [<severity>] docs/design/<file>.md:<line> — <one-sentence problem statement>
   <2-4 sentences of explanation, including a concrete suggested fix>

## Criterion coverage

- **Traceability** — <"violated: findings N, M" or "satisfied">
- ... (all five criteria)
```

Severity (this list is controlling for design doc review): `blocker`
(design contradicts a non-negotiable requirement or cannot satisfy an
acceptance criterion) · `major` (an implementer following the doc would
build the wrong or an untestable thing) · `minor` (clarity, small gaps a
competent implementer would resolve correctly) · `nit` (wording, optional).
Verdict mapping: any `blocker`/`major` → `NEEDS_CHANGES`; only
`minor`/`nit` → `NIT_ONLY`; no findings → `verdict: PASS` with a one-line
reason. Cite line numbers from the doc (or post-image diff lines when
reviewing a diff).

## Common mistakes

- Reviewing pseudocode as production code.
- Demanding server-scale concerns (horizontal scaling, HA) from a
  single-user local Electron app — judge against Soroeru's context.
- Flagging detail deliberately deferred to implementation as a gap when the
  doc says so explicitly and the deferral is safe.
- Re-litigating requirements — requirements review (§9.2) owns that; here
  they are inputs.
