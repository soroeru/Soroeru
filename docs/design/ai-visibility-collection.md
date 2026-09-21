# AI-driven Visibility collection

Issue: #517
Status: implementation plan; no implementation in this commit.
Base: `11374e4` (includes #516 / PR #521).

## Goal and traceability

Implement the bounded, authenticated-page exploration and value-extraction loop in
[architecture §5.2](../architecture.md#52-collection-strategy), following
[requirements §7.1, §8 and REQ-013](../requirements.md) and
[security §5–7](../security.md). An authorized user with a configured provider gets
AI-driven collection first; other users retain deterministic collection.
The model proposes observations and navigation, while local code owns authority,
wall handling, budgets, validation, and all writes.

| Issue acceptance area | Design section | Verification |
| --- | --- | --- |
| Logged-in exploration and extraction | Components; observation contract | Multi-page fake-site run |
| Local navigation, budgets and walls | Navigation; budgets; transitions | Adversarial and boundary matrix |
| Corroboration before writing | Corroboration and persistence | Absent/stale/misclassified value cases |
| No browser tools; closed output | Model contract | Extra-key/action/ID rejection |
| All five fallback modes | Transitions | Fault injection per mode |
| Typed domain/vault writes | Corroboration and persistence | Writer spies and vault reload |
| Fixture measurement | Verification | Aggregate comparison report |
| Quality gates and status documentation | Delivery sequence | Required checks and doc review |

## Scope and non-scope

Add a separate raw-value collection path, wire its runner selection and safe
fallback, and emit in-memory page-purpose/field-location facts for #518.
Consume #516's `ai-assisted-discovery` Mandate/Capability types and explicit
`collectionTier: "ai-driven"` storage contract. This tier is neither permission
nor evidence that a value appeared on a page.

Do not implement SiteCollectionMap persistence/recollection (#518), Delegation
Boundary UI or understanding-check wording (#519), or provenance UI and broader
fallback product integration (#520). #517 still owns the minimal executable
runner fallback needed for its acceptance criteria. Do not change registration,
withdrawal, terms-analysis disclosure policy, provider choices, dependencies,
backend services, or browser migration policy.

## Current code and gaps

- `src/automation/ai-engine.ts` is a structure-only DecisionEngine consultant;
  it must not receive the new raw observation envelope.
- `visibility-runner.ts` constructs `PageExplorer` after login and delegates to
  `collectDuringExploration`. Its existing wall hand-off and current-page resume
  behavior must survive the new branch.
- `PageDriver` exposes separate `snapshot`, `readValues`, and optional
  `readDisplayValues` calls. Those separate reads alone cannot establish a stable
  page revision for corroboration. Its comments also predate the #514 exception.
- `electron/session.ts:refreshAiEngine` creates the existing AI engine from an
  environment-backed factory. Provider availability alone is not permission to
  transmit page values. There is no existing domain authorization service to reuse.
- `AiProvider.completeJson` returns `unknown`, accepts a maximum output token
  count, and has no cancellation or usage contract. Local response validation and
  request cancellation need explicit support; provider JSON schema is insufficient.
- `url-utils.ts:isSameSite` checks a domain suffix, not a public-suffix database.
  Reuse parsing/resolution/normalization, but do not describe this helper as proof
  of registrable-site identity or read-only behavior.

## Components and authority

Add `src/automation/ai-visibility-collector.ts` for the loop,
`ai-visibility-contract.ts` for bounded input/output validation and facts,
`visibility-navigation-policy.ts` for shared collection navigation checks, and
`visibility-corroboration.ts` for the pure observation-to-candidate validator.
Names are proposed new modules, not existing APIs.

The collector receives a narrowed observation/navigation adapter, a provider,
an authorization callback, a monotonic clock, an AbortSignal and a shared run
budget. It receives no vault, filesystem, credential store, fill or click API.
It produces locally verified candidates and typed stop/pause outcomes. The runner
owns hand-offs and calls a trusted writer using `DomainService.addDisclosure`,
`addEvidence`, `addConstraint`, and existing relationship APIs.

Proposed TypeScript contracts (implement with explicit discriminated unions):

```ts
type CollectionStop =
  | "complete" | "provider-error" | "invalid-response" | "ai-canceled"
  | "wall" | "budget" | "authorization-required" | "unknown-destination"
  | "user-canceled" | "session-invalid";
type NavigationDecision =
  | { kind: "allow"; targetId: string }
  | { kind: "confirm"; targetId: string }
  | { kind: "deny"; reason: string };
type CollectionAuthorization =
  | { kind: "denied" }
  | { kind: "granted"; siteAccountId: string; runId: string;
      mandateId: string; capabilityId: string; epoch: number };
```

Reasons are a closed enum in implementation, never model-provided prose.
A collector outcome carries the stop reason, counts, verified candidates,
value-free facts, and, for a wall, the existing `WallDetection` descriptor.
Raw candidates remain in memory until the runner writes or discards them.
No raw payload enters checkpoints, orchestration state or diagnostic records.

### Authorization and integration boundary

Add a small domain-facing authorization reader over the existing typed vault
records. It checks the exact `ai-assisted-discovery` operation, site scope,
current run/epoch and live cancellation state. L0 requires a current-run grant;
L1 requires that operation's capability and understanding check. A generic
`collection` mandate or a configured/environment provider never implies this
permission. The gate issuer binds each grant to the active run; the reader also
rechecks the underlying records so reduction or revocation takes effect before
any next read/send/navigation/write. Do not auto-create or promote grants.

Expose a typed authorization seam to `VisibilityService` and the runner for
#519 to supply. Missing issuer/grant defaults to deterministic collection and an
`authorization-required` reason, with no raw request. In #517, integration tests
and a fake-data development harness can supply real scoped test records/grants;
production raw-value activation remains gated until #519 supplies the user flow.
This is an explicit rollout boundary, not a bypass using the old AI toggle.
`electron/session.ts` owns provider construction and clears the new collector
factory on lock/configuration change alongside the old engine. Reuse the existing
provider factory rather than creating a second provider configuration source.

## Observation and model contracts

Add the following optional paired methods to `PageDriver`; a driver lacking
either method falls back deterministically. Implement both for the currently
supported adapters. These are proposed interfaces:

```ts
interface ObservationToken {
  bindingEpoch: number;
  documentId: string;
  revision: number;
  observationId: string;
}
type ObservationFreshness =
  | { kind: "current" }
  | { kind: "stale"; reason: "binding" | "document" | "revision" | "url" | "expired" }
  | { kind: "unavailable" };
// CollectionObservation is the bounded item/snapshot envelope described below.
// Its token is local metadata, never model-created authority.
interface CollectionObservationDriver {
  captureCollectionObservation(signal: AbortSignal): Promise<CollectionObservation>;
  checkCollectionObservation(token: ObservationToken,
    signal: AbortSignal): Promise<ObservationFreshness>;
}
```

The adapter owns `bindingEpoch`, incrementing it on bind/rebind, disconnect,
close and session invalidation; Electron also checks the run's cancellation
epoch independently. The isolated content-script context (or Playwright's
per-document injected context) owns a random `documentId` created on document
initialization, a monotonic revision and a bounded current-observation slot.
Full navigation/reload replaces that context even at the same URL. Invalidation
on pagehide/pageshow prevents a back-forward-cache restore from reviving a token.

Install a MutationObserver before capture, incrementing the revision for DOM
changes; drain pending records before capturing/checking. Scanner-owned marker
writes happen before the capture baseline. At check time, also re-read and
compare the bounded captured field properties, text and navigation items locally:
programmatic input-value changes may not produce a DOM mutation. Compare against
the browser context's retained observation, never a model-supplied copy. Missing
context/observation, a new document, changed live URL/items/revision or epoch all
fail closed. Keep only the current observation and clear it on invalidation or
release; do not persist either the values or their comparison representation.

The extension worker validates two narrow bridge commands, binds each to the
selected tab and current binding epoch, and asks the live isolated content script
for freshness. The extension adapter must not use its cached `currentUrl()` to
answer this check. The Playwright adapter executes the equivalent live-context
check and maps destroyed contexts to stale/unavailable. Both commands have local
deadlines and strict input/output validation. Read `extension/AGENTS.md` before
those changes.

Check freshness before sending the captured payload, after the provider returns,
and immediately before the synchronous candidate write batch. A stale result
discards the response; unavailable invalidates the session. Any recapture is a
new observation/call under the same budgets. This detects changes up to the live
check; it does not freeze the remote site. Writes retain their capture timestamp
and express an observation at that instant, not a claim that the page never
changes afterward.

One synchronous DOM observation produces a page revision/observation ID, current
URL, wall-detection snapshot, bounded visible text blocks, form/display value
items and navigation items. Use existing scanner logic for labels/locators.
Each value item has an opaque item ID, local locator, kind, label and value;
each navigation item has an opaque ID and locally retained resolved URL plus
path/query/element signals. Capture IDs and run epochs are local, never accepted
as model-created authority. Detect walls before capture and again on the captured
snapshot; a walled observation is never sent. Recheck the live revision and URL
before accepting a response; navigation, rebind or DOM revision change invalidates
it. Bound retries of unstable captures under the same budgets.

Send the serialized bounded observation's actual values and readable content,
not HTML/scripts, cookies, browser storage, canonical vault values or login
credentials supplied by Soroeru. Include site-displayed passwords, PAN and CVV
only through this path. Locally omit My Number/card-PIN items and ambiguous
identity-secret blocks before sending; they must never become stored candidates.
Exclude hidden token inputs. The exact included item table is retained only in
memory for this request. Payload truncation is deterministic and item-aligned;
items omitted to fit the budget cannot corroborate a response.

Closed output, with `additionalProperties: false` at every object level:

- `observationId`: exact request ID.
- `pagePurpose`: enum `profile | address | contact | billing | notification |
  security | other | unknown` (advisory only).
- `values`: bounded array of `{itemId, attributeKey, value, confidence}`. Keys
  must be existing known profile keys; confidence is finite in `[0,1]`. Do not
  let the model invent dynamic attributes, selectors or field locations.
- `nextTargetIds`: bounded array of opaque observed navigation IDs.
- `done`: boolean; local policy may stop earlier regardless of its value.

Implement an independent exact-key/type/enum/length validator on the returned
`unknown`. Reject extra keys, tools, actions, URLs, scripts, invented IDs,
non-finite confidence and oversized/duplicate/conflicting entries. No provider
request includes browser tools. Page content is explicitly untrusted data in
the instruction, but the validator and local policies are the enforcement.

## Corroboration and persistence

Bind each candidate to its own captured item and observation ID, not an arbitrary
substring anywhere on the page or a previous page. For fields/display items,
require the whole value to match. For text blocks, allow only a complete bounded
line/value span within the referenced block, never a substring inside another
value. Keep the span-to-item association local.

Use exact matching first. Permit only NFC, line-ending normalization and outer
whitespace trimming for ordinary text. For a locally classified phone/card
item, also permit ASCII spaces/hyphens to be removed; no digit synthesis, suffix
matching or masked-to-full conversion. Passwords and CVV require exact matching.
No case folding, transliteration or arbitrary punctuation stripping. Store the
captured observed value, not a newly fabricated or expanded model representation.
Pin these rules in table-driven tests. A masked PAN stays masked/unknown; it can
never corroborate a proposed full number.

Existence does not prove semantic ownership. Reject a known-key proposal that
contradicts strong local field metadata; mark ambiguous/conflicting mappings for
review rather than trusting confidence. My Number and card PIN restrictions
apply by local content/label classification even if mislabeled as another key.
Reject these instead of recording their value/hash in any candidate or Evidence.
This cannot prove that malicious site content is truthful; the ledger records
observations, not an attestation of identity.

Only corroborated known-key candidates reach `addDisclosure` with an explicitly
local `collectionTier: "ai-driven"`. Source URL, source kind and Evidence IDs
come from the observation, never from model output. Use a minimized safe URL
reference and fixed Evidence text; arbitrary paths/labels can themselves contain
PII and must not be copied into logs. Unsupported or uncorroborated values create
an `unknown-state` Constraint with a fixed reason, site and safe observation
reference; no proposed value/hash is persisted. Do not use `staleState: unknown`
as a substitute for rejecting fabricated values: staleness describes comparison
to a canonical value, not corroboration.

Preserve runner relationship extraction from actual snapshots; the new model
schema need not invent a parallel relationship language. Share run-local dedupe
by site/key/observed value/source, and retain #516's tier-aware domain dedupe.
A failed later step preserves already verified encrypted records. Check
cancellation/authorization immediately before each write. Let existing service
vault-save boundaries handle persistence; a vault failure is a surfaced storage
failure, not a provider failure or permission to repeat writes blindly.

Emit `CollectionFact` objects in memory for #518: observation ID, safe page
reference, locally checked purpose, known attribute key, observed locator kind/ID,
structural fingerprint and corroboration status. Never include raw values,
value-bearing selectors, prompt/response text or model-authored executable
selectors. Do not write `siteCollectionMap` records in this Issue.

## Navigation policy

Resolve observed links with `resolveHref`, parse absolute URLs, then enforce HTTPS,
no URL credentials, and the bound account-site scope before normalization/dedupe.
Default to the authenticated exact host; allow other hosts only when an existing
trusted binding explicitly establishes their same-site scope. Never infer a
registrable root by dropping labels or accept a public suffix as a site. This
conservative subset avoids adding a suffix dependency in #517; unknown sibling
hosts fail closed until trusted scope exists. Confirmation cannot relax site,
scheme, wall, active-control or action restrictions.

Deny action-like decoded path/query/element signals, including logout, delete,
withdraw, cancel, unsubscribe, confirm, submit, purchase and preference mutation.
Inspect original and bounded decoded forms before dropping fragments or any
query component; malformed/ambiguous encodings fail closed. Reject event-driven
controls, forms, downloads and buttons as discovery navigation. A GET URL or
model-assigned purpose does not establish read-only behavior.

Allow only a locally approved account-information page class backed by observed
link metadata and local rules. An otherwise safe unclassified target yields
`confirm`. Add an optional typed runner callback
`confirmDestination({siteAccountId, observationId, targetId, safeDisplay}) ->
Promise<"approved" | "rejected">`. Missing callback pauses/skips with a pending
Constraint; it must not silently approve. Approval binds to that exact target and
observation; reevaluate policy after approval. #519 owns its production UI.

Use this guard for AI navigation and the deterministic continuation of this run.
Check final URL/wall state after every navigation before capture/read/send/write;
an unexpected redirect invalidates the observation and triggers safe hand-off.
Current adapters do not guarantee prevention of every server-initiated redirect
request. Do not claim that post-navigation validation prevents that request:
where a transport cannot enforce a required pre-navigation restriction, keep the
AI path unavailable for that transition. Full browser migration remains outside
#517. Never use another browser/backend to evade a wall.

## Budgets and transitions

Defaults for a site run: 10 collected pages including the landing page, depth 3
(landing depth 0), 10 AI calls, 60,000 reserved token units and 120 seconds active
execution time; per-call deadline 20 seconds, output cap 2,048 tokens. These are
implementation defaults, independently injectable downward in tests. Carry one
ledger across retries, hand-offs and fallback; never reset it on tier switch.
Reserve one call and conservatively estimated serialized-input plus maximum
output tokens before sending. The initial dependency-free estimate uses UTF-8
bytes plus an explicit message-envelope allowance; document it as a conservative
local admission budget, not measured billing usage. Cap serialized input at 16 KiB
per call and response arrays at 100 values / 20 navigation IDs. Fail admission
when the reservation cannot fit; failed/timed-out calls are not refunded.

Extend provider options with optional AbortSignal and pass it through existing
adapters. Disable hidden retries for this path or account each transport attempt
against the same call ledger. Discard late responses after timeout/cancel/epoch
change. Do not await a hung provider indefinitely. Pause active-time accounting
while waiting for a human, with no calls or navigation during that pause; resume
only under the same valid session and remaining budget.

| Event | Immediate action | Deterministic continuation |
| --- | --- | --- |
| No provider or no AI authorization | No raw request | Existing rules-based collection |
| Provider failure/timeout/refusal | Disable AI for this run, fixed reason | Current safe page and remaining guarded queue |
| Invalid response | Discard entire malformed response, disable AI | Same as provider failure |
| AI-only cancellation | Abort call, discard pending response | Continue only if whole run remains authorized |
| User cancels entire run | Abort, no further reads/calls/writes/navigation | Deferred to a new explicit run, never automatic |
| Wall | Stop before raw read/send, existing same-session hand-off | After explicit resolve, inspect user's current page; no re-goto to wall URL |
| AI call/token budget exhausted | Disable AI | Remaining page/depth/time allowance only |
| Shared page/depth/time budget exhausted | End bounded exploration | No new navigation; report partial/unknown with deterministic tier available on a later explicit run |
| Unknown target | Await bounded typed confirmation or keep pending | Cannot let deterministic fallback navigate around the pending decision |
| Lease invalid, lock, permission revoked | Abort and discard transient values | Requires rebind/unlock/revalidation; no automatic new session |

For fallback use `DecisionEngine(new RuleEngine())` without the optional AiEngine,
plus the existing collector. Adapt PageExplorer to accept shared budget/visited/
blocked state and the guard rather than restarting a fresh unrestricted run.
Do not re-enable AI on a fallback page. Keep verified counts across the switch;
empty/partial outcomes must not be reported as complete collection. Preserve
#420's current-page resume and #421's repeated-wall stopping/saved-page guidance.
ToS prohibition on any observed page creates a pending Constraint and waits for
the user's decision; a wall remains non-bypassable even after a ToS approval.

## Verification

Use fake values and injected providers only. Extend existing runner, explorer,
collection, provider and VisibilityService unit suites; add contract,
corroboration and navigation-policy suites. Follow the repository
`writing-good-tests` skill when implementing tests. Test behavior at observable
boundaries instead of mirroring private helpers.

- Two authenticated fake pages produce known-key Disclosures through domain APIs;
  provider input contains only this page's allowed values, never canonical vault
  values. AI unavailable/denied sends no raw request. Existing AiEngine and
  registration/terms tests continue to assert structure-only behavior.
- Exact/normalized match, absent value, wrong item, previous page, truncated item,
  changed revision, contradictory classification, malicious instruction text,
  masked PAN expansion, duplicate/conflicting values, PIN/My Number mislabeling.
  Assert no confident Disclosure or raw candidate/hash for rejected observations.
- Extra keys at every nesting level, invented URLs/selectors/IDs, script/actions,
  oversize response and invalid enums/types. Assert providers expose no tools.
- HTTPS, userinfo, relative and protocol-relative URLs, lookalike hosts, public
  suffixes, sibling hosts without binding, redirects, encoded action paths/query,
  Japanese action labels, unknown target approved/rejected/missing callback.
- Each budget at limit minus one, exact limit and plus one; hidden retry attempts,
  timer expiration, pending human hand-off, fallback not resetting counters,
  cancellation/revocation at every await boundary and late model response.
- Each failure row above with a fake driver spy: safe continuation where allowed,
  zero navigation through an unresolved wall/cancel/pending target, same current
  page on resume, no tier-switch duplicate writes or falsely complete outcome.
- Typed domain/vault reload retains AI PAN/CVV behavior from #516; deterministic
  fallback retains last-4/CVV exclusion. Logs, errors, checkpoints, fact output
  and fixtures' aggregate measurements contain no sentinel raw values.
- Fake adapter/bridge tests verify atomic observation, selected-tab isolation,
  disconnect behavior and response validation. Explicitly test same-URL reload,
  binding replacement, back-forward-cache restore, DOM mutation and programmatic
  field-value changes during a pending provider request, including a cached
  adapter URL that has not changed. Assert no stale response is written.
  Manual fake-site checks cover the
  headed wall hand-off/resume, unknown destination gate, abort and provider outage.
  Never use the user's real CSV, credentials or a live provider for these tests.

For architecture §11, use fixed labelled fixture observations for profile,
address, phone, card, newsletter, billing, MFA and ToS. Run deterministic and
scripted AI variants over the same ground truth. Report counts and denominators:
correct accepted mappings / expected collectable items; incorrect accepted
mappings / all accepted mappings (N/A if none); unresolved expected items /
expected items; and correct hand-offs / wall cases. Include intentional wrong
model proposals to measure false acceptance. These are reproducible safety and
integration measurements, not a claim about live model accuracy. Persist only
fixture IDs, aggregate counts and reason codes.

## Delivery sequence and affected files

1. Add contracts, authorization reader/seam, cancellation support and bounded
   observation adapter. Expected edits: `src/automation/page-driver.ts`, browser
   and extension adapters, scanner reuse, `extension/worker.ts` and
   `extension/content-script.ts`, `src/agent/ai/provider.ts`, domain authorization
   module. Read closer AGENTS instructions before editing each area.
2. Add navigation guard, shared budget, strict validator and corroboration;
   implement the new collector and trusted domain writer with unit coverage.
3. Wire `src/automation/visibility-runner.ts`, `page-explorer.ts`,
   `disclosure-collector.ts`, `electron/visibility-service.ts` and
   `electron/session.ts`. Add failure/authorization/integration coverage.
4. Record fixture measurements; update architecture §5.2/§10 status only for
   implemented scope, security implementation-status text, relevant manual checks
   and user documentation for observable behavior. Keep #518/#519/#520 pending
   work explicit and run the matching architecture-review skill for that edit.
5. Use Node from `.nvmrc`, `npm ci`, then `npm run format`, `npm run lint`,
   `npm run typecheck`, `npm test`, and `npm run release:check`. Complete applicable
   fake-site checks in `docs/manual-test.md`. Report any unavailable manual surface.

This planner commit changes only this document. Implementation quality gates
above are for the implementer; this commit needs Markdown/link/traceability review
and the repository design-doc review, not application tests.

## Alternatives, risks and open questions

- Extending AiEngine would mix raw and structural contracts; a separate collector
  makes the sole raw-value exception auditable. Reuse transport, not payloads.
- Whole-page substring corroboration is simpler but lets unrelated text justify
  invented values. Item-bound comparison trades some recall for integrity.
- Accepting arbitrary model URLs or executing clicks would exceed the read-only
  proposal contract. Opaque observed IDs leave execution under local authority.
- Persistent facts/maps now would overlap #518; an in-memory typed fact stream is
  sufficient and adds no storage migration.
- Starting AI solely because a provider is present would bypass the mandatory
  raw-value gate. Fail closed until #519's grant issuer is wired, with injectable
  authorization for #517 verification.
- Conservative exact-host scope and normalization can increase unknown rates.
  Record these in fixture results; do not widen policy to improve headline recall.
- Capturing a value does not certify that the site itself tells the truth.
  Corroboration prevents unsupported model fabrication, not malicious-site fraud.
- Browser navigation is not inherently read-only and redirect prevention varies
  by adapter. Verify support before enabling guarded transitions; residual
  transport limitations must be stated in the implementation review.

No product decision is needed to start the implementation. #519 must consume the
explicit authorization/confirmation contracts before production raw-value
activation; #518 consumes facts; #520 owns user-facing provenance and subsequent
fallback improvements. These integration boundaries are deliberate dependencies,
not authorization to implement the follow-up Issues here.
