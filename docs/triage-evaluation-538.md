# Issue #538 Jev triage evaluation

Evaluated 2026-10-11 against the frozen `triage-v3` / `triage-rubric-538-v3`
classifier and `jev-1.13.0`. All cases are fictional; no live Issue bodies or
personal data were sent. The existing holdout labels were unchanged.

| Measurement | Result |
| --- | --- |
| Holdout requests | 79 |
| High/critical cases | 41 |
| Usable high/critical recommendations | 34 (required ≥30) |
| High/critical predicted low/medium | 0 |
| Direct-review misses | 0 |
| Sensitive fixtures rejected before sending | 5 |
| Leaks / constraint violations | 0 / 0 |
| Risk / Size accuracy | 83.5% / 72.2% |
| Exact input / output tokens | 105768 / 7426 |
| Price | unavailable |

Initial v1 holdout had only 5 usable high/critical results. Prompt changes were
made on the separate tune split; confidence 0.7 and probability gap 0.2 stayed
unchanged. v3 tune reached 16/18 usable high/critical and 93.6% risk accuracy.
The frozen v3 holdout first yielded 34/41 usable results. Repeating the same
classifier after adding its identity fingerprint yielded 33/41; no holdout-based
prompt or threshold tuning occurred. The final review added the static route question
to the approval fingerprint without changing any classification instruction; a new
full measurement yielded 34/41 and is the exact artifact bound to adoption. Provider variability remains a limitation.

Final full report SHA-256: `21f81c4ae3400b26c0cbc654d76afc3e9a6531ed338ead1ce89677cce6a86ab4`.
The exact local report is `state/triage-eval/assisted-evaluation.json`; classifier
fingerprint: `d1f52a58bf50c0ecd6ffd532187b7ab0983a71901ddbd73dc58c18421ea5fc8d`. Logs and reports remain ignored.

The live CLI route benchmark confirmed only Claude Fable availability; the
benchmark did not complete, so no usable RouteEvidence was produced. Route
selection abstains without reviewed evidence. This evaluation establishes
risk/Size gate floors, not model capability ranking or general Issue accuracy.

The seven high/critical cases requiring manual review are H025, H031, H047,
H056, H059, H074 and H076. Review their risk/Size uncertainty rather than
accepting them automatically. Sensitive cases remain pre-send fallback.
Among 52 usable recommendations, the label-relative override proxy is 15/52:
3 risk underestimates, 1 risk overestimate and 11 Size-only disagreements.
These are comparison-to-label causes, not measured human override behavior;
production parent override rates and route outcome comparisons remain unmeasured.

**Product Owner approval recorded 2026-10-11:** the user explicitly approved the
labels, cause analysis and limited risk/Size assisted adoption. The ignored local
`state/triage-eval/assisted-approval.json` binds that decision to the exact report hash
above. Route selection still abstains without reviewed evidence. The fictional
label set remains at `state/triage-eval/label-review.md`.

The same instruction authorized private Issue support. An independent boolean
`allowPrivateIssues` opt-in now permits the fixed repository's reviewed, non-personal
development title/body. Existing secret rejection, isolation, budgets and freshness
checks remain enforced. This authorization change does not alter classifier questions,
model or thresholds, so the measured classifier fingerprint remains current.
See [setup and private opt-in](development.md#private-development-issue-opt-in-issue-538).

GitHub Projects are retired for active Issue implementation. Only Issue identity,
labels and native `Blocked by` metadata drive selection. No Project token is needed.
