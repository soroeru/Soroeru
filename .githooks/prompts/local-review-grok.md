# Local Code Review (Grok as reviewer)

You are reviewing a local branch's diff against the project base. The diff
itself is included below in the `## Diff` section. Read it and report
findings in the structure described here. Do **not** modify any files; this
review is read-only.

## Output format

Lead with a one-line verdict, then a findings list. If there are no issues,
say so explicitly (use `verdict: PASS` and write a short reason why the diff
looks good).

```
verdict: PASS | NEEDS_CHANGES | NIT_ONLY

## Findings

1. [<severity>] <file>:<line> — <one-sentence problem statement>
   <2-4 sentences of explanation, including a concrete suggested fix>

2. ...
```

Severity values:

- `blocker` — must fix before merging (correctness / security / data loss)
- `major`   — should fix before merging (regression risk, missing tests)
- `minor`   — nice to fix (clarity, robustness, small consistency issues)
- `nit`     — style / wording, optional

## What to look for

Prioritize in this order:

1. **correctness** — bugs, off-by-one, null / empty handling, race conditions,
   error paths that swallow failures
2. **regressions** — behavior changes that break existing callers, tests, or
   documented contracts
3. **security** — input validation, auth, secrets in logs, command injection,
   path traversal, permission bits on state files
4. **missing tests** — new behavior or new branches that have no test coverage
5. **docs consistency** — README / CLAUDE.md / AGENTS.md / docs/* that
   contradict the diff after the change

## Reviewing documentation diffs

When the diff only changes documentation (e.g. `docs/**/*.md`, `README.md`, `AGENTS.md`,
`CLAUDE.md`, design docs), do **not** apply items 1-3 above ("correctness", "regressions",
"security") to any sample code, pseudocode, or code blocks embedded in that documentation.
Embedded code is illustrative, not shipped code — do not review it as if it were a real
source-code diff, and do not raise findings about bugs, off-by-one errors, unhandled edge
cases, missing null checks, race conditions, or specific algorithmic correctness inside it.

Judge embedded code only on whether it will still be a **useful reference for whoever
implements it later**: flag it if it contradicts the surrounding prose, references an
API/module/file that does not exist or has been renamed, or is incomplete/misleading enough
that a future implementer would be led astray. Otherwise leave it alone. Item 5 ("docs
consistency") still applies normally.

## Constraints

- Do not propose changes outside the diff; restrict comments to the diff's
  scope.
- Do not include `@codex` / `@claude` / `@grok` mentions or any PR / commit boilerplate.
- Do not suggest auto-fix workflows; this review is informational.
- Cite file paths and line numbers based on the diff contents (use the
  post-image line numbers from `+++` hunks).
- Be concise. Prefer 5 strong findings over 20 shallow ones.
