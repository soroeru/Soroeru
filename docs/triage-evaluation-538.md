# Issue #538 Jev triage evaluation

Evaluated 2026-10-11 against the frozen `triage-v3` / `triage-rubric-538-v3`
classifier and `jev-1.13.0`. All cases are fictional; no live Issue bodies or
personal data were sent. The existing holdout labels were unchanged.

| Measurement | Result |
| --- | --- |
| Holdout requests | 79 |
| High/critical cases | 41 |
| Usable high/critical recommendations | 33 (required ≥30) |
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
prompt or threshold tuning occurred. Provider variability remains a limitation.

Final full report SHA-256: `de92dc42527c6c1357074862ab6db32d08ca14ae15d1503086af712cddc22840`.
The exact local report is `state/triage-eval/assisted-evaluation.json`; classifier
fingerprint: `dd1a81ec6bea9d83d5c7102aa01ef5c4e41ca961cb733f54317e2d7c0113d2fc`. Logs and reports remain ignored.

The live CLI route benchmark confirmed only Claude Fable availability; the
benchmark did not complete, so no usable RouteEvidence was produced. Route
selection abstains without reviewed evidence. This evaluation establishes
risk/Size gate floors, not model capability ranking or general Issue accuracy.

The eight high/critical cases requiring manual review are H025, H031, H047,
H056, H059, H074, H076 and H079. Review their risk/Size uncertainty rather than
accepting them automatically. Sensitive cases remain pre-send fallback.

**Adoption pending:** Product Owner label confirmation, review of uncertain and
fallback cases, and explicit assisted adoption approval are not yet recorded.
The local `state/triage-eval/label-review.md` contains the complete fictional
label set for human review. Neither configuring the API key nor requesting
implementation is treated as this approval. Assisted stays unavailable until
its approval record matches the exact measured report and deployed classifier.
See [setup and adoption procedure](development.md#assisted-triage-adoption-issue-538).

GitHub Projects are retired for active Issue implementation. Only Issue identity,
labels and native `Blocked by` metadata drive selection. No Project token is needed.
