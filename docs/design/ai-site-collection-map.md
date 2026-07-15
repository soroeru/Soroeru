# AI Site Collection Map

Issue: #381

## Goal and scope

Visibility needs to find account data beyond pages and labels known to the rule engine. Add a
low-frequency AI-assisted discovery phase that produces a versioned **Site Collection Map**, then
perform repeatable deterministic collection without AI. This design covers discovery, encrypted
map persistence, mapped collection, stale-map handling, and notification of observed security
settings. It does not implement the design, change site settings, automate passkeys, or relax any
wall, payment, attestation, withdrawal, or confirmation boundary.

The design extends `PageDriver`; it does not choose Playwright or a Chrome extension as the primary
driver. Issue #391 must prove that an extension satisfies the same fixed invariants.

## AI scope decision and alternatives

Three levels were considered: (a) one structure-to-plan call with deterministic execution, (b) a
bounded observe/propose loop whose every step is locally validated and executed, and (c) autonomous
browser control. Choose **(b) for read-only discovery** and **(a) for every operation that changes
external state**. (a) alone lacks multi-page reach; (c) gives untrusted DOM excessive authority and
is difficult to inspect. The model never receives a general browser tool: it may select one opaque
link ID present in the sanitized snapshot or return typed map candidates. Filling, submit, terms
acceptance, card entry, and irreversible actions remain deterministic with existing gates.

AI is optional. Without a configured provider, deterministic exploration remains the default. A
previously generated map remains usable without AI. This selective architecture provides a
predictable, reassuring fallback without weakening Soroeru's agency principles. Only the user's
configured Anthropic/OpenAI provider is supported; CLI providers and MCP are not application paths.

## Trust boundary and data flow

```text
PageDriver.snapshotStructure() -> StructuralSanitizer -> AiPageSnapshot -> AI
                                                              |
                                         closed-schema proposal
                                                              v
PageDriver.navigate() <- local policy/existence/wall validator

PageDriver.readMappedValue() -> local reduction -> encrypted Disclosure + Evidence
```

Structure snapshotting and `readValues`/mapped-value reads are separate capabilities. The AI adapter
accepts only branded `StructuralSanitizer` output, never raw DOM, raw `PageSnapshot`, or value-read
results. The sanitizer allow-lists tag, role/type, generated opaque ID, `name`, `id`, `autocomplete`,
label, placeholder, bounded nearby static text, headings, and normalized origin/path. It removes
values, prefills/defaults/selections, cookies, tokens, query/fragment, hidden fields, script/style,
URLs in text, canonical/collected values, and likely email/phone/postal/card/account patterns.
Ambiguous text is omitted.

DOM text is untrusted data, never instruction. Strict JSON-schema decoding rejects unknown keys;
proposals reference only opaque IDs supplied in the snapshot. Local validation enforces existence,
same-site HTTPS, read-only navigation, budgets, and wall state. The model cannot invent a URL,
selector, script, keyboard sequence, value read, or free-form action.

## Map contracts

```ts
type CollectionItemKind =
  | "personal-attribute"
  | "security-setting"
  | "notification-setting"
  | "privacy-setting"
  | "linked-service"
  | "balance-or-points"
  | "card-last4";

type LocatorHint =
  | { kind: "stable-css"; selector: string }
  | { kind: "label-nearby"; labelFingerprint: string; occurrence: number }
  | { kind: "structural-path"; landmarks: string[]; role: string; occurrence: number };

interface SiteCollectionMap {
  schemaVersion: 1;
  siteKey: string; // canonical origin, never an account identifier
  generatedAt: string;
  generatedBy: "ai" | "deterministic" | "manual";
  generatorVersion: string;
  status: "complete" | "partial" | "stale";
  pages: Array<{
    normalizedUrl: string;
    pageFingerprint: string;
    entries: CollectionMapEntry[];
  }>;
  discoveryEvidenceId: string;
}

interface CollectionMapEntry {
  entryId: string;
  kind: CollectionItemKind;
  attributeKey: string;
  displayLabel: string;
  locatorHints: LocatorHint[];
  valueShape: "text" | "boolean" | "enum" | "money" | "points" | "last4" | "presence";
  sensitivity: "normal" | "sensitive" | "most-sensitive";
  confidence: number;
  provenance: "ai" | "deterministic" | "manual";
}
```

Reject dynamic/value-dependent selectors and cross-origin references. Prefer a semantic hint; an
entry with no safe locator remains a review candidate, not executable map data. Reduce cards to
last4 before persistence; never read CVV. Balances/points are observations, not canonical
attributes, so they do not participate in Personal Attribute stale comparison.

