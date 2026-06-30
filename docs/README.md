# Documentation Guide

This directory contains development-facing documentation for `Soroeru` (formerly
`formfill-assistant`).

Keep this file as a short index. Put detailed decisions in the document that
owns the relevant topic.

> **Direction change (2026-06-25).** The product is re-founded from `Catashiro` to
> **Soroeru（揃える）**, a local-first **agency engine** for personal-information,
> account, and online-contract decisions. The canonical product direction is
> [`requirements.md`](requirements.md), which fully supersedes the prior direction.
> **Technology selection is now owned by
> [`rfc/rfc-002-soroeru-architecture.md`](rfc/rfc-002-soroeru-architecture.md).**
> [`development.md`](development.md) now includes the Soroeru Electron app commands and
> unsigned DMG packaging flow. [`extension.md`](extension.md) still preserves older
> Soroeru architecture notes until it is fully rewritten around RFC-002.
> The repository identifier stays `soroeru`; the product name is Soroeru.

## Document Responsibilities

| Document | Responsibility |
| --- | --- |
| [`requirements.md`](requirements.md) | **Canonical product direction (Soroeru)**: reason for being, success definition, domain ontology, delegation model, agency loop, scope, slice order, non-negotiable requirements. |
| [`rfc/rfc-002-soroeru-architecture.md`](rfc/rfc-002-soroeru-architecture.md) | **Target Soroeru architecture / technology selection**: runtime, UI, automation, vault, domain services, Slice A design, traceability. |
| [`extension.md`](extension.md) | Application architecture notes: RFC-002 is canonical; older Soroeru sections are retained for reference until the document is fully rewritten. |
| [`security.md`](security.md) | Security and privacy review notes, threat model, encryption, AI-disclosure policy, and wall safety boundaries. |
| [`development.md`](development.md) | Local setup, Soroeru Electron commands, DMG packaging, project structure, implementation conventions, and quality gates. |
| [`testing.md`](testing.md) | Testing strategy, test data policy, fixtures, commands, CI expectations (**previous Catashiro; superseded / in flux** pending a Soroeru testing RFC — registration-first, not Visibility-first). |
| [`manual-test.md`](manual-test.md) | Manual test checklist. §0 owns the Soroeru unsigned DMG smoke; older registration-first checks remain as historical/reference coverage until rewritten. |
| [`verification-results.md`](verification-results.md) | Local 10-site verification results for registration, bulk update, gate/guards, encrypted store, local web UI, Issue #33 (**previous Catashiro; superseded** — historical record). |
| [`user-manual.md`](user-manual.md) | User-facing manual for the Mac private beta (**previous Catashiro; superseded** — registration-first / local web UI / ZIP beta, pending a Soroeru manual). |
| [`beta-feedback.md`](beta-feedback.md) | Beta feedback guide (**previous Catashiro; superseded** — beta scope to be redefined by the Soroeru RFC and slice plan). |
| [`github-operations.md`](github-operations.md) | Issue, branch, label/priority, commit, pull request, review, and merge workflow rules. |
| [`local-ai-review.md`](local-ai-review.md) | Local AI review hook setup, behavior, outputs, and troubleshooting. |

## Primary Sources

- Product behavior belongs in [`requirements.md`](requirements.md).
- Target Soroeru architecture belongs in
  [`rfc/rfc-002-soroeru-architecture.md`](rfc/rfc-002-soroeru-architecture.md).
- Previous Catashiro architecture remains in [`extension.md`](extension.md) for reference.
- Security decisions belong in [`security.md`](security.md).
- Agent operating rules belong in `../AGENTS.md` and `../CLAUDE.md`.
- Issue templates belong in `../.github/ISSUE_TEMPLATE/`, including
  `../.github/ISSUE_TEMPLATE/implementation-plan.md`.

## Update Notes

When behavior, commands, architecture, or security assumptions change, update
the owning document instead of adding duplicate notes elsewhere.

Do not describe future commands, tools, or quality gates as available until the
repository actually contains the required files and scripts.
