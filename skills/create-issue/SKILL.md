---
name: create-issue
description: Create Soroeru GitHub Issues with safe project metadata and idempotently configure their Project item. Use when filing or standardizing an Issue for Visibility, Bulk Update, or Registration / Form Automation.
---

# Create Issue

Use the repository's Issue template and include a bounded machine-readable block:

```markdown
<!-- project-metadata:start -->

- AI Assignee: Codex
- AI Sub Assignee: Claude
- Priority: P1
- Size: M
- Feature group: Visibility collection
<!-- project-metadata:end -->
```

Allowed AI Assignees are `Claude`, `Codex`, `Gemini`, `Grok`, and `未記載`. Every Issue must also name its mapped AI Sub Assignee. Read the mapping from the selected target Project's `aiSubAssignees` entry in `config/github-projects.json`; that configuration is the contract source. The `Codex` / `Claude` pair above is illustrative only and must not be copied when the configured mapping differs. The sub assignee is the preselected handoff recipient, not an implicit model fallback. Missing, unknown, or mismatched primary/sub assignments stop Project mutation. Priority and Size must be values already present in the target Project; the automation never creates options. The legacy `implementation-assignment` comment is accepted for AI Assignee compatibility.

If the primary agent reaches a session limit or is otherwise interrupted after work has started, the mapped sub assignee must resume the existing Issue worktree with `handoff-issue`. Never create a duplicate worktree or reset, clean, stash, copy, or discard inherited WIP.

Classify only from the Issue title, body, labels, and dependencies. Do not send credentials, tokens, personal data, or raw secret values to an AI provider. If a classification is ambiguous or below the provider's confidence threshold, leave the Project unconfigured and report `project-unclassified`.

For local reproduction, use Node.js 22:

```bash
node scripts/project-issue-defaults.mjs --event path/to/issues-opened.json
node --test tests/unit/project-issue-defaults.test.mjs
```

The GitHub Actions workflow is triggered by `issues.opened`. It resolves Project, field, option, item, and iteration IDs by name through GraphQL. It reuses existing items and exact-name iterations on rerun. API failures return a retryable error without logging Issue contents or secrets.