Security settings use namespaced keys such as `security.passkey.configured`. An observed “not
configured” creates a ledger observation and one non-blocking, dismissible **Review task** with its
Evidence and page link. It is not a Constraint, makes no recommendation, and never changes the
setting. Reflection may later summarize it; Policy promotion remains unchanged.

## Bounded discovery and failures

```text
idle -> snapshotting -> sanitizing -> consulting -> validating -> navigating -> snapshotting
                              |             |              |
                           partial       partial       wall-paused
active -> complete | partial | cancelled | budget-exhausted
wall-paused -> snapshotting (same headed session after human completion) | cancelled
```

One step performs snapshot, sanitize, consult, validate, then at most one navigation. Defaults:
12 pages, depth 4, 20 AI calls, 50,000 input tokens, and 90 seconds per site; never revisit the same
normalized URL plus structure fingerprint. Navigation is HTTPS, same registrable site, GET/read-
only, and selected from current links. Reject identity/payment/download/logout/delete/submit and
mutation routes.

Wall detection runs before sanitization and navigation. CAPTCHA, MFA/OTP, passkey, identity
verification, bot detection, and rate limits enter `wall-paused` and are never AI problems to
solve. Provider timeout, invalid output, or exhausted budget produces a partial map and uses
deterministic discovery where possible. Cancellation atomically saves only validated entries as
`partial`, with minimized Evidence recording the terminal reason.

## Deterministic collection, persistence, and staleness

The driver navigates mapped pages locally, checks walls, fingerprints structure, resolves locator
hints in order, and reads values locally. Evidence contains map/page/entry IDs, timestamp, outcome,
and hashes—not HTML, screenshots, prompts, cookies, or raw values.

A missing page, fingerprint mismatch plus failed semantic locator, ambiguous match, or shape
mismatch marks only that entry stale. Continue independent entries, fall back to existing
deterministic exploration for failures, and propose regeneration after the run. Never start AI
regeneration automatically; the user starts it. Atomically activate a successful replacement and
retain prior encrypted audit history under normal retention.

Maps are encrypted local candidate definitions. Sharing is off by default and later requires
explicit opt-in plus preview and sanitization removing account IDs, values, noncanonical URLs,
Evidence references, precise session timestamps, and user-derived fingerprints.

## Nintendo acceptance trace

| Page                   | Mapped items                                                      | Local result                                                      |
| ---------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------- |
| マイページ             | name, country/region, time zone                                   | encrypted personal-attribute/enum Disclosures                     |
| ログインとセキュリティ | login method, passkey, phone, 2FA                                 | configured/unconfigured observations; unset security Review tasks |
| 残高とお支払い方法     | card-last4, points/balance                                        | last4 reduction, CVV never read, balance-or-points observation    |
| プライバシー           | friend recommendation, notices, survey, linked-service permission | boolean/enum notification, privacy, linked-service observations   |

No Nintendo HTML or values enter the repository. Acceptance uses sanitized synthetic structures
and PO-run manual verification in the real headed session.

## Verification

- Unit: sanitizer allow-list/adversarial PII corpus, schema/existence/site/read-only validation,
  budgets, locator resolution, last4 reduction, CVV exclusion.
- Property/fuzz: arbitrary DOM text cannot create a free-form action or value in an AI payload.
- Fake provider/driver integration: bounded map generation, partial atomic save, provider failure,
  cancellation, stale-entry fallback, and wall resume.
- Persistence/UI: encrypted migration/atomic activation; no plaintext diagnostics; informative,
  dismissible unset-security task; explicit regeneration; usable deterministic-only mode.
- Manual: the four Nintendo pages, provider-payload inspection for no PII, and permitted egress.
  Captures and real data are never committed.

## Implementation Issue split

1. **Sanitizer and typed contracts** (no dependency): branded snapshot/proposal types,
   adversarial tests, and PageDriver structure/value split.
2. **Encrypted map persistence** (depends on 1): schema migration, atomic activation, Evidence,
   sharing sanitizer (export remains disabled).
3. **Bounded discovery engine** (depends on 1–2): state machine, budgets, validator, walls,
   cancellation, fake-provider tests.
4. **Deterministic mapped collector** (depends on 1–2): locators, per-entry staleness, fallback,
   ledger writes, card/CVV rules.
5. **Review-task and regeneration UX** (depends on 3–4): unset-security notification, partial/
   stale status, explicit regeneration, deterministic-only experience.
6. **Extension capability proof / #391** (depends on 1; parallel with 2): prove the extension
   meets the same sanitizer, navigation, wall, and local-value invariants.
7. **Acceptance/measurement** (depends on 3–6): sanitized fixtures, PO Nintendo scenario,
   coverage/mis-mapping/cost measures, release Evidence.

Capability constraints may narrow behavior but never weaken sanitizer or action validation.
