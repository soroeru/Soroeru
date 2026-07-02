# Documentation Guide

This directory contains development-facing documentation for `Soroeru`, a local-first
**agency engine** for personal-information, account, and online-contract decisions.

Keep this file as a short index. Put detailed decisions in the document that
owns the relevant topic. The repository identifier is `soroeru`; the product name is
Soroeru.

## Document Responsibilities

| Document | Responsibility |
| --- | --- |
| [`requirements.md`](requirements.md) | **Canonical product direction (Soroeru)**: reason for being, success definition, domain ontology, delegation model, agency loop, scope, slice order, non-negotiable requirements. |
| [`architecture.md`](architecture.md) | **Canonical target architecture / technology selection**: Electron process boundaries, runtime/UI/automation/vault/domain-service decisions, domain model, IPC trust boundary, Slice A design, security mapping. |
| [`security.md`](security.md) | Security and privacy review notes, threat model, encryption, AI-disclosure policy, and wall safety boundaries. |
| [`development.md`](development.md) | Local setup, Soroeru Electron commands, DMG packaging, project structure, implementation conventions, and quality gates. |
| [`testing.md`](testing.md) | **Current testing strategy (Soroeru)**: what to test per layer, the keep-vs-reduce inventory criteria, test data policy, fixtures, commands, CI expectations, and the registration/bulk-update E2E matrix. |
| [`manual-test.md`](manual-test.md) | Manual test checklist; §0 owns the Soroeru unsigned DMG smoke. |
| [`user-manual.md`](user-manual.md) | User-facing manual for the current Soroeru Mac private beta: DMG install, vault setup, CSV import, Visibility collection, disclosure ledger, insights, wall hand-off, and privacy boundaries. |
| [`github-operations.md`](github-operations.md) | Issue, branch, label/priority, commit, pull request, review, and merge workflow rules. §3 also owns the design-doc policy below. |
| [`local-ai-review.md`](local-ai-review.md) | Local AI review hook setup, behavior, outputs, and troubleshooting. |
| `design/*.md` | Per-Issue detailed design docs produced by Plan mode at the start of implementation (see [`github-operations.md`](github-operations.md) §3). Session-scoped: read only the doc for the Issue being implemented. |

## Primary Sources

- Product behavior belongs in [`requirements.md`](requirements.md).
- Target Soroeru architecture and technology selection belong in
  [`architecture.md`](architecture.md).
- Security decisions belong in [`security.md`](security.md).
- Agent operating rules belong in `../AGENTS.md` and `../CLAUDE.md`.
- Issue templates belong in `../.github/ISSUE_TEMPLATE/`, including
  `../.github/ISSUE_TEMPLATE/implementation-plan.md`.

## Update Notes

When behavior, commands, architecture, or security assumptions change, update
the owning document instead of adding duplicate notes elsewhere.

Do not describe future commands, tools, or quality gates as available until the
repository actually contains the required files and scripts.
