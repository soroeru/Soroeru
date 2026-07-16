# YAML Orchestrator Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Load Project Issue orchestration parameters from the repository-root-relative `state/project-issue-orchestrator.yaml` by default, with an explicit alternate-path override.

**Architecture:** A small schema loader parses YAML at the CLI boundary and returns the existing option names (`projectOwner`, `ownerType`, `projectNumber`, `maxParallel`, `releasePolicy`, and `unavailableModels`). The CLI merges defaults, YAML values, and explicit flags in that order, then runs the unchanged planner and GitHub fetch path. The skill documents default discovery and does not carry personal or credential data.

**Tech Stack:** Node.js ESM, maintained `yaml` package, existing Node test runner, Markdown skill/docs, Git-ignored local `state/`.

## Global Constraints

- Runtime values live in `state/project-issue-orchestrator.yaml`; never commit them.
- The committed template is `config/project-issue-orchestrator.example.yaml`.
- `ownerType` is exactly `user` or `organization`.
- `releasePolicy` is exactly `pr-created` or `merged`.
- `unavailableModels: none` normalizes to `[]`.
- Unknown keys and invalid values fail closed before GitHub network access.
- Explicit CLI flags override YAML values; all-CLI invocation remains valid when the default file is absent.
- At least one of `--issues`, `--priority`, `--iteration`, or `--size` is required for a run.
- Values within one selector kind are ORed; different selector kinds are ANDed.
- Dependencies are recursively added to the selected Issue closure, regardless of their selector fields.
- `Start date` is metadata only; `--run-date` is removed from orchestration filtering.
- Do not put tokens, capability records, state paths, milestones, target Issue lists, or parent routes in YAML.

---

### Task 1: Add the schema loader with RED tests

**Files:**
- Create: `scripts/project-issue-config.mjs`
- Modify: `tests/unit/project-issue-orchestrator.test.mjs`
- Modify: `package.json` and lockfile

**Interfaces:**
- Produces `DEFAULT_CONFIG_PATH = "state/project-issue-orchestrator.yaml"`.
- Produces `loadOrchestratorConfig(filePath, { cwd })`, returning `{ projectOwner, ownerType, projectNumber, maxParallel, releasePolicy, unavailableModels }`.
- Produces `mergeOrchestratorConfig({ defaults, yaml, cli })`, where later defined fields override earlier fields and `unavailableModels` is always an array.

- [ ] **Step 1: Add failing unit tests**

Add tests that create temporary YAML files and assert:

```js
const config = await loadOrchestratorConfig(file, { cwd: repoRoot });
assert.deepEqual(config, {
  projectOwner: "ShinHaya",
  ownerType: "user",
  projectNumber: 2,
  maxParallel: 4,
  releasePolicy: "merged",
  unavailableModels: [],
});
```

