# Requirements

This document owns the **product requirements** for **Soroeru**: the product's reason for
being, success definition, domain ontology, delegation model, agency loop, scope, and
non-negotiable requirements.

This document is the **canonical product direction**.
Out of scope here: application architecture and technology selection (see
[`architecture.md`](architecture.md)), security rationale (see [`security.md`](security.md)),
and agent operating rules (see `../AGENTS.md` and `../CLAUDE.md`).

> **Soroeru（揃える）** is a **local-first agency engine**: a tool through which a user
> *acquires their own free will* (agency) in the domain of personal information, online
> accounts, and online contractual relationships. It is not an "autonomous form-filling
> agent" or a "desktop-wrapped web app."
>
> The **repository / codebase identifier is `soroeru`**; **Soroeru** is the product name.
> Technology selection is deliberately **not** fixed here — it is decided ground-up,
> requirements-first, in [`architecture.md`](architecture.md).

## 1. Background & North Star

### 1.1 The problem: formal vs. practical choosability

For most people today, the following are *formally* possible but *practically* impossible —
too tedious, too complex, too time-consuming, impossible to remember:

- knowing which services hold which pieces of their personal information;
- reflecting an address / phone / card change across every service;
- withdrawing from unused services and reducing dormant accounts;
- comparing each site's terms / privacy policy to make a disclosure decision;
- carrying out a consistent personal policy for "how I want my data treated."

The choice exists on paper, but not in practice. Soroeru's job is to convert this
**formal choosability into practical choosability**.

### 1.2 North Star

> Soroeru is a **local-first agency engine** for the domain of online personal information,
> accounts, and contractual relationships — a domain too complex for a person to exercise
> free will in alone. It helps the user turn formal choosability into practical
> choosability and, through that, **acquire free will (agency) in this domain over time**.

### 1.3 Three lenses

- **capability-first**: make previously impossible actions possible;
- **sovereignty-first**: let the user govern their own information and approvals;
- **agency-acquisition-first (the center)**: through both of the above, let the user
  *acquire the free will itself* in this domain.

### 1.4 Name and metaphor

**Soroeru（揃える）** means "to bring into alignment / to arrange." The aspiration: as users
worldwide use Soroeru, their scattered personal information becomes "揃う" (aligned). This is
realized as **the sum of each user aligning their own scattered data locally** — there is no
central aggregation of users' personal information (consistent with local-first / no hosted
vault / no raw-personal-data telemetry). Non-personal knowledge about sites and forms (shared
Form Schemas, §8) may be shared centrally so that every user's alignment gets easier.

