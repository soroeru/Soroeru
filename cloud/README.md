# Soroeru Cloud

Setup/deployment commands are owned by [development](../docs/development.md#cloud-development-and-deployment),
service/data boundaries by [architecture](../docs/architecture.md#cloud-contracts-and-operation)
and [security](../docs/security.md#cloud-retention-and-egress).
Schema resolution and structure mapping are implemented. Tier 3 inference,
feedback aggregation and delivered telemetry remain pending despite existing contracts.

## Shared Form Schema Registry

`POST /v1/schemas/resolve` accepts only `{ site, pageFingerprint, clientVersion }`.
It returns a value-free active schema or `{ schema: null, status: "none" }`.
The API queries Firestore's `formSchemas` by the structural fingerprint, then validates
records and filters by site/status. It selects the newest matching version, with
confidence and schema ID as deterministic tie breakers. No URL path, query, or field
value enters this API. Storage failures produce a body-free `503`.

Schema writes are maintainer operations, not a public HTTP endpoint. Every write
rejects unknown keys, non-positional selectors, and strings matching the same
personal-value heuristics as local candidate definitions. Counts must be
non-negative integers; timestamps use UTC ISO strings. Changing an existing schema
requires a higher version; reimporting an identical version is safe. These heuristics
are defense in depth, not a semantic guarantee that arbitrary text is non-personal;
the contract only allows domains, hashes, enum keys, positional anchors and dates.

## Reviewed demo fixture

`seeds/profile.html` is a fictional page with fake values. `seeds/official.json`
contains only its structure hash and mappings, with site `schema-fixture.example`.
The browser test verifies that the seed matches the fixture, including after a value
changes. A maintainer must review each manifest before importing it:

```bash
npm ci --prefix cloud
npm run build --prefix cloud
GOOGLE_CLOUD_PROJECT=<project-id> node cloud/dist/cloud/src/import-seeds.js cloud/seeds/official.json --reviewed
```

The command uses Application Default Credentials with Firestore write access.
Validate all records before the first write; rerun the same manifest after a partial
network failure. This workflow does not automatically activate feedback candidates,
retire schemas, or change validation counters (those lifecycle rules are deferred).
Do not put real page values into a manifest or fixture.

Run API/registry tests with `npm test --prefix cloud`. Run the browser and built-extension checks
with `npm run build:extension && node --test dist/compiled/tests/e2e/tier1-*.e2e.js`.
The extension test grants access only to the fake fixture host in a disposable copy
of the manifest. Production permissions stay opt-in.

## Tier 2 structure mapping

`POST /v1/agent/map-structure` validates a `StructureSnapshot`, debits the daily
budget, then makes one stateless Vertex AI `generateContent` call. The response
contains only mappings and an enum page purpose. Unknown IDs/keys, duplicate
assignments and extra fields are rejected both by the server and extension.
Failures return body-free `503 unavailable`; exhausted budgets return `429`.

Set `GEMINI_MODEL_ID` explicitly to a Gemini model available in `GEMINI_LOCATION`
(default `asia-northeast1`), and `GOOGLE_CLOUD_PROJECT` to the deployment project.
Terraform exposes `gemini_model_id` and injects the project/location. An empty
model ID disables Tier 2 and returns 503; there is no implicit model selection.
Cloud Run uses its attached service account through the metadata server; no
service-account key or extra dependency is required. Local tests inject a fake
transport and do not call Google. REST contracts follow the
[Vertex structured output documentation](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/multimodal/control-generated-output).

Before enabling a model, run the deployment privacy checks and inspect that model's
Vertex request/response logging configuration. Do not enable request/response
logging, tracing body capture or context caching. The client sends no tools,
cachedContent, session history or logging options. The deployment smoke probe
allows explicit mapping unavailability, so a successful smoke check alone does
not prove Gemini availability; perform the manual Tier 2 check before release.

Implicit Vertex caching must also be disabled at project level. Runtime Terraform
manages `google_vertex_ai_cache_config`; update the bootstrap deployment-check
custom role before the next CI deploy so it can read/update cache settings.
The mapper checks cache and model logging settings before each generation and
fails closed if caching/logging is enabled or settings cannot be inspected.
Model configuration `NOT_FOUND` means no custom request/response logging config.
Do not interpret arbitrary permission failures as disabled logging.
