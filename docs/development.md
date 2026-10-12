# Development

This document owns current setup, build/test commands and deployment verification.
Use the [architecture status](architecture.md#implementation-status) to distinguish
available features from target policy. Git/Issue/review workflow belongs in
[GitHub operations](github-operations.md) and the repository skills.

## Local setup

Use Git, bash, jq, Node from `.nvmrc` (22), npm and desktop Chrome. Run all work
inside the Issue worktree created by `scripts/issue-worktree.sh`; the primary
clone is human-only. With nvm installed:

```bash
nvm install
nvm use
npm ci
npm ci --prefix cloud
```

Each worktree needs its own installs. Playwright is needed for browser tests:

```bash
npx playwright install chromium
```

Use fake data and disposable browser profiles. Never load the real-password CSV
for automated tests or publish local state. The existing Git hooks can be installed
with `bash scripts/setup-hooks.sh`; agents still run applicable checks explicitly.

## Run the extension

```bash
npm run build:extension
```

In `chrome://extensions`, enable developer mode and **Load unpacked** from
`dist/extension/`. Open Soroeru from the toolbar to show its Side Panel, create a
vault, save the recovery key, add a fake account and select its HTTPS tab. Grant
only that origin's permission. No Electron app or Native Messaging host is needed
for this path. Rebuild and reload after changes.

To exercise Cloud resolution, build with the reviewed API origin:

```bash
VITE_SOROERU_CLOUD_API_URL=https://example-api.run.app npm run build:extension
```

Replace the example with the deployed HTTPS origin (no path, query or credentials).
Enable cloud assistance in the unlocked panel; it defaults off. Tier 1/Tier 2
are available; Tier 3, delivered feedback/outcomes and full settings are pending.
See [extension notes](../extension/README.md) for the resolver's limits and
[manual checks](manual-test.md) for failure paths.

## Repository boundaries

| Path | Responsibility |
| --- | --- |
| `extension/` | Side Panel UI/runtime, lease router and content script |
| `src/domain/` | Accounts, disclosures, canonical attributes, policy and Evidence |
| `src/store/` | Portable vault/crypto/session contracts and storage adapters |
| `src/automation/`, `src/agent/` | Browser-neutral drivers, collection, classification and wall detection |
| `src/shared/cloud-contract.ts` | Shared closed API validators |
| `cloud/` | Independent Node package for Cloud Run and registry/inference services |
| `infra/bootstrap/`, `infra/runtime/` | Foundation and runtime Terraform |
| `tests/` | Node unit/integration tests and browser fixture suites |
| `electron/`, `native-host/`, `src/renderer/` | Retained migration source and reusable UI |

Keep domain policy independent of UI and transport. Keep classification, wall
detection, persistence and AI validation separately testable. Avoid new frameworks,
providers or dependencies without explicit Issue scope. Apply `writing-good-tests`
when changing tests; assert user-visible effects and wait for conditions.

## Quality gates

Before committing code:

```bash
npm run format
npm run lint
npm run typecheck
npm test
```

`format` is a check, not a rewrite; `format:write` updates the configured source
set. For changed Markdown, inspect rendered headings/tables/code fences and
relative links. Documentation-only work may use that review instead of code
checks. A runtime prompt or other executable edit still needs relevant tests.

For security/privacy/release-sensitive changes:

```bash
npm run release:check
```

This runs typecheck, build/unit tests, egress/persistence/bypass static checks and
`audit:check`. Static annotations are review aids, not proof of safe runtime data
flow. Cloud changes also need:

```bash
npm run typecheck --prefix cloud
npm test --prefix cloud
npm run audit --prefix cloud
npm run build:extension
node --test dist/compiled/tests/e2e/tier1-*.e2e.js
node --test dist/compiled/tests/e2e/tier2-*.e2e.js
```

Root `npm test` runs compiled TypeScript unit tests; development-tool `.test.mjs`
files run separately, for example `node --test tests/unit/project-issue-*.test.mjs`.
Run only the relevant manual scenarios from [manual-test.md](manual-test.md) and
record any omissions in the PR. Requirements/architecture changes use their
matching review skills; implementation plans and reviews belong in the Issue/PR.
Do not generate per-Issue design/spec/report files.

## Cloud development and deployment

The API uses ADC locally and attached service accounts on Cloud Run. Local unit
tests inject fake transports and make no paid model calls. `cloud/README.md` owns
seed import and Gemini model configuration. Terraform 1.14.3, gcloud and Docker
are used by the current cloud workflow.

Validate without applying resources:

```bash
terraform fmt -check -recursive infra
terraform -chdir=infra/bootstrap init -backend=false
terraform -chdir=infra/bootstrap validate
terraform -chdir=infra/runtime init -backend=false
terraform -chdir=infra/runtime validate
npm run build --prefix cloud
docker build -f cloud/Dockerfile -t soroeru-cloud:test .
```

Foundation bootstrap is an intentional operator action that creates billable
resources and applies Terraform. Configure `TF_VAR_project_id`,
`TF_VAR_billing_account`, `TF_VAR_github_repository_id` and
`TF_VAR_github_owner_id`, authenticate local ADC, then run
`node scripts/bootstrap-cloud.mjs`. It first uses ignored local state under
`state/cloud-bootstrap`, migrates to the project's bootstrap state bucket and
creates a ticket-key secret version only if absent. Do not commit state, plans,
credentials or keys. Inspect foundation IAM changes before applying.

Configure the GitHub `soroeru-cloud` environment for main-only deployment with
`GCP_PROJECT_ID`, `TF_STATE_BUCKET`, `GCP_WORKLOAD_IDENTITY_PROVIDER`,
`GCP_DEPLOY_SERVICE_ACCOUNT`, `GEMINI_DAILY_LIMIT` and
`TIER3_TICKET_SECRET_VERSION`. Values come from reviewed foundation outputs.
The cloud workflow validates PRs; its main/deployment path publishes an image,
uses its immutable digest, plans/applies runtime Terraform, then runs:

```bash
node scripts/check-cloud-deployment.mjs <project-id>
```

The check invokes public smoke requests, verifies log exclusions, IAM, instance
limits and Vertex logging/cache settings. It consumes test budget. It does not
prove Gemini can map a form: the mapping smoke permits explicit unavailability.
Run the fake-data manual Tier 2 scenario before enabling a release.

Set runtime `gemini_model_id` explicitly to an available reviewed model; empty
disables Tier 2. The current deployment workflow does not pass a Gemini model
variable, so ensure the reviewed deployment configuration supplies it rather
than assuming a successful deploy enabled inference. Cloud Billing alerts are
notifications, not a spending cap. Do not deploy merely to review documentation.

## Isolated development Cloud resources

Use `infra/dev-shared` once per dedicated development project for Firestore,
service accounts and log exclusions. Use `infra/dev` for Issue-suffixed Cloud Run
resources only when local tests cannot verify the change. Keep production separate;
never destroy the shared layer as part of an individual Issue's cleanup.

```bash
terraform -chdir=infra/dev-shared init
terraform -chdir=infra/dev-shared apply -var="project_id=<dev-project>"
terraform -chdir=infra/dev init -backend-config="path=../../state/dev-i123/terraform.tfstate"
terraform -chdir=infra/dev apply -var="project_id=<dev-project>" -var="issue_number=123" -var="image=<image>"
# After verification, use the same Issue state and variables to remove its resources:
terraform -chdir=infra/dev destroy -var="project_id=<dev-project>" -var="issue_number=123" -var="image=<image>"
```

Replace 123 with the actual Issue number. State stays ignored under `state/`;
never commit it. Apply creates billable resources, so record deployment and
cleanup in the Issue/PR. Do not add a dev-layer CI/CD workflow or deploy merely
for documentation review. Validate both dev modules with `init -backend=false`
and `validate` when changing them, alongside recursive Terraform formatting.

## Development-agent workflow

Use GitHub Issues, labels and native `Blocked by` relations only; no Projects or
Project token. Invoke [issue-implementation](../skills/issue-implementation/SKILL.md)
for new work and [handoff-issue](../skills/handoff-issue/SKILL.md) for existing work.
Multi-Issue routing/configuration belongs in
[orchestrate-project-issues](../skills/orchestrate-project-issues/SKILL.md).
Route discovery is `node scripts/project-issue-capabilities.mjs`; historical
`project-issue-*` names do not authorize Project access.

Development Issue triage is optional and separate from product AI. Its isolated
child may send reviewed development text to TypeSafe only under the orchestration
skill's opt-in checks; no product vault, credentials or raw results enter parent
state. Keep run state ignored and record decisions/review evidence in Issues/PRs.

## Legacy migration entry points

`npm run dev` runs the retained Electron source; `npm run build:app` builds it.
`npm run build:host` builds the Native Messaging relay for explicit migration
checks. For a bridge check, set the unpacked extension ID in the desktop Chrome
connection settings, register the host, then reload the extension. A worktree path
change changes that unpacked ID and requires registration again. Cleanup is the
settings disconnect/unregister action; do not remove another worker's state.

The desktop's default state is `~/Library/Application Support/Soroeru`;
development state uses `state/soroeru-poc`, with `SOROERU_STATE_ROOT` available for
isolated fixtures. `npm run package:dmg` remains a legacy packaging command and
requires Node 22; it is not the Chrome extension distribution workflow. Preserve
encrypted export compatibility and test migration before retirement. Detailed
historical setup/release evidence is available through Git and GitHub.
