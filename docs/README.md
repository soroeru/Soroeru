# Documentation Guide

This directory contains development-facing documentation for
`formfill-assistant`.

Keep this file as a short index. Put detailed decisions in the document that
owns the relevant topic.

## Document Responsibilities

| Document | Responsibility |
| --- | --- |
| [`requirements.md`](requirements.md) | Product requirements, v0.1 scope, non-scope, use cases, and non-functional requirements. |
| [`extension.md`](extension.md) | Chrome extension architecture, Manifest V3 design, component responsibilities, data flow, and UI injection guidance. |
| [`security.md`](security.md) | Security and privacy review notes, threat model, permission constraints, and sensitive data handling. |
| [`development.md`](development.md) | Local setup, project structure, implementation conventions, and quality gates. |
| [`testing.md`](testing.md) | Automated and manual testing strategy, test data policy, fixture location, commands, and CI expectations. |
| [`manual-test.md`](manual-test.md) | Browser-based manual test checklist for human-in-the-loop behavior and extension workflows. |
| [`github-operations.md`](github-operations.md) | Issue, branch, commit, pull request, review, and merge workflow rules. |
| [`local-ai-review.md`](local-ai-review.md) | Local cross-AI review hook setup, behavior, outputs, and troubleshooting. |

## Primary Sources

- Product behavior belongs in [`requirements.md`](requirements.md).
- Chrome extension design belongs in [`extension.md`](extension.md).
- Security decisions belong in [`security.md`](security.md).
- Agent operating rules belong in `../AGENTS.md` and `../CLAUDE.md`.
- Issue templates belong in `../.github/ISSUE_TEMPLATE/`, including
  `../.github/ISSUE_TEMPLATE/implementation-plan.md`.

## Update Notes

When behavior, commands, architecture, or security assumptions change, update
the owning document instead of adding duplicate notes elsewhere.

Do not describe future commands, tools, or quality gates as available until the
repository actually contains the required files and scripts.
