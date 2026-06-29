# Requirements

This document owns the **product requirements** for **Soroeru**: the product's reason for
being, success definition, domain ontology, delegation model, agency loop, scope, and
non-negotiable requirements.

This document is the **canonical product direction**.
Out of scope here: application architecture and technology selection (see
[`rfc/rfc-002-soroeru-architecture.md`](rfc/rfc-002-soroeru-architecture.md)), security
rationale (see [`security.md`](security.md)), and agent operating rules (see `../AGENTS.md`
and `../CLAUDE.md`).

> **Direction change (2026-06-25).** The product is renamed and re-founded from
> `Catashiro` to **Soroeru（揃える）**. It is no longer framed as an "autonomous form-filling
> agent" or a "desktop-wrapped web app." Soroeru is a **local-first agency engine**: a tool
> through which a user *acquires their own free will* (agency) in the domain of personal
> information, online accounts, and online contractual relationships. This document fully
> **supersedes** the previous Catashiro requirements; the prior direction lives in git.
>
> The **repository / codebase identifier remains `soroeru`** for now (code is not
> renamed); **Soroeru** is the product name. Technology selection is deliberately **not**
> fixed here — it is decided ground-up, requirements-first, in
> [`rfc/rfc-002-soroeru-architecture.md`](rfc/rfc-002-soroeru-architecture.md). The existing
> Electron epic (#156–#162) and the control-plane RFC (#163) are revisited there
> (rebaseline / replace / close).

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
central aggregation (consistent with local-first / no hosted vault / no telemetry).

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
  owns it. No hosted vault, no telemetry.

## 3. Success Metrics

The primary metric is **not** "number of actions automated."

| Metric | What it measures | Direction |
| --- | --- | --- |
| High-risk-clause self-discovery rate | At new registration, the share the user notices **before** Soroeru surfaces it (direct measure of internalization). | ↑ |
| Default-escape rate | Share of Policy options left at default (↓) / share the user explicitly re-chose (↑). | ↑ |
| Practical choosability rate | Share of intended decisions (withdraw / update / refuse) the user could actually carry out. | ↑ |
| Disclosure visibility rate | Disclosures known to the user / disclosures that actually exist. | ↑ |
| Subjective agency | Self-reported "I decided this / I'm in control," tracked over time. | ↑ |
| (Counter) Blind-approval rate | Share of gates / suggestions clicked through without understanding. | ↓ |

Six-month target state: at new registration the user has internalized "what to watch for in
terms," and can quickly find high-risk clauses and choose register/refuse **without**
Soroeru's prompt; the user naturally understands each Policy option and selects it
themselves.

## 4. Domain Ontology

| Concept | Tier | Role |
| --- | --- | --- |
| Personal Attribute | MVP-required | The user's **canonical value** (the single source of truth; one set). |
| Site Account | MVP-required | The per-site login / ongoing-relationship anchor (seeded from the CSV: name/url/username/password/note). |
| Disclosure | MVP-required, core | "Which attribute was disclosed to which site, and when" (an attribute×site edge + as-of). **Stale = Disclosure.value ≠ Personal Attribute.canonical.** |
| Account Relationship | MVP-required | Ongoing relationship: newsletter-subscription state / recurring-billing state / last-used time. Powers the filtered lists. |
| Constraint | MVP-required | Site / terms / technical walls (automation-prohibiting ToS, MFA wall hit, etc.). |
| Reflection | MVP-required | The two layers (initial footprint + post-action change). |
| Delegation Boundary | MVP-required | The L0/L1 and absolute-boundary state. |
| Capability / Unlock state | MVP-required | Per-operation unlock tier (L0/L1) + internalization signals. |
| Mandate | MVP-required (light) | A record of what the user authorized (collection counts as an authorized action). |
| Evidence / Audit | MVP-required (light) | Audit log of what happened — references + hashes, not duplicated raw values. |
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
  the value a site holds (the Disclosure). Embedding raw values directly in Site Account
  cannot define "stale" on its own and fights the "hashes, not raw duplication" rule.
- Payoffs: (1) sites collect different fields → `(account, attribute, value, as-of)` rows
  stay flexible; (2) bulk update (B) becomes first-class via a cross-site query
  "attribute = X and value ≠ canonical"; (3) hashing / Evidence concentrate on Disclosure.

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
- **Absolute boundaries (always confirmed, even at L1)**:
  1. high-risk clauses (auto-renewing subscription, mandatory arbitration, third-party
     data sharing/sale, content licenses, …);
  2. payment (stop / hand off; the only exception is free-trial→subscription, card filled
     only on explicit approval);
  3. eligibility / identity attestation (never auto-checked);
  4. **deletion of data stored inside Soroeru** (an irreversible destruction of the user's
     own source of truth).
- **Explicitly *not* absolute boundaries**: withdrawing from a site (may execute
  immediately within the delegated range); a first-seen site (the three guards suffice; it
  is an automation target).

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
    same kind per session/day.**
  - **Promotion to Policy**: **never automatic.** After a suggestion is shown and the user
    accepts it, or repeats the same action once more after seeing it, Soroeru asks once,
    "Make this a policy?" Demotion / editing is always available.
  - These thresholds (3 times / once per day) are configurable defaults (the
    default→self-selection principle applies to them too).

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

### 7.2 Locale

- Japanese-language sites only for now (multi-locale is later).

### 7.3 Existing assets

- Requirements are primary; technology follows requirements. Existing implementation assets
  may be reused **if they fit** the new requirements. Where they do not, **discarding all
  existing assets and re-selecting technology ground-up is permitted** (no asset lock-in).

## 8. Non-Negotiable Requirements (Security / Privacy / Safety)

- Local-first / locally encrypted, user-owned / no hosted vault / no telemetry.
- AES-256-GCM with a memory-hard KDF (Argon2id; PBKDF2-HMAC-SHA-512 as a Web-Crypto-only
  fallback). The derived key stays in memory only. CVV is the most sensitive field.
- Never send raw personal values to the AI model — structure only. Only the user's
  configured provider; no provider stateful features (PII prompt-caching, stored threads,
  memory).
- The review-and-confirm gate and the three guards (plus the fourth absolute boundary:
  deleting data inside Soroeru is always confirmed).
- No payment (free-trial→subscription exception only, on explicit approval).
- The imported CSV (which contains plaintext passwords) is encrypted immediately, never
  logged, and safely discarded after import. Collected PII is never egressed and is stored
  locally encrypted only.
- **Automated access / scraping** — to resolve the bootstrap problem (you must read terms to
  know terms; manually vetting 300+ sites is infeasible), separate the activities:
  - **Reading public terms pages automatically is allowed** (public content; the means by
    which clauses are detected, which resolves the bootstrap).
  - **Logging into the user's own My Page with the user's own credentials to read the
    user's own data is treated as agent-assisted self-access** (distinct from third-party
    scraping). No prior manual vetting of all sites is assumed.
  - **Hard line**: access controls a site actively enforces (CAPTCHA / MFA / bot detection)
    are **never bypassed** — detect and hand off.
  - A **detected automation-prohibiting ToS clause** is **not silently hard-blocked**; it is
    surfaced as a Constraint / high-risk item for **the user to decide** (the agency
    principle: inform; the user decides; never bypass active enforcement).
  - Bulk collection of *others'* data and circumventing access controls are out of scope.
  - Legal nuances are reviewed separately in [`security.md`](security.md).

