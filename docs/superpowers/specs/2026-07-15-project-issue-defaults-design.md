# Project Issue Defaults Design

Issue: #393

## Goal

When a new GitHub Issue is opened, classify it using safe, structured metadata and add it idempotently to the configured GitHub Project with resolved AI assignee, priority, size, iteration, and dates.

## Design

The repository will contain a reusable `create-issue` Skill contract and a dependency-free Node.js implementation under `scripts/project-issue-defaults.mjs`. The script accepts an Issue payload and a GraphQL client, so parsing, classification, option validation, and update sequencing can be tested without GitHub access. The Actions workflow invokes the script with `GITHUB_TOKEN` and the Issue event payload.

Project configuration is data-driven: candidate projects, Project #2, field names, allowed choices, and iteration naming are represented in a JSON configuration file. GraphQL resolves the Project, fields, options, and existing item by names; no field or option ID is hard-coded. Invalid or missing metadata uses safe defaults and emits reason codes without echoing Issue body contents or secrets.

The workflow adds the Issue only when no matching Project item exists, then updates only the configured fields. Iteration lookup is exact-name and date-aware; the script creates the one-day iteration only when the Project API supports it and an iteration is absent. A rerun reuses the existing item and iteration. API failures return a retryable non-zero exit status.

## Testing and privacy

Node test cases cover metadata parsing, AI/project classification, safe defaults, exact iteration dates, idempotent reruns, and GraphQL failures. Fixtures contain synthetic titles and labels only. Logs contain event IDs and reason codes, never tokens, credentials, raw Issue bodies, or personal data.