Also assert `none`, a string list, unknown keys, duplicate keys, malformed YAML, missing fields,
invalid enums, zero/decimal `maxParallel`, and a path outside the repository-root resolution.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
node --test tests/unit/project-issue-orchestrator.test.mjs
```

Expected: FAIL because the config module and loader exports do not exist.

- [ ] **Step 3: Add the YAML dependency and minimal loader**

Install the maintained `yaml` package. Implement strict parsing with duplicate-key rejection,
allow only the `project` and `run` sections and their six keys, resolve relative paths from the
provided repository root, normalize scalar `none` to `[]`, and throw stable reason codes such as
`config-file-not-found`, `config-invalid-yaml`, `config-unknown-key:<key>`, and
`config-missing:<field>`.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run the same Node test command and expect all new loader tests to pass.

- [ ] **Step 5: Commit the loader**

```bash
git add scripts/project-issue-config.mjs tests/unit/project-issue-orchestrator.test.mjs package.json package-lock.json
git commit -m "feat: add orchestrator YAML config loader"
```

### Task 2: Integrate default discovery and CLI precedence

**Files:**
- Modify: `scripts/project-issue-orchestrator.mjs`
- Modify: `tests/unit/project-issue-orchestrator.test.mjs`

**Interfaces:**
- `parseCliArgs` accepts `--config <path>` as `configPath`.
- CLI execution resolves the default path when `--config` is absent, loads it when present, and
  merges values in this order: built-in defaults, YAML, explicit CLI flags.

- [ ] **Step 1: Add failing CLI tests**

Add tests for `parseCliArgs(["--config", "custom.yaml"])`, default-file loading with a temporary
repository root, explicit `--max-parallel` overriding YAML, and all-CLI operation when no YAML
exists. Assert the GitHub fetch callback is not reached for invalid YAML.

- [ ] **Step 2: Run the tests and verify RED**

```bash
node --test tests/unit/project-issue-orchestrator.test.mjs
```

Expected: FAIL for the new `configPath` and precedence assertions.

- [ ] **Step 3: Implement CLI integration**

Load configuration before `readInput` performs GitHub access. Preserve explicit CLI array flags
for repeated `--unavailable-model`, and let an explicit empty/unavailable setting be represented
only by YAML `none`. Keep `--project-owner`, `--owner-type`, `--project-number`,
`--max-parallel`, and `--release-policy` as the final override layer.

- [ ] **Step 4: Run the tests and verify GREEN**

```bash
node --test tests/unit/project-issue-orchestrator.test.mjs
```

- [ ] **Step 5: Commit CLI integration**

```bash
git add scripts/project-issue-orchestrator.mjs tests/unit/project-issue-orchestrator.test.mjs
git commit -m "feat: auto-load orchestrator YAML settings"
```

### Task 3: Add the template, ignore rule, skill instructions, and docs

**Files:**
- Create: `config/project-issue-orchestrator.example.yaml`
- Modify: `.gitignore`
- Modify: `skills/orchestrate-project-issues/SKILL.md`
- Modify: `docs/development.md`

**Interfaces:**
- The sample uses the exact schema and the `none` sentinel.
- The skill states that the default file is auto-detected and `--config` is only for alternate
  paths.

- [ ] **Step 1: Add the sample and ignore rule**

Create the sample with `project.owner`, `project.ownerType`, `project.number`, `run.maxParallel`,
`run.releasePolicy`, and `run.unavailableModels: none`. Add only the runtime filename pattern
`state/project-issue-orchestrator.yaml` to `.gitignore`; do not broaden the existing state rule.

- [ ] **Step 2: Update the skill and development command examples**

Document copying the sample to `state/project-issue-orchestrator.yaml`, automatic loading,
explicit alternate `--config`, precedence, and validation-before-fetch. Update the existing CLI
example to show the automatic path while retaining capability-file and other non-YAML flags.

- [ ] **Step 3: Verify documentation consistency**

Run:

```bash
rg -n "project-issue-orchestrator\.yaml|ownerType|maxParallel|releasePolicy|unavailableModels" config skills/orchestrate-project-issues docs/development.md
git diff --check
```

- [ ] **Step 4: Commit docs and template**

```bash
git add config/project-issue-orchestrator.example.yaml .gitignore skills/orchestrate-project-issues/SKILL.md docs/development.md
git commit -m "docs: document orchestrator YAML settings"
```

### Task 4: Run complete verification and prepare handoff

**Files:**
- Test: `tests/unit/project-issue-orchestrator.test.mjs`
- Verify: `config/project-issue-orchestrator.example.yaml`

- [ ] **Step 1: Run focused tests**

```bash
node --test tests/unit/project-issue-orchestrator.test.mjs tests/unit/project-issue-defaults.test.mjs
```

Expected: PASS.

- [ ] **Step 2: Run repository quality gates**

```bash
npm run format
npm run lint
npm run typecheck
```

Expected: all commands exit 0.

- [ ] **Step 3: Verify the runtime file is absent from Git tracking**

```bash
test ! -e state/project-issue-orchestrator.yaml || git check-ignore -q state/project-issue-orchestrator.yaml
git status --short
```

Expected: the runtime path is ignored if created, and no credentials or personal data appear in
the diff.

- [ ] **Step 4: Commit any final test-only correction**

```bash
git add -u
git commit -m "test: verify orchestrator YAML configuration"
```

- [ ] **Step 5: Report the editable YAML path**

Tell the Product Owner to copy `config/project-issue-orchestrator.example.yaml` to
`state/project-issue-orchestrator.yaml` in the Issue worktree and fill the values. Do not run
orchestration until they have supplied the values and requested a dry-run.

### Task 5: Add filtered Issue selection and dependency closure

**Files:**
- Modify: `scripts/project-issue-github.mjs`
- Modify: `scripts/project-issue-plan.mjs`
- Modify: `scripts/project-issue-orchestrator.mjs`
- Modify: `tests/unit/project-issue-orchestrator.test.mjs`
- Modify: `skills/orchestrate-project-issues/SKILL.md`
- Modify: `docs/development.md`

**Interfaces:**
- `parseCliArgs` accepts repeatable comma-separated `--issues`, `--priority`, `--iteration`, and `--size` values.
- `selectProjectItems(items, selectors)` returns the selector matches plus their recursive dependency closure.
- Selection fails with `issue-filter-required` when all four selector lists are empty.

- [ ] **Step 1: Write failing selection and dependency tests**
- [ ] **Step 2: Run focused tests and verify RED**
- [ ] **Step 3: Implement raw Project metadata mapping and post-fetch selection**
- [ ] **Step 4: Remove `--run-date` handling and update docs/skill examples**
- [ ] **Step 5: Run focused tests and verify GREEN**
- [ ] **Step 6: Commit filtered selection**