## 9. Out of Scope

- L2 full automation (MVP); multi-locale; checkout / purchase / payment (except the approved
  free-trial→subscription card case); **bypassing** CAPTCHA / MFA / bot detection / rate
  limits / paywalls / access controls; collecting other people's data; hosted vaults,
  backend API servers, telemetry, analytics, crash reporting; mobile apps and non-macOS
  platforms (for now).

## 10. Functional Requirements

Tier reflects the slice order (A first). Status is `Planned` pending the architecture RFC.

| ID | Requirement | Slice | Priority |
| --- | --- | --- | --- |
| REQ-001 | Store and edit Personal Attributes (canonical values) locally, encrypted at rest; CVV treated as most sensitive. | A | Must |
| REQ-002 | Import a Google/Chrome Password Manager CSV; encrypt taken values, discard the raw CSV after processing, never re-export plaintext. | A | Must |
| REQ-003 | Auto-log in to each imported site using stored credentials; detect MFA/CAPTCHA walls and hand off / resume in the same session; never bypass. | A | Must |
| REQ-004 | Collect registered personal information per site and build the Disclosure ledger (references + hashes, not duplicated raw values). | A | Must |
| REQ-005 | Present the per-site view by composing Site Account + its Disclosures, flagging stale values (Disclosure ≠ canonical). | A | Must |
| REQ-006 | Track Account Relationship (newsletter / recurring billing / last-used) and provide filtered lists for these. | A | Must |
| REQ-007 | Record two-layer Reflection (initial footprint + post-action change). | A | Must |
| REQ-008 | Enforce the Delegation Boundary model (L0 default, L1 in-policy, L2 out of scope; asymmetric expand/reduce; four absolute boundaries). | A | Must |
| REQ-009 | Form Policy/Preference from ledger reactions: suggest after 3 consistent observations (≤1/day), promote to Policy only on explicit user confirmation; thresholds are configurable defaults. | A | Must |
| REQ-010 | Bulk-update selected sites by diffing Disclosures against canonical Personal Attributes (cross-site by attribute). | B | Must |
| REQ-011 | Withdrawal cleanup: stop newsletters, cancel unused subscriptions, withdraw from unused services; site withdrawal may execute within the delegated range; deletion of Soroeru's own data is always confirmed. | C | Should |
| REQ-012 | Autonomous new registration with the review-and-confirm gate and three guards; high-risk-clause surfacing tuned to cultivate the user's own discovery. | D | Should |
| REQ-013 | Work without AI by default (deterministic); AI mode optional, user-configured provider only, structure-only disclosure. | A–D | Must |
| REQ-014 | Treat a detected automation-prohibiting ToS clause as a surfaced Constraint for the user to decide; never silently block, never bypass active controls. | A | Must |

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
| Reflection | The post-state record through which the user learns (initial footprint + per-action change). |
| Constraint | A site / terms / technical limit recorded as it is discovered. |
| Mandate | A record of what the user authorized (collection or action). |
| Three guards | High-risk-clause escalation, payment stop (free-trial exception), no auto-attestation. |
| Wall | A step that must not be automated: CAPTCHA, MFA, identity / email / SMS verification. |

## 12. Relationship to prior Catashiro work

- This document **fully supersedes** the previous `Catashiro` requirements; the old direction
  remains in git history.
- **Technology selection is deferred** to a later, ground-up architecture RFC (language,
  shell, automation, storage). The existing Electron epic (#156–#162) and the
  control-plane RFC (#163) are revisited there and **rebaselined, replaced, or closed**.
- Items deferred to the architecture RFC include: the vault schema normalizing Personal
  Attribute / Disclosure / Account Relationship, the auto-login + hand-off execution model,
  and the safe CSV-import design.
