# Testing

Test the observable behavior at the boundary that owns it. Use the
[writing-good-tests skill](../skills/writing-good-tests/SKILL.md), realistic fake
fixtures and condition-based waits. Commands and quality gates are owned by
[development](development.md#quality-gates); acceptance records belong in Issues/PRs.

## Layer coverage

| Layer | Essential coverage |
| --- | --- |
| Vault and persistence | Wrong key, corrupt/newer format, recovery, export compatibility, interrupted/quota save, single writer, lock/close |
| Domain | Import validation/deduplication, provenance, known/masked/unknown values, stale comparisons, per-site partial outcomes |
| Permission and lease | Wrong tab/origin/epoch, navigation, permission revocation, worker restart, bounded timeout, explicit rebind |
| Content script | Live unique anchors, classification disagreement, untrusted page text, secret exclusion, walls before read/fill |
| Tier 1/2 | Cache freshness, live `none`, closed mappings, changed page, outages, unknown fields, assistance off |
| Cloud | Contract rejection, body limits, rate/budget limits, ticket binding/replay, logging/cache preflight failure |
| Target consent/sharing | No send on decline/expiry/stop, bounded run consent, fresh tickets on retries, queue off/clear and idempotency |
| Target writes | Approved scope only, changed terms, no auto-attestation, payment boundary, irreversible confirmation, uncertain completion |

The last two rows include pending implementation. Tests for new policy must be
added with that implementation; documentation changes do not make those paths
available. Preserve mandatory user decisions without testing the deleted quiz or
per-fallback-only policy as permanent requirements.

## Fixtures and isolation

Use disposable vaults and browser profiles. Never read the gitignored password
CSV in tests or include real account domains, values, screenshots or tokens in
artifacts. The reviewed `cloud/seeds/profile.html` fixture and
`cloud/seeds/official.json` exercise structure mapping with fake values.
Change a value without changing its structure to verify the fingerprint remains
stable; change structure to verify stale responses are rejected.

Use real vault/DOM/storage implementations where feasible and fake owned adapters
at network/model boundaries. Avoid mocks that merely reproduce the implementation.
Restore environment and globals, isolate storage paths and stop browser/server
processes. Failed assertions must not leak fixture bodies through generic logs.
No paid AI call or live website is required for the unit suite.

## Browser and manual verification

Playwright runs development browser fixtures using the Node test runner. Built
extension tests cover actual panel/worker/content wiring, not only injected
in-memory adapters. Tier 1 and Tier 2 suites live in `tests/e2e/`; install Chromium
before running them. The separate `npm run e2e:extension-demo` Playwright Test suite
loads the built extension with a disposable encrypted vault and fake HTTPS fixture
pages. It exercises shared-schema resolution, structure mapping, Tier 3 approval
and decline, and wall hand-off against an HTTP mock of Cloud. It cannot establish
that deployed Cloud Run, Gemini, logging, Trace, Firestore or BigQuery behave as
configured; use the manual checks for those boundaries. Retained Electron E2E
suites are migration regression tools, not evidence of extension feature parity.

Manual release checks cover the actual Chrome permission UI, panel lifetime,
Cloud IAM/logging configuration and model availability. Use the checklist in
[manual-test.md](manual-test.md). Record build/commit, environment, observed result
and skipped cases in the Issue/PR. A green stub smoke is not end-to-end inference
success; an empty CI check list is not a passing run.

## CI and maintenance

Root CI checks formatting, lint, types, unit tests and dependency audit; Cloud CI
adds service tests, extension fixtures, Terraform validation, image build and
startup smoke. Main-only Cloud deployment additionally verifies privacy settings.
Use the workflow files as the source of exact triggers and commands.

Keep tests that protect a distinct boundary or regression. Remove redundant
implementation-mirroring tests when their behavior is covered at a stronger
boundary. Prefer a small integration test over many mocks, and do not add a new
test runner or external service for documentation verification.
