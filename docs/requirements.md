# Requirements

Soroeru（揃える） helps people see, update and reduce the personal information,
accounts and contracts scattered across services. **Maximizing the user's
experience is the first principle**: reduce work and interruptions while keeping
consequential choices understandable and under the user's control. Information
loss, unexpected disclosure, charges and deletion are failures of that experience.

This document owns product intent and observable behavior. Technology belongs in
[architecture](architecture.md), data handling in [security](security.md), and
commands in [development](development.md). These are target requirements, not a
claim that every feature ships today; the architecture's implementation status
identifies the available extension path.

## Success and priority

Deliver in this order:

1. **Visibility**: import accounts, collect the user's registered information,
   and show what is known, stale, masked or not yet collected.
2. **Bulk Update**: review an old-to-new change set and propagate approved changes.
3. **Withdrawal**: identify unwanted relationships and assist cancellation/deletion.
4. **Registration**: explain disclosures and consequential terms, then perform
   the user's approved registration.

The first release targets Japanese-language sites in desktop Chrome. A local
ledger remains useful without Cloud; full collection coverage does not have to
match online operation. Other browsers, mobile, third-party account collection,
hosted personal vaults and fully autonomous decisions are outside this scope.

Measure locally per collection run: sites completed, sites with an explicit
unresolved reason, elapsed time and user interruptions. A run must account for
all selected sites as completed, partial, stopped or failed. Never count an
unknown value as a successful read. For updates and withdrawal, show success,
failure and unconfirmed completion separately for each site. These local metrics
are not uploaded as user activity histories.

## Main flow

1. Create or unlock the encrypted vault; offer a recovery key and encrypted backup.
2. Import a password-manager CSV or add accounts. Preview validation failures and
   duplicates; do not log the CSV or delete the user's original file. Show one
   post-import reminder to remove the plaintext export.
3. Select accounts and bind a Chrome tab with origin permission. A collection
   approval covers the named read-only run, including normal navigation and local
   credential entry. No approval is requested for every field or page.
4. Collect through shared schemas and structure-only mapping, reading values
   locally. A scoped AI-read option can assist unresolved fields as described
   below. Cloud assistance can be disabled without losing access to the vault.
5. On CAPTCHA, MFA, bot detection, rate limits, paywalls or other access controls,
   pause and let the user act in the same tab. Revalidate before resuming; do not
   change browser, identity or route to evade the control.
6. Show partial results as they become durable. The ledger records the account,
   attribute, observed value, observation time and source. Compare against the
   canonical value only when both are sufficiently known; a masked card number
   cannot establish equality with a full number.
7. Let the user filter stale information, newsletters, recurring billing and
   unused accounts, then choose a next action. Suggestions never submit changes.

Cancellation stops further work; already saved observations remain visible.
Navigation outside the authorized site, lost permission, vault lock, panel close
or browser restart interrupts execution. Resume rebinds and revalidates the tab;
it never treats an interrupted submission as confirmed success.

## Data model and identity

| Concept | User-visible meaning |
| --- | --- |
| Personal Attribute | The current canonical value chosen by the user, with source/verification status |
| Site Account | A service relationship and local credentials |
| Disclosure | An attribute observed at one account, with time and known/masked/unknown state |
| Account Relationship | Newsletter, billing and last-use observations |
| Constraint | A wall, terms restriction, unknown value or other reason for user attention |
| Mandate / Policy | The authorized action and any explicit reusable scope |
| Evidence | A minimized local record of approval and outcome |
| Change Set | The proposed per-site changes and their individual outcomes |

Visibility must be usable before identity verification. Users may maintain
unverified canonical attributes, clearly labeled as user-entered; editing a
verified value creates an unverified replacement and never preserves a verification
badge. Optional identity verification may populate verified attributes later.
Phone/email ownership verification is required only when a destination or a
verification feature needs it, not to view or maintain the local ledger. No
arbitrary three-contact cap is a product requirement. Site-required identity
checks and eligibility declarations still belong to the user. Soroeru never
claims that an unverified value proves identity. Identity integration is future
work, not a prerequisite for the extension.

