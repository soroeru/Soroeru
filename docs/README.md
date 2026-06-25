# Documentation Guide

This directory contains development-facing documentation for `Catashiro` (formerly
`formfill-assistant`).

Keep this file as a short index. Put detailed decisions in the document that
owns the relevant topic.

> **Direction change (2026-06-25).** The product is re-founded from `Catashiro` to
> **Soroeru（揃える）**, a local-first **agency engine** for personal-information,
> account, and online-contract decisions. The canonical product direction is
> [`requirements.md`](requirements.md), which fully supersedes the prior direction.
> **Technology selection is deferred to a later ground-up RFC**; until then
> [`extension.md`](extension.md) and [`development.md`](development.md) describe the
> *previous* Catashiro architecture/workflow and are superseded / in flux. The
> repository identifier stays `catashiro`; the product name is Soroeru.

## Document Responsibilities

| Document | Responsibility |
| --- | --- |
| [`requirements.md`](requirements.md) | **Canonical product direction (Soroeru)**: reason for being, success definition, domain ontology, delegation model, agency loop, scope, slice order, non-negotiable requirements. |
| [`extension.md`](extension.md) | Application architecture (**previous Catashiro; superseded** pending the ground-up Soroeru RFC). |
| [`security.md`](security.md) | Security and privacy review notes, threat model, encryption, AI-disclosure policy, and wall safety boundaries. |
| [`development.md`](development.md) | Local setup, project structure, implementation conventions, and quality gates. |
| [`testing.md`](testing.md) | Automated and manual testing strategy, test data policy, fixture location, commands, and CI expectations. |
| [`manual-test.md`](manual-test.md) | Manual test checklist for registration, the review-and-confirm gate, the three guards, and wall hand-off. |
| [`verification-results.md`](verification-results.md) | Local 10-site verification results for registration, bulk update, gate/guards, encrypted store, and the local web UI (Issue #33). |
| [`user-manual.md`](user-manual.md) | **User-facing manual for Mac private beta users**: install, vault setup, personal-data entry, Add Site flow, confirm gate, wall hand-off, bulk update, support bundle, uninstall. |
| [`beta-feedback.md`](beta-feedback.md) | **Beta feedback guide**: feedback channels, template questions, sensitive-data handling rules, and how to file actionable GitHub Issues. |
| [`github-operations.md`](github-operations.md) | Issue, branch, commit, pull request, review, and merge workflow rules. |
| [`local-ai-review.md`](local-ai-review.md) | Local AI review hook setup, behavior, outputs, and troubleshooting. |

## Primary Sources

- Product behavior belongs in [`requirements.md`](requirements.md).
- Application architecture belongs in [`extension.md`](extension.md).
- Security decisions belong in [`security.md`](security.md).
- Agent operating rules belong in `../AGENTS.md` and `../CLAUDE.md`.
- Issue templates belong in `../.github/ISSUE_TEMPLATE/`, including
  `../.github/ISSUE_TEMPLATE/implementation-plan.md`.

## Update Notes

When behavior, commands, architecture, or security assumptions change, update
the owning document instead of adding duplicate notes elsewhere.

Do not describe future commands, tools, or quality gates as available until the
repository actually contains the required files and scripts.