- Scope cue: **A Visibility = arrange / see; B Bulk Update = align (old → current)**.
- Tagline: **「あなたの情報を、あなたの手に。」** ("Your information, in your hands.")
- The *依代* (yorishiro — a vessel in which the user's will resides and acts on the world)
  framing is kept as an **internal design philosophy only**; it is not surfaced to users.
  The philosophy shows through the quality of the UX, not the copy.

## 2. Product Principles

- **Never become a delegation of will.** The failure mode is "it did it for me"
  (outsourcing the user's agency). The success mode is "I can do this." Soroeru is not a
  tool that executes a finished will; it is an **environment in which the will is formed**.
- **Separate toil from judgment.** *Toil* (filling forms, navigating sites, manually
  propagating changes) may be fully automated. *Judgment* (what to disclose, to whom, under
  what terms, when to revoke) stays with the user and is grown through repetition.
- **Graduation / independence is success.** The goal is that, over time, the user can decide
  *even when Soroeru's prompting is faint*. Dependence should go down, not up.
- **Default → understanding → self-selection.** Settings start at safe defaults; through
  concise, low-frequency, repeated suggestions the user comes to understand each option's
  meaning naturally and chooses it deliberately.
- **Local-first and user-owned.** Personal data is stored locally and encrypted; the user
  owns it. No hosted vault and no telemetry containing personal data. Shared, non-personal
  form knowledge and typed operational telemetry exist only to make form resolution more
  accurate for everyone (§8, Issue #554).
- **Restore sovereignty, don't break in.** What Soroeru sets out to break is the asymmetry
  that keeps personal data out of the user's reach — enclosing ToS, dark patterns, and the
  friction of cancellation / deletion / cross-site reconciliation. It does this from **inside
  the user's own authenticated sessions, on the user's own accounts**. The boundary is **not**
  "the ToS forbids automation" (that prohibition is precisely the gray Soroeru contests on the
  user's behalf, surfaced as a Constraint for the user to decide); the inviolable line is the
  **circumvention of actively-enforced technical access controls** (see §8) — the criminal
  line under unauthorized-access law (Japan 不正アクセス禁止法 / US CFAA). Soroeru never crosses
  it: it detects and hands off. *We don't break locks; we help you walk out with your own
  things.*
- **Verified identity, user-governed disclosure.** Canonical identity attributes (legal name,
  residence address, date of birth, sex) are established by the user's own public personal
  authentication (My Number Card / JPKI) and are **not hand-editable**; Soroeru stores verified
  real data, not fabricated or pseudonymous values. Sovereignty is preserved as the **right to
  choose which verified attributes to disclose to which site** — not as the freedom to fabricate.
  See §4.2; full requirement in Issue #218.

## 3. Success Metrics

The primary metric is **not** "number of actions automated." Quantitative success metrics
are computed only from local vault / Evidence events and shown only to the user; Soroeru
does not send the local events behind these metrics to telemetry or external analytics (the
form-resolution outcome telemetry in §8 is a separate, typed operational signal and is never
used to compute these metrics). Goals that cannot be
observed locally are excluded from this table rather than approximated. In particular,
Soroeru does not infer "subjective agency" or "approval without understanding" as automated
metrics. Unless a row states otherwise, counts and rates are evaluated per local user over
the six-month target window.

| Metric | Local observation definition | Direction |
| --- | --- | --- |
| High-risk-clause caution signal | Count distinct new-registration gates where Soroeru surfaced one or more high-risk clauses and the user chose `do not register` after seeing the high-risk summary or details. Three or more stopped registrations indicate success. | ↑ |
| High-risk-clause detail engagement | High-risk clauses are first shown as short summaries, with a `Details` button beside each clause. Count local `Details` click events; repeated clicks are counted because the specified signal is click count. More than five clicks indicate success. Each detail view explains the concrete risk trigger, such as an auto-renewal date, arbitration waiver, third-party sharing, or content-license scope. | ↑ |
| Default self-selection rate | For Policy options shown to the user, count the share the user explicitly re-chooses or changes from the safe default, using local Policy / Preference events. | ↑ |
| Practical choosability rate | For locally recorded intended decisions (withdraw / update / refuse), count the share that reaches completion or an explicit user-chosen stop, rather than being blocked by missing data, site errors, walls, or unknown flows. | ↑ |
| Disclosure visibility coverage | For imported Site Accounts, count the share that has either collected Disclosure rows or an explicit `not collected` reason in the ledger, so unknown holdings are not silently treated as checked. | ↑ |

Six-month target state: the high-risk-clause caution signal and detail engagement thresholds
are reached, and Policy options show an increased explicit re-choice / change rate from
safe defaults.

## 4. Domain Ontology

| Concept | Tier | Role |
| --- | --- | --- |
| Personal Attribute | MVP-required | The user's **canonical value** (the single source of truth; one set). The **basic-4 identity attributes** (legal name, residence address, DOB, sex) are JPKI-sourced and **non-editable** (see §4.2); other attributes are user-managed. |
| Site Account | MVP-required | The per-site login / ongoing-relationship anchor (seeded from the CSV: name/url/username/password/note). |
| Disclosure | MVP-required, core | "Which attribute was disclosed to which site, and when" (an attribute×site edge + as-of). **Stale = Disclosure.value ≠ Personal Attribute.canonical.** |
| Account Relationship | MVP-required | Ongoing relationship: newsletter-subscription state / recurring-billing state / last-used time. Powers the filtered lists. |
| Constraint | MVP-required | Site / terms / technical walls (automation-prohibiting ToS, MFA wall hit, etc.). |
| Reflection | MVP-required | The two layers (initial footprint + post-action change). |
| Delegation Boundary | MVP-required | The L0/L1 and absolute-boundary state. |
| Capability / Unlock state | MVP-required | Per-operation unlock tier (L0/L1) + internalization signals. |
| Mandate | MVP-required (light) | A record of what the user authorized (collection counts as an authorized action). |
| Evidence / Audit | MVP-required (light) | Audit log of what happened — references + hashes, not duplicated raw values. |
| Identity Verification | MVP-required | The result of My Number Card (JPKI) verification: verified basic-4 attributes + verification Evidence (cert serial/hash, issuer, timestamp). Never stores the 12-digit My Number or the card PIN (see §4.2 / [`security.md`](security.md) §14). |
| Policy | MVP (from defaults) | An articulated norm (want / refuse). Starts at safe defaults; reaches self-selection via repeated suggestions. |
| Preference | MVP-light | A situational tendency (pre-norm). Material for suggestions; promotes to Policy through repetition. |
| Option | Derived (non-persistent) | "A newly appeared choice" — e.g., the filtered lists; a computed presentation concept, not a stored entity. |
| Change Set | Later (B slice) | The diff plan for bulk update. |
| Workflow | Later / implementation | Multi-step orchestration; not fixed as a domain concept. |

### 4.1 Why Site Account and Disclosure are separate

- **Storage / concept are separated**: Personal Attribute (canonical, one set) / Site Account
  (login & relationship) / Disclosure (the value a given site currently holds + as-of).
- **Presentation is composed**: opening a Site Account shows its child Disclosures inline,
  e.g. "phone 🔴 stale / address 🟢 current / card 🔴 stale." The desired per-site view is a
  projection over Disclosures.
- Detecting "stale" *requires comparing two values* — the canonical Personal Attribute vs.
  the value a site holds (the Disclosure). The site-held value belongs in the encrypted
  Disclosure row, not directly in Site Account; the normalized hash stays available for
  comparison and audit without displaying the value.
- Payoffs: (1) sites collect different fields → `(account, attribute, value, as-of)` rows
  stay flexible; (2) bulk update (B) becomes first-class via a cross-site query
  "attribute = X and value ≠ canonical"; (3) Disclosure values are shown plainly by
  default, with reveal gated behind passphrase re-authentication only for
  sensitive/most-sensitive values (card data, the site password), and hash-only Evidence
  keeps user confirmation and audit concerns separate.

### 4.2 Identity Verification and canonical identity (My Number / JPKI)

Soroeru anchors canonical identity in the user's own **public personal authentication**
(マイナンバーカード / JPKI), so that the data the user manages — and propagates across sites —
is verified real data rather than free-form text. Full requirement and rationale: **Issue
#218**.

- **First-launch gate.** Verification via the My Number Card (公的個人認証 / JPKI) is required
  before any use, including A Visibility (an onboarding "slice 0").
- **Basic-4 are canonical and non-editable.** Legal name, residence (住民票) address, date of
  birth, and sex are taken **only** from the card and cannot be hand-edited. Address changes
  only by re-reading an updated card (after a 転居 filing); v1 keeps the 住民票 address only — a
  separate mailing address is a known limitation.
- **Derived fields are editable but unverified.** Kana (read from the card face when present,
  else user-entered) and romaji (always user-entered) are marked "derived from the verified
  legal name, unverified" and checked for consistency with the kanji original.
- **Phone / email require ownership verification.** Adding or changing a phone number or email
  requires an OTP ownership check; at most **3** of each may be stored. Removing a verified
  contact is deletion of Soroeru-internal data — the **fourth absolute boundary** (always
  confirmed).
- **Sovereignty as disclosure choice (link to the agency thesis).** Only verified real data is
  stored; agency is the user's choice of *which verified attributes to disclose to which site*.
  Fabricated / pseudonymous values are intentionally not supported.
- **Scope (R1): user-side only for now.** Soroeru helps the user manage verified real data. The
  *site-side* benefit — sites trusting Soroeru registrations as identity-verified, so fake
  accounts fall (the second sense of "揃える") — is **deferred**: delivering a verification the
  site can check requires a verifiable credential plus site adoption, which conflicts with the
  no-hosted-service / local-first principles. Recorded as future direction, not built in the MVP.
- **Authentication mechanism.** Verification is mediated by the Digital Agency's
  デジタル認証アプリ, via a narrowly-scoped identity-auth broker that is a scoped exception to
  the no-backend principle (see [`architecture.md`](architecture.md) §9 for the integration
  mechanism and connection architecture).
- **My Number / JPKI handling, assurance level, and legal constraints**: see
  [`security.md`](security.md) §14.

## 5. Delegation Boundary

The failure modes are symmetric: too strong → the user depends on Soroeru; too weak → the
user, as before, can do nothing. Soroeru must stand **between delegation, education, and
governance.** Only *toil* (execution) is delegated; *judgment* is not.

- **Delegation levels**:
  - **L0 confirm-required** — each execution is shown at the gate for the user to approve
    (default for new users / high-risk operations).
  - **L1 in-policy automatic** — actions within the user's Policy run automatically;
    deviations, unknowns, and high-risk items are confirmed (the MVP's main mode).
  - **L2 fully automatic** — **out of scope for the MVP** (closest to delegation of will;
    against the graduation principle).
- **Default is L0.** L1 is opened **per operation type** (visibility / update / withdrawal /
  registration), only for the range where the user has shown understanding.
- **Asymmetry**: expansion (L0 → L1) is **user-initiated and gated by a light understanding
  check**; reduction is **unconditional and immediate** (the right to disengage is always
  guaranteed). No implicit expansion from "enough successful runs."
- **Light understanding check for L0 → L1 expansion**:
  - The check is shown per operation type and range before L1 is enabled. It must name the
    concrete operation being expanded (for example, "collect registered information from
    imported sites" or "update selected stale addresses") and the exact scope that would run
    without the per-run L0 gate.
  - In the MVP, the user must answer with fixed selectable options whose correct option IDs
    are defined by the check-content version. The options must cover both:
    1. **what becomes automatic** at L1 for this operation type; and
    2. **what still stops for confirmation**: deviations from Policy, unknowns, high-risk
       items / Constraints, walls (CAPTCHA / MFA / verification), the absolute boundaries, and
       any action outside the named operation range.
    Free-text restatement is out of scope for the MVP; if added later, it must not enable L1
    unless a deterministic rubric or explicit human confirmation defines the pass/fail result.
  - The user must also be shown that reduction back to L0 is immediate and unconditional.
  - Passing requires correct answers to the "automatic" and "still confirmed" parts. If either
    answer is wrong or skipped, L1 is not enabled; Soroeru shows the missed point in plain
    language and lets the user retry from L0. Failed attempts are not treated as consent.
  - After the same L0 gate for the same operation type has been approved at least five times
    without hitting any "still stops for confirmation" condition, Soroeru may offer a "skip this
    gate next time" checkbox. Checking it is only a user-initiated request to start this
    understanding check; it does not enable L1 until the check is passed.
  - Soroeru records the passed check-content version, operation type, scope, timestamp, and the
    selected answer option IDs (or hashes of answer IDs) as Evidence, preserving the
    reference+hash-only Evidence rule. Any later retained free-text answer content must be stored
    only as encrypted vault content and referenced from Evidence by hash.
  - The pass is invalidated and the check is required again if any item changes in what becomes
    automatic, what still stops for confirmation, the named operation range, or the
    absolute-boundary wording.
- **Absolute boundaries (always confirmed, even at L1)**:
  1. high-risk clauses (auto-renewing subscription, mandatory arbitration, third-party
     data sharing/sale, content licenses, …);
  2. payment (stop / hand off; the only exception is free-trial→subscription, card filled
     only on explicit approval);
  3. eligibility / identity attestation — statements of *eligibility or identity* ("I am
     18+", residency, "I am authorized") are never auto-checked; a statement of the user's own
     *intent to act* (e.g. "I want to cancel"), already approved at the gate, may be
     auto-checked;
  4. **deletion of data stored inside Soroeru** (an irreversible destruction of the user's
     own source of truth);
  5. **a site withdrawal's final, irreversible confirmation step** — shown at the gate for
     explicit approval regardless of the site's ToS-automation stance, because it cannot be
     undone once submitted.
- **Explicitly *not* absolute boundaries**: withdrawing from a site (the flow itself —
  navigating to the cancellation page, filling the form — may run immediately within the
  delegated range, up to but excluding boundary 5 above); a first-seen site (the three
  guards suffice; it is an automation target).

## 6. The Agency Loop

- **Reflection (two layers)**:
  1. *Initial footprint reflection* — the whole picture of "what was given, where, and
     when," with initial excess / stale / risky / unused tags. This is the starting point of
     agency.
  2. *Post-action reflection* — after each B/C action, record "how the world changed (e.g.,
     removed phone number from 3 sites) + what to notice next."
- **Progressive disclosure**: ① see (read-only) → ② act on one thing (single site / single
  field) → ③ act in bulk (B/C).
- **Threshold ("suddenly I can")**:
  - The first crossing is the **initial ledger completion** — seeing one's whole footprint
    at a glance (the scattered self becomes "揃う").
  - Plus **filtered lists**: "sites with an active newsletter subscription" and "sites with
    active recurring billing." These make previously-too-tedious actions — stopping
    unwanted newsletters, cancelling unused subscriptions — suddenly doable.
- **Policy / Preference formation** (not desk-configured; raised from reactions to the
  ledger):
  - **Suggestion threshold**: the same Preference observed **3 times** consistently (a
    contradicting action resets the count). **Frequency cap: at most one suggestion of the
    same kind per day.**
  - **Promotion to Policy**: **never automatic.** After a suggestion is shown and the user
    accepts it, or repeats the same action once more after seeing it, Soroeru asks once,
    "Make this a policy?" Demotion / editing is always available.
  - These thresholds (3 observations / at most one suggestion of the same kind per day) are
    configurable defaults; the default→self-selection principle applies to them too.

## 7. Scope & Slice Order

Implementation order: **A Visibility → B Bulk Update → C Withdrawal cleanup → D New
registration (last).**

### 7.1 First slice — A Visibility (building the ledger)

- **Seed data**: the CSV exported from Google / Chrome Password Manager
  (`name, url, username, password, note`).
- **Flow**: import the CSV → **auto-log in** to each site → **collect** the registered
  personal information → build the **Disclosure ledger**.
- **Rationale**: most users already have accounts on many sites, and which sites they
  registered on is knowable from the Password Manager. Visibility is the epistemic
  precondition for agency, and the ledger has substance from the start (CSV + collection)
  rather than being empty.
- Auto-login is expected to hit MFA / CAPTCHA walls (detect → hand off; never bypass).
- **Delegation**: default **L0** for the first collection run; **L1** may be opened for
  "collect registered information from imported sites" once the user understands what is
  collected and where it is stored (per the general Delegation Boundary model, §5). L1
  never bypasses walls or silently proceeds past an automation-prohibiting ToS Constraint.

### 7.2 Locale

- Japanese-language sites only for now (multi-locale is later).

### 7.3 Existing assets

- Requirements are primary; technology follows requirements. Existing implementation assets
  may be reused **if they fit** the new requirements. Where they do not, **discarding all
  existing assets and re-selecting technology ground-up is permitted** (no asset lock-in).

## 8. Non-Negotiable Requirements (Security / Privacy / Safety)

- Local-first / locally encrypted, user-owned / no hosted personal-data vault / no telemetry
  that contains personal data. Personal values are stored only in the user's local encrypted
  vault; Soroeru-operated cloud services never store them (Issue #554).
- **Network egress is limited to**: (1) the target sites the user acts on; (2) **Soroeru
  Cloud** — Soroeru's own Google Cloud services (Cloud Run API, Firestore Form Schema
  Registry, BigQuery outcome telemetry, and Gemini on Vertex AI behind Cloud Run), under the
  data-class rules below; (3) the identity-auth BFF (§4.2); and (4), later, user-owned
  encrypted-vault cloud storage as encrypted bytes only. No other external destination, and
  no analytics / crash reporting / third-party telemetry. Until Issue #569 removes it from
  production, the existing Electron build may still call the user's own configured AI provider,
  including with raw page values during AI-driven Visibility collection (Issue #514 path below);
  the Chrome-extension target never does.
- **Data classes decide what may leave the device** (Issue #554; full matrix in
  [`security.md`](security.md) §15):
  - *Secrets* (site passwords, vault passphrase, master/recovery keys, OTP/MFA codes, cookies
    and session tokens, CVV, card PIN, My Number, API keys) never leave the device — not to
    Soroeru Cloud, not to Gemini, not even with consent.
  - *Personal values* and *page content that may contain them* never enter shared Form
    Schemas, telemetry, or cloud logs. They reach Gemini only through the consent-gated
    fallback below.
  - *Form structure* (sanitized labels, element types, structural fingerprints), *Form
    Schemas* (field → canonical attribute mappings), and *typed outcome metadata* may be sent
    to Soroeru Cloud.
- **Resolution order (Issue #554).** Reading or filling a form resolves fields in this order,
  and each step runs only when the previous one cannot resolve every required field:
  1. **Tier 1 — shared Form Schema**: a versioned schema fetched from Soroeru Cloud maps page
     fields to canonical attribute keys; the extension validates it against the live page and
     reads or writes the actual values locally. No personal value leaves Chrome.
  2. **Tier 2 — structure-only Gemini mapping**: a sanitized structure snapshot (no values,
     pattern-redacted labels) is sent to Gemini through Soroeru Cloud; the returned mapping is
     validated locally before use, and values are still read or written locally.
  3. **Tier 3 — consent-gated Gemini read**: see the next item.
  If Soroeru Cloud is unreachable or the user has disabled cloud assistance, only locally
  cached schemas (active schemas fetched within the last 30 days; retired ones are never used)
  and deterministic local resolution (the existing scanner/classifier path) run; unresolved
  fields become `unknown` or a hand-off, never a guess. A Tier 2 response that is malformed,
  fails local validation, is rate-limited, or exceeds the budget leaves the field unresolved
  and is handed off; it does not escalate to Tier 3, which runs only after Tier 2 actually
  returned a validated result that still left a required attribute unresolved. A wall detected
  at any point stops resolution and the wall hand-off applies.
- **Consent-gated Gemini fallback (the only exception to local-only personal values).** Only
  for **read** operations, and only when Tier 2 ran and still left a required attribute
  unresolved and no wall is detected:
  - automatic execution stops and a consent gate names the site, the page kind, the attribute
    kinds requested, the destination (Gemini via Soroeru Cloud), that secrets are masked and
    not sent, and that the content is not retained for product improvement;
  - nothing is pre-selected; the default action is "do not send"; one approval covers exactly
    one fallback (one site, one page observation, the listed attribute keys). It cannot be
    turned into a standing permission, including at L1;
  - declining, closing, or timing out sends nothing, leaves the attributes `unknown`, and
    offers the local/manual path (hand-off or saved-page import);
  - if an approved request fails (network error, server error, rate limit, or budget
    exhaustion), Soroeru does not retry without new consent, leaves the attributes `unknown`,
    offers the same local/manual path, and records the failure locally;
  - write operations (update, withdrawal, registration) never use this fallback; an attribute
    still unresolved after Tier 2 for a write is handed off to the user;
  - an approved request carries only the minimum page region needed, with secrets replaced by a
    mask token, and goes only to the dedicated fallback endpoint;
  - a returned value is accepted only if it corroborates against the content that was sent for
    that item; otherwise it becomes `unknown`. Accepted values are written only to the local
    encrypted vault;
  - the raw request, raw response, and extracted values are never written to shared schemas,
    telemetry, cloud application logs, traces, or analytics, and Tier 3 results never feed
    schema learning. **Consent to Gemini processing is not consent to retain data for product
    improvement**;
  - every gate outcome (approved / declined / closed / timed out) is recorded locally as
    Evidence without duplicating the disclosed values.
- **Shared Form Schemas** contain no personal values, are versioned, and cannot become active
  for all users from a single unvalidated observation; promotion requires repeated successful
  validation from distinct clients, using the fixed, testable thresholds in
  [`architecture.md`](architecture.md) §14.4; a schema whose recent failure rate exceeds the
  threshold there is retired and no longer served. Distinct clients are counted with a per-site
  pseudonymous token (class C7 in [`security.md`](security.md) §15.1): it is the only
  client-derived value Soroeru Cloud receives, is sent only with schema feedback, differs per
  site so it cannot link one installation's feedback across sites, and is never included in
  outcome telemetry. A schema never
  grants authority: it is validated against the live page on every use, and fills still pass
  the review-and-confirm gate.
- **Outcome telemetry** is allowed only for improving shared form resolution. It accepts only a
  fixed, typed allowlist (site, schema id/version, operation type, resolution tier, result,
  error category, confidence bucket, client version, structural fingerprint, hour-truncated
  time) — no client identifier, no IP, no URL path, no labels, no values, no DOM or page
  content. A user-visible control to turn telemetry and cloud assistance off must exist before
  production release. The production default is a Product Owner decision recorded in
  [`security.md`](security.md) §15.3; until it is recorded the default is **off**, and no
  production release may ship while it is unrecorded. *Production release* means any
  distribution other than maintainers' own test builds and the hackathon judging build
  (Issue #555), including any Chrome Web Store listing. The judging build may ship with
  telemetry on only if it shows a visible in-extension notice naming outcome telemetry and the
  Soroeru Cloud destination, and its judge instructions state the same and use fake data only.
- Encrypt all stored personal data at rest under a memory-hard key-derivation scheme; the
  derived key must never persist outside memory. A user-entered canonical CVV (fill use)
  remains the most sensitive field, requiring the strictest handling. Algorithm / KDF selection:
  see [`architecture.md`](architecture.md) §2 and §10.
- **Superseded in the target by the consent-gated fallback above (Issue #554).** The following
  Issue #514 rules describe the current Electron implementation and stay in force only for that
  build until Issue #569 removes it from production; they are not ported to the Chrome-extension
  target. Where they conflict with the Issue #554 rules above, the Issue #554 rules govern the
  target — in particular, site passwords and CVV are never sent to an AI model in the target,
  and raw values reach Gemini only after per-fallback consent.
- **Visibility collection exception (Issue #514, current Electron build only):** AI-driven
  Visibility collection is the one AI use allowed to receive and act on raw personal values — including full card numbers, CVV, and
  site passwords read from a site — in order to explore pages and extract disclosure values into
  the ledger; see [`architecture.md`](architecture.md) §5.2. Every other AI use (terms analysis,
  registration field mapping, non-collection discovery, etc.) stays structure-only: never send
  raw personal values to those AI calls. Only the user's configured provider; no provider
  stateful features (PII prompt-caching, stored threads, memory) for any AI use.
- **No AI use, including Visibility collection, ever performs form filling, terms acceptance,
  final submission, card entry, or another irreversible action.** Those remain deterministic with
  their applicable review-and-confirm gates and guards in every case; Visibility collection is
  read-only regardless of the raw-value exception above.
- AI browser analysis outside Visibility collection MUST pass through an allow-list structural
  sanitizer. Raw DOM, field or display values, prefilled/selected values, cookies, tokens, and
  value-reading results must not enter those AI requests, and AI output there is limited to a
  validated mapping/navigation schema referencing elements present in the sanitized snapshot; it
  cannot issue free-form browser actions or invent URLs/selectors. Visibility collection's
  AI-driven exploration loop still enforces same-registrable-site navigation, per-site
  page/depth/time budgets, and
  immediate wall hand-off (never bypassed) — only the raw-value restriction is lifted for it.
- AI-assisted discovery/collection is optional and bounded. Provider failure, invalid output,
  cancellation, wall detection, or exhaustion of the per-site limits owned by
  [`architecture.md`](architecture.md) §5.2 yields deterministic fallback or an explicit partial/
  unknown result, never a guessed value or automatic expansion of authority. A stored sanitized
  Site Collection Map may execute locally without an AI provider; regeneration requires user action.
  A returned raw value the AI-driven path cannot corroborate against the page content it was
  given for that step — because the model misidentified it, fabricated it, or a manipulated page
  tried to inject it — is also treated as unknown/skipped rather than stored; see
  [`architecture.md`](architecture.md) §5.2's local corroboration-before-write requirement.
- No raw browser session state (profile, cookies) is retained outside the encrypted vault;
  browser automation sessions are ephemeral by default. Mechanism: see
  [`architecture.md`](architecture.md) §2.
- **Evidence / audit records are content-minimized.** They never store screenshot pixels,
  full page HTML, cookies, or tokens — only references, hashes, timestamps, field
  labels/types, and masked snippets: enough to make a decision inspectable without
  creating a second data leak.
- **Prefer "unknown" over a confident wrong answer.** An ambiguous or unclear value —
  whether from deterministic collection, AI-assisted structure analysis, or the AI-driven
  Visibility collection path's raw-value reads (Issue #514) — becomes an explicit "unknown"
  state or a review task, never a guessed or fabricated value. The same rule applies to
  AI-proposed field mappings and Constraint findings.
- The review-and-confirm gate and the three guards (plus the fourth absolute boundary:
  deleting data inside Soroeru is always confirmed).
- No payment (free-trial→subscription exception only, on explicit approval).
- The imported CSV (which contains plaintext passwords) is encrypted immediately, never
  logged, and safely discarded after import. Collected PII is stored locally encrypted only and
  is never egressed except through the consent-gated Gemini fallback above (or the Issue #514
  path of the current Electron build). Validate the CSV's size and row count before processing (reject
  unreasonably large or malformed files rather than parsing them blindly). After a
  successful import, prompt the user to delete the original exported CSV file, but never
  silently delete a user-selected file outside Soroeru's own vault.
- **Automated access / scraping** — to resolve the bootstrap problem (you must read terms to
  know terms; manually vetting 300+ sites is infeasible), separate the activities:
  - **Reading public terms pages automatically is allowed** (public content; the means by
    which clauses are detected, which resolves the bootstrap).
  - **Logging into the user's own My Page with the user's own credentials to read the
    user's own data is treated as agent-assisted self-access** (distinct from third-party
    scraping). No prior manual vetting of all sites is assumed.
  - **Hard line**: actively-enforced technical access controls are **never bypassed** —
    detect and hand off. This includes CAPTCHA, MFA, bot detection, rate limits, paywalls,
    and any other actively-enforced access control.
  - A **detected automation-prohibiting ToS clause** is **not silently hard-blocked**; it is
    surfaced as a Constraint / high-risk item for **the user to decide** (the agency
    principle: inform; the user decides; never bypass active enforcement).
  - **The boundary line is access control, not the ToS.** A ToS prohibition on automation is
    a civil matter between the user (a party to that contract) and the site; it is the gray
    Soroeru contests *on the user's behalf*. The inviolable line is the **circumvention of
    actively-enforced technical access controls** (defined above) — the criminal line under
    unauthorized-access law. Logging into the user's own account with the user's own
    credentials is **not** unauthorized access, even when automated and even when a ToS
    forbids bots.
  - **Legitimacy preconditions for contesting ToS-gray.** Any action that proceeds against an
    automation-prohibiting clause is gated on four hard preconditions: (1) the user's explicit,
    per-operation-type consent (tied to the Delegation Boundary L0/L1); (2) the user's own
    credentials acting on the user's own account; (3) an assessment of reversibility
    (deletion of Soroeru-internal data and a site withdrawal's final, irreversible
    confirmation step are absolute boundaries per §5, gated regardless of ToS-automation
    stance — not only when contesting ToS-gray); and (4) a transparent **Evidence** record.
    Evidence is a **hard
    precondition**: an action that cannot be recorded does not fire. The record is both the
    user's transparency and Soroeru's legitimacy — every action was the user, on the user's own
    account, recorded and (where possible) reversible.
  - Bulk collection of *others'* data and circumventing access controls are out of scope.
  - Legal nuances are reviewed separately in [`security.md`](security.md).
- **Identity verification (My Number / JPKI)** — see §4.2,
  [`architecture.md`](architecture.md) §9 (integration mechanism), and
  [`security.md`](security.md) §14:
  - The **12-digit My Number is never stored** (the auth flow does not expose it); store only
    the basic-4 attributes, the PPID, and verification Evidence (Digital Agency reference +
    timestamp). The **card PIN is entered in the Digital Agency app and never seen by Soroeru**.
  - Basic-4 attributes are non-editable; phone / email require OTP ownership verification (≤3
    each); removing a verified contact is the fourth absolute boundary.

## 9. Out of Scope

- L2 full automation (MVP); multi-locale; checkout / purchase / payment (except the approved
  free-trial→subscription card case); **bypassing actively-enforced technical access
  controls** (see §8); collecting other people's data; hosted personal-data vaults and
  uploading or synchronizing the user's vault to Soroeru-managed storage; backend API servers
  (**exceptions**: a minimal, OSS, zero-retention identity-auth BFF for デジタル認証アプリ
  verification only — §4.2 / [`security.md`](security.md) §14; and Soroeru Cloud for shared
  Form Schemas, Gemini mediation, and typed outcome telemetry — §8, Issue #554); telemetry
  containing personal data, third-party analytics, crash reporting; training or fine-tuning a
  model on users' personal values; browsers other than desktop Chrome, and mobile apps (for
  now; the current Electron build also remains macOS-only); **site-side verifiable-credential (VC) issuance and any
  trust-registry / relying-party integration for "Soroeru-verified" sign-up (future
  direction, Issue #218); identity onboarding for users without a My Number Card or outside
  Japan (v1 is Japan-resident, card-holder only).** MCP server support in the MVP: a strictly
  permissioned local MCP server may be added later for advanced users, exposing only
  read-only / planning-oriented tools (inventory summaries, stale-site discovery, page
  structure inspection, candidate proposals, task creation for later review); it must never
  expose raw personal values, credentials, card numbers, CVV, decrypted vault exports, direct
  browser control, or a submit/withdraw action that skips the review-and-confirm gate.

## 10. Functional Requirements

Tier reflects the slice order (A first). Status is `Planned`; target architecture is
[`architecture.md`](architecture.md).

| ID | Requirement | Slice | Priority |
| --- | --- | --- | --- |
| REQ-001 | Store Personal Attributes (canonical values) locally, encrypted at rest; a user-entered canonical CVV (fill use) is treated as most sensitive. Basic-4 identity attributes (name, address, DOB, sex) are JPKI-sourced and **non-editable** (REQ-015); other attributes are user-editable. | A | Must |
| REQ-002 | Import a Google/Chrome Password Manager CSV; encrypt taken values, discard the raw CSV after processing, never re-export plaintext. | A | Must |
| REQ-003 | Auto-log in to each imported site using stored credentials; detect MFA/CAPTCHA walls and hand off / resume in the same session; never bypass. If login fails because credentials are rejected, the login flow is unrecognized, or the site returns an error, stop after at most two login attempts for that site/credential set, do not enter same-site retry loops, and record the Site Account as `login failed / not collected` until the user explicitly updates credentials or retries later. | A | Must |
| REQ-004 | (Target, Issue #554: collection resolves pages and fields through Tiers 1–3 — REQ-025, REQ-026, REQ-028 — and the rest of this row describes the current Electron build.) Collect registered personal information per site — via AI-driven page exploration and extraction as the primary path once AI is configured, deterministic collection (`architecture.md` §5.2) as fallback (Issue #514) — and build the Disclosure ledger with encrypted site-held values plus normalized hashes; Evidence / audit records remain reference+hash only. Site-collected card numbers and CVV are stored in full via the AI-driven path, per target policy (Issue #514 supersedes the earlier last-4/CVV-exclusion rule for that path only; the deterministic fallback keeps the last-4/CVV-exclusion rule); domain CVV storage is implemented in Issue #516, while the AI exploration loop and its gates remain pending — `security.md` §3 implementation status. | A | Must |
| REQ-005 | Present the per-site view by composing Site Account + its Disclosures, showing normal-sensitivity values (name, address, phone, account id, etc.) plainly and immediately, masking only sensitive/most-sensitive values (card data, the site password) with reveal gated behind passphrase re-authentication, and flagging stale values (Disclosure ≠ canonical). | A | Must |
| REQ-006 | Track Account Relationship (newsletter / recurring billing or free-trial conversion / last-used) and provide, at minimum, filtered lists for: active newsletter subscriptions, active recurring billing, stale phone/address/card values, and sites not fully checked because a wall, credential failure, site error, or unknown flow stopped collection. | A | Must |
| REQ-007 | Record two-layer Reflection (initial footprint + post-action change). | A | Must |
| REQ-008 | Enforce the Delegation Boundary model (L0 default, L1 in-policy, L2 out of scope; asymmetric expand/reduce; light understanding check pass required before L1 expansion; five absolute boundaries). | A | Must |
| REQ-009 | Form Policy/Preference from ledger reactions: suggest after 3 consistent observations (at most one suggestion of the same kind per day), promote to Policy only on explicit user confirmation; thresholds are configurable defaults. | A | Must |
| REQ-010 | Bulk-update selected sites by diffing Disclosures against canonical Personal Attributes (cross-site by attribute). | B | Must |
| REQ-011 | Withdrawal cleanup: stop newsletters, cancel unused subscriptions, withdraw from unused services; the withdrawal flow may execute within the delegated range but its final, irreversible confirmation step is always gated (absolute boundary, §5), regardless of ToS-automation stance; deletion of Soroeru's own data is always confirmed. | C | Should |
| REQ-012 | Autonomous new registration with the review-and-confirm gate and three guards; high-risk-clause surfacing tuned to cultivate the user's own discovery. | D | Should |
| REQ-013 | Work without AI by default (deterministic); AI mode optional. Target (Issue #554): AI is Gemini through Soroeru Cloud, structure-only (Tier 2) except the consent-gated read fallback (Tier 3, REQ-028); local cached schemas and deterministic resolution keep working offline or with cloud assistance disabled. Current Electron build: user-configured provider only, and Visibility collection (A) discloses raw personal values to it when AI-driven (Issue #514); every other AI use (B–D) stays structure-only disclosure. | A–D | Must |
| REQ-014 | Treat a detected automation-prohibiting ToS clause as a surfaced Constraint for the user to decide; never silently block, never bypass active controls. | A | Must |
| REQ-015 | Require My Number Card verification at first launch — via the Digital Agency デジタル認証アプリ (認証 API; smartphone card read, QR cross-device from desktop) — before any use; take basic-4 attributes (name, residence address, DOB, sex) from the authentication result only, non-editable; update address only by re-reading an updated card. | A | Must |
| REQ-016 | Never store the 12-digit My Number or the card PIN (the PIN is entered in the Digital Agency app, never seen by Soroeru); store only basic-4 attributes, the PPID, and verification Evidence (Digital Agency reference + timestamp). | A | Must |
| REQ-017 | Allow derived name fields (kana, romaji) as editable-but-unverified, consistency-checked against the verified legal name. | A | Must |
| REQ-018 | Require OTP ownership verification to add/change a phone number or email; store at most 3 of each; removing a verified contact is the fourth absolute boundary (always confirmed). | A | Must |
| REQ-019 | Limit identity scope to user-side verified-data management (Japan-resident card-holders); site-side verifiable-credential issuance / relying-party trust is out of scope (future, Issue #218). | — | Won't (MVP) |
| REQ-020 | Run the デジタル認証アプリ integration through a minimal, OSS, zero-retention identity-auth BFF: registered relying party (client ID, redirect / back-channel logout URIs, private_key_jwt), egress to the Digital Agency only, basic-4 forwarded encrypted to the user's device and never persisted server-side. Narrowly-scoped exception to the no-backend principle, identity layer only. | A | Must |
| REQ-021 | (Current Electron build; superseded in the target by REQ-025, REQ-026, and REQ-028 — Issue #554. The bounded navigation, budget, same-site, and wall rules below still apply to the target's read exploration.) AI-driven Visibility collection (primary once AI is configured, Issue #514) uses a bounded observe/propose loop: every navigation proposal is schema-validated and locally executed (same-registrable-site, budgets, wall hand-off), but — unlike the rest of this loop's proposals — the values it returns are the raw personal values read from the current page, not schema-validated references to a local read; the automation/domain layer still performs every write. Maps are encrypted local candidates; stale maps fall back per entry; regeneration is explicit rather than silent. This requirement previously described a fully structure-only/local-values loop; §8's Visibility collection exception and `architecture.md` §5.2 supersede that for the value-reading step specifically. | A | Must |
| REQ-022 | Record an observed unconfigured security item and show it as a non-blocking, dismissible review task; Soroeru neither recommends nor changes the setting automatically. | A | Must |
| REQ-023 | Run the primary user path (vault unlock, ledger, review/consent gates, browser operation) from the Soroeru Chrome extension without Electron, the native helper, or Native Messaging (Issue #554). Keep the one-leased-tab, ledger-scope, and wall hand-off rules (REQ-003, §8). | A | Must |
| REQ-024 | Store the extension's vault as ciphertext only in extension-local storage, with the same encryption/KDF semantics as the existing vault and versioned migrations; hold the unlocked key only in memory of the extension page that shows the vault, and lock when that page closes, the browser restarts, or the user locks. Unreadable data fails closed. | A | Must |
| REQ-025 | Tier 1: resolve a known form from a versioned shared Form Schema in Soroeru Cloud, validate it against the live page per field, and read/fill values locally; send no personal value to Soroeru Cloud. A field that fails validation falls to Tier 2 alone. | A–D | Must |
| REQ-026 | Tier 2: when no valid schema resolves a required field, send only a sanitized structure snapshot (no values, pattern-redacted labels) to Gemini through Soroeru Cloud; accept only closed-schema mappings that reference items in the snapshot and pass local validation. | A–D | Must |
| REQ-027 | Send outcome telemetry only through the fixed typed allowlist in §8; reject any other field on both client and server. Provide a user-visible control to disable telemetry and cloud assistance before production release. | A–D | Must |
| REQ-028 | Tier 3: for read operations only, after Tiers 1–2 leave a required attribute unresolved, stop and ask for explicit per-fallback consent before sending any personal value to Gemini; send nothing on decline/close/timeout; never retry a failed approved request without new consent (attributes stay `unknown`, hand-off offered); mask secrets; send only the minimum region to the dedicated endpoint; accept only corroborated values; record the gate outcome locally (§8). | A | Must |
| REQ-029 | Version shared Form Schemas with a candidate → active → retired lifecycle; never activate a schema from a single unvalidated observation; never let Tier 3 results feed schema learning; reject schema records containing personal-value-like strings. | A–D | Must |
| REQ-030 | Never send secrets (site passwords, CVV, OTP/MFA codes, cookies/tokens, keys, passphrases, My Number, card PIN) to Soroeru Cloud or Gemini; never write Tier 3 request/response content or extracted values to Firestore, BigQuery, cloud application logs, traces, or analytics. | A–D | Must |

## 11. Glossary

| Term | Definition |
| --- | --- |
| Agency / free will (domain-specific) | The acquired, trainable capability to make real choices in a domain — including choices that were previously impossible. Soroeru cultivates this for the personal-information domain. |
| Toil vs. judgment | Toil = friction worth automating (form filling, navigation). Judgment = the domain skill worth keeping with and growing in the user (what/whom/terms/revocation). |
| Personal Attribute | The user's canonical value for a piece of personal data (the single source of truth). |
| Site Account | A per-site login / ongoing-relationship anchor. |
| Disclosure | The value a given site currently holds for an attribute, with an as-of time; stale iff it differs from the canonical Personal Attribute. |
| Account Relationship | An ongoing relationship facet: newsletter subscription, recurring billing, last-used time. |
| Policy | An articulated norm the user wants/refuses; drives judgment and automation. |
| Preference | A pre-norm situational tendency; material for suggestions; promotes to Policy through repetition. |
| Delegation Boundary | The configuration of which judgments are delegated, to which understanding tier, and how far ahead (L0/L1; absolute boundaries). |
| Light understanding check | The per-operation L0 → L1 gate where the user must correctly identify what becomes automatic and what still requires confirmation; it is required before L1 expansion and is not satisfied by repeated approvals alone. |
| Reflection | The post-state record through which the user learns (initial footprint + per-action change). |
| Constraint | A site / terms / technical limit recorded as it is discovered. |
| Mandate | A record of what the user authorized (collection or action). |
| Three guards | High-risk-clause escalation, payment stop (free-trial exception), no auto-attestation. |
| Wall | A step that must not be automated: CAPTCHA, MFA, identity / email / SMS verification. |
| Soroeru Cloud | Soroeru's own Google Cloud services (Cloud Run API, Firestore Form Schema Registry, BigQuery outcome telemetry, Gemini on Vertex AI behind Cloud Run). It holds non-personal form knowledge and typed outcome metadata, never the user's vault or personal values. |
| Form Schema | A versioned, shared, value-free record mapping a site's page/form structure to canonical attribute keys; lifecycle `candidate` → `active` → `retired`. |
| Resolution tier | The ordered way a field is resolved: Tier 1 shared Form Schema, Tier 2 structure-only Gemini mapping, Tier 3 consent-gated Gemini read. |
| Consent-gated fallback | Tier 3: a single, explicitly approved read where minimum page content (secrets masked) is sent to Gemini; never a standing permission and never retained for improvement. |
| Outcome telemetry | Typed, allowlisted, value-free records of how form resolution went, used only to improve shared Form Schemas. |
| Site Collection Map | An encrypted per-site local-candidate record that maps normalized account pages to typed item locators; after discovery it is executed deterministically without an AI call and is stale when mapped page structure or item resolution no longer matches. |
