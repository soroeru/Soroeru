---
name: create-issue
description: Create Soroeru GitHub Issues with safe project metadata and idempotently configure their Project item. Use when filing or standardizing an Issue for Visibility, Bulk Update, or Registration / Form Automation.
---

# Create Issue

Use the repository's Issue template and include a bounded machine-readable block:

```markdown
<!-- project-metadata:start -->

- Priority: P1
- Size: M
- Feature group: Visibility collection
<!-- project-metadata:end -->
```

The block carries only Priority, Size, and Feature group. Priority and Size must
be values already present in the target Project; the automation never creates
options and falls back to the documented safe defaults (P2 / M) with an
`invalid-priority` / `invalid-size` reason when a value is unknown.

Do **not** write agent or model assignment into the Issue. AI Assignee /
AI Sub Assignee / Model / Order fields and the `implementation-assignment`
block are abolished: agent/model routing is decided dynamically at
`orchestrate-project-issues` run time from verified runtime capabilities, and
the handoff recipient is chosen at interruption time from the remaining
routes. Legacy Issues that still contain those fields are processed with the
fields ignored, never rejected. Dependencies are expressed as GitHub
`Blocked by` Issue relationships, not body text.

Classify only from the Issue title, body, labels, and dependencies. Do not send
credentials, tokens, personal data, or raw secret values to an AI provider. If a
classification is ambiguous or below the provider's confidence threshold, leave
the Project unconfigured and report `project-unclassified`.

For local reproduction, use Node.js 22:

```bash
node scripts/project-issue-defaults.mjs --event path/to/issues-opened.json
node --test tests/unit/project-issue-defaults.test.mjs
```

The GitHub Actions workflow is triggered by `issues.opened`. It resolves
Project, field, option, item, and iteration IDs by name through GraphQL and is
fail-close: all reads and validations complete before the first mutation (a
validation failure performs zero mutations), and a final readback confirms
every written field converged before reporting success. On a partial failure
it returns a retryable reason — naming the unconverged Project fields, never
Issue contents or secrets — and a rerun reconciles by reusing the existing
item and exact-name iteration.