## Authorization without repeated gates

- **L0**: the default. Review the named operation, accounts, changes and relevant
  consequences once before execution. Group the same decision across a selected
  batch; stop for a new consequence or expanded scope.
- **L1**: the user explicitly enables automatic work within a named operation and
  scope after seeing what will run and what still stops. No understanding quiz,
  approval-count threshold or recurring qualification is required. A changed
  scope requires approval again. Turning L1 off is immediate and unconditional.
- An approval for local collection does not authorize sending personal content
  to AI, and an AI-read approval does not authorize writes.
- High-risk terms (for example renewal charges or third-party data sharing) are
  presented with the concrete consequence in the action review. Do not show a
  second identical gate for a consequence already approved in the same action.
- Payment/checkout is handed off. The only automated exception is the specifically
  approved free-trial-to-subscription flow. Never auto-attest identity or eligibility.
- Final irreversible site withdrawal and deletion of Soroeru-held user records
  always require explicit confirmation. A single confirmation may enumerate a
  batch, but each target and consequence must be visible. Cache expiration and
  clearing unsent improvement queues follow their configured retention policy.
- Automation-prohibiting terms are shown as a Constraint for the user's decision;
  do not silently continue or claim legal permission. Active controls are never bypassed.

Approval records contain scope, policy version, time and outcome, not copies of
personal values. If a required approval cannot be recorded, do not execute its
consequential action. Routine read failures yield partial results and a retry or
manual path, not additional approval dialogs.

## Cloud and AI assistance

Cloud shares form knowledge, not the user's vault. The resolution order is
validated shared schema, structure-only Gemini mapping, then an optional Gemini
read of unresolved attributes. The first two tiers read/write values locally.
Invalid proposals, unknown fields and ambiguous values remain unknown; model
confidence alone never establishes correctness or authorization.

For **read-only Tier 3**, offer one explicit choice covering the current collection
run: the exact sites, page kinds and attribute kinds, Gemini via Soroeru Cloud as
the destination, a maximum of 20 requests and a 15-minute expiry. Nothing is
preselected. Show that secrets are excluded, each region is limited to 16 KiB,
and personal content is not retained for product improvement. The user may instead
approve just the current fallback. Decline, close or timeout sends nothing and
keeps local/manual collection available.

Within the approved run and limits, eligible unresolved regions need no repeated
gate. A retry consumes a request and is limited to one per failed request, for
transport/5xx failures only; never retry throttling or exhausted budgets. Each send
rechecks scope, page observation, wall state and permission. A scope change,
expiry, cancellation, wall hand-off, panel close, lock or restart ends approval.
Resumed runs need new consent. There is no standing cross-run permission.
Tier 2 outage or invalid output does not trigger personal-content fallback.
Tier 3 never fills, submits or accepts terms; only locally corroborated results
are saved. Secret handling and cloud retention are owned by [security](security.md).

Cloud assistance and improvement sharing are separate settings, both **off by
default**, with a one-time setup explanation and immediately effective off switches.
Choosing assistance once enables schema lookup and structure-only mapping without
per-call dialogs. It does not enable Tier 3 or improvement sharing. Sharing covers
only the typed outcome/feedback data defined in security; no separate production
or judging-build consent rule is needed. Off stops new requests and discards
unsent sharing queues. Offline mode supports ledger access, local deterministic
resolution and valid cached schemas; unresolved work is explicitly handed off.

## Policy changes awaiting implementation

These requirements simplify earlier gates; changing this document does not enable
these behaviors in the app. Quiz-free L1 and unverified identity editing need
implementation and tests before use. The identity-first onboarding plan and the
L1 quiz plan must be reconciled in GitHub before their implementation. The
implementation Issue/PR owns that reconciliation and its acceptance evidence;
this document is not a release-completion checklist.
