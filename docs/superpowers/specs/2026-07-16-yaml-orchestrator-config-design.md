# YAML Configuration for Project Issue Orchestration

Issue: #403

## Goal

Let the Product Owner configure stable Project Issue orchestration parameters in a local YAML
file and use that file through both the CLI and the `orchestrate-project-issues` skill. Preserve
the existing fail-closed start gate and keep run credentials and routing capabilities outside
the YAML.

## Configuration Files

Commit `config/project-issue-orchestrator.example.yaml` as the documented template. The Product
Owner copies it to the Git-ignored `state/project-issue-orchestrator.yaml` and edits only that
runtime copy.

The schema is:

```yaml
project:
  owner: ShinHaya
  ownerType: user
  number: 2

run:
  maxParallel: 4
  releasePolicy: merged
  unavailableModels: none
```

`project.ownerType` accepts only `user` or `organization`. `run.releasePolicy` accepts only
`pr-created` or `merged`. `run.unavailableModels` accepts either the scalar `none` or a list of
exact model names; `none` normalizes to an empty list.

The YAML does not contain GitHub tokens, capability records, parent routes, model selectors,
state paths, milestone events, target Issue lists, or orchestration output.

## CLI Integration

Add `--config <path>` to `scripts/project-issue-orchestrator.mjs`. The CLI loads and validates the
YAML before fetching the GitHub Project. Configuration values fill the corresponding existing
CLI options. An explicitly supplied CLI flag overrides the YAML value for the same field, which
keeps one-off runs possible without editing the file.

After normalization, the existing Project fetch, assignment parsing, graph validation,
capability validation, scheduling, state, and milestone paths receive the same option shape they
use today. This feature does not alter dependency or release semantics.

## Validation and Failure Behavior

Validation fails closed before network access for:

- unreadable or malformed YAML;
- missing required sections or values;
- unknown top-level or nested keys;
- invalid owner type or release policy;
- a non-positive or non-integer parallel limit;
- unavailable models other than `none` or a non-empty string list;
- duplicate YAML keys.

Errors use stable reason codes suitable for tests and skill reporting. The loader never prints
the complete YAML document.

## Skill Flow

Update `orchestrate-project-issues` so a user may supply the runtime YAML path instead of spelling
out the six configured values in conversation. The skill verifies the path exists, invokes the
orchestrator with `--config`, and retains every existing requirement for capabilities, dry-run,
state, worktree detection, milestones, and worker routing.

The Product Owner will fill `state/project-issue-orchestrator.yaml` before the first verification
run. Creating the file does not automatically start orchestration.

## Implementation Boundaries

Use a maintained YAML parser rather than a partial custom parser. Keep parsing and schema
validation in a small module so CLI argument parsing, tests, and future callers do not depend on
parser internals. Do not introduce application runtime behavior or expose this configuration in
the Electron UI.

## Verification

Focused unit tests cover:

- valid YAML loading and normalization;
- `none` and model-list handling;
- explicit CLI-over-YAML precedence;
- missing values, unknown keys, invalid enums, invalid limits, malformed YAML, and duplicate keys;
- validation occurring before the GitHub fetch path;
- CLI dry-run behavior using a fixture and YAML configuration.

Documentation verification confirms the committed sample and the skill use the same key names
and invocation form. The final implementation also runs the repository's applicable format,
lint, and focused test gates.
