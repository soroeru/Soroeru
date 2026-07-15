# Project Issue Defaults Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Configure new Issues in GitHub Project #2 through a reusable Skill and idempotent GitHub Actions automation.

**Architecture:** A pure, dependency-free Node module parses the Issue metadata and classifies project candidates. A GraphQL adapter resolves project fields/options/items by name and applies safe defaults. The workflow supplies the event and token; the Skill documents the same local contract.

**Tech Stack:** Node.js 22, GitHub Actions, GitHub GraphQL API, `node:test`, Markdown/YAML/JSON.

## Global Constraints

- Never log tokens, credentials, raw Issue bodies, or personal data.
- Never use hard-coded Project field or option IDs.
- Never create Priority or Size options automatically.
- Unknown, missing, ambiguous, or low-confidence values must stop or use documented safe defaults.
- Reruns must not duplicate Project items or iterations.

### Task 1: Pure metadata and classification module

**Files:** Create `scripts/project-issue-defaults.mjs`; create `tests/unit/project-issue-defaults.test.mjs`.

- [ ] Write failing tests for the metadata block, legacy assignment, allowed project classification, invalid values, and date calculation.
- [ ] Run `node --test tests/unit/project-issue-defaults.test.mjs` and confirm the missing-module failure.
- [ ] Implement pure parsing/classification/date helpers with no network access.
- [ ] Run the focused tests and confirm they pass.

### Task 2: GraphQL orchestration and workflow

**Files:** Modify `scripts/project-issue-defaults.mjs`; create `.github/workflows/project-issue-defaults.yml`; create `config/github-projects.json`; create `skills/create-issue/SKILL.md`; create `skills/create-issue/agents/openai.yaml`.

- [ ] Add an injectable GraphQL operation runner and idempotent item/field update sequence.
- [ ] Add the `issues.opened` workflow with minimal contents/issues/project permission documentation and secret handling.
- [ ] Add configuration-driven candidates and field names without exposing IDs.
- [ ] Document local invocation, metadata contract, AI classification boundary, and failure handling in the Skill.
- [ ] Add API-mock tests for existing item reuse, missing option defaults, and retryable failure.

### Task 3: Documentation and verification

**Files:** Modify `docs/development.md`; modify `docs/github-operations.md`; modify `docs/testing.md`.

- [ ] Document the Project token setup, minimum permissions, rotation, and workflow rerun behavior.
- [ ] Run focused tests, formatting checks, and the repository typecheck/build gates available for the changed files.
- [ ] Review the diff for secrets, raw Issue data, and generated artifacts.
