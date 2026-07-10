# Visibility Collection Failure Analysis (Issue #317)

This document records the failure-cause ranking for full Visibility collection
runs over the Product Owner's real password CSV, produced with the collection
diagnostics harness (`skills/collection-diagnostics/SKILL.md`):

```bash
npm run diagnostics:collect        # packaged app, all sites, unattended
npm run diagnostics:analyze -- <stateRoot>/logs/soroeru.log
```

Privacy rule for this document: cause categories, counts, and shares only.
Never list the site domains here — the domain list reveals which services the
user has accounts on. The full per-domain breakdown stays local in the
analyzer output and the run's state directory.

## How causes are bucketed

One terminal outcome per site, from the diagnostics log (`soroeru.log`):

| Category | Meaning |
| --- | --- |
| `collected` | Logged in and collected at least one disclosure (success). |
| `unreachable:<reason>` | Navigation failed: `dns-not-found`, `connection-refused`, `timeout`, `certificate-error`, or generic `navigation-failed`. |
| `login-incomplete` | Reached the site but a password field remained after submitting credentials — the login did not take. |
| `no-data` | Logged-in page reached but no collectable form values found (values may be plain text, or an unexpected landing page). |
| `wall:<kind>` | Paused at a CAPTCHA / MFA / verification wall; unattended runs skip the site (never bypass). |
| `non-web-credential` | Not a web login (e.g. an `android://` app entry); nothing to collect. |
| `failed:<detail>` | Unexpected runner error (normalized error bucket). |

## Run history

<!-- Newest first. Categories/counts from `npm run diagnostics:analyze`. -->

### Run 2 — 2026-07-10 (full: 267 of 267 sites)

- App: packaged build from the Issue #318 branch (Electron 39.8.10).
- Sites selected: 267 (all unique web logins from the password CSV).
- Sites with a terminal outcome analyzed: **267** (100%).
- **Collected: 52 / 267 = 19.5%.**

The collection rate did **not** increase versus Run 1's 19.6% partial-run
baseline. The `no-data` share fell slightly (45.7% → 43.4%), but the absolute
count rose because this run covered 83 more sites; the two runs therefore have
different denominators and are not a matched-site comparison.

Raw analyzer ranking (per-site terminal outcome):

| Rank | Cause | Count | Share |
| --- | --- | --- | --- |
| 1 | `no-data` | 116 | 43.4% |
| 2 | `wall:captcha` | 29 | 10.9% |
| 3 | `wall:identity-verification` | 15 | 5.6% |
| 4 | `unreachable:dns-not-found` | 13 | 4.9% |
| 5 | `unreachable:timeout` | 13 | 4.9% |
| 6 | `unreachable:navigation-failed` | 12 | 4.5% |
| 7 | `login-incomplete` | 11 | 4.1% |
| 8 | `wall:ambiguous` | 3 | 1.1% |
| 9 | `unreachable:certificate-error` | 2 | 0.7% |
| 10 | `wall:email-verification` | 1 | 0.4% |

The deterministic extractor regression tests pass, but this full real-site run
does not yet demonstrate a measurable collection-rate gain. Follow-up work
should use a matched fixture/site sample to separate extraction recall from
the changed site population and other login/wall causes.

### Run 1 — 2026-07-06 (partial: 184 of 267 sites)

- App: packaged build (`out/Soroeru-darwin-x64`, this branch, Electron 39.8.10).
- Sites selected: 267 (unique web logins from the 337-row password CSV).
- Sites with a terminal outcome analyzed: **184** (69%). The run was stopped
  early: it **hung on one site's CAPTCHA wall** (detected at the `initial`
  step) and made no progress for 40+ minutes — see cause C below. 184 sites is
  a representative sample with a decisive top cause.
- **Collected: 36 / 184 = 19.6%.**

Raw analyzer ranking (per-site terminal outcome):

| Rank | Cause | Count | Share |
| --- | --- | --- | --- |
| 1 | `no-data` | 84 | 45.7% |
| 2 | `login-incomplete` | 11 | 6.0% |
| 3 | `unreachable:dns-not-found` | 8 | 4.3% |
| 3 | `unreachable:navigation-failed` | 8 | 4.3% |
| 3 | `unreachable:timeout` | 8 | 4.3% |
| 6 | `wall:identity-verification` | 3 | 1.6% |
| 7 | `unreachable:certificate-error` | 2 | 1.1% |
| 7 | `wall:captcha` | 2 | 1.1% |
| 9 | `wall:email-verification` | 1 | 0.5% |
| — | `canceled` | 21 | 11.4% |

Reading note on `canceled`: the unattended driver skips a detected wall via the
UI, which aborts that site — so those 21 "canceled" rows are **wall-skips**, not
user aborts. This run's packaged app predated the fix that logs the domain on
cancel, so the analyzer could not rejoin them to their `wall detected` entries;
the driver logged exactly 21 skips. Counting them as walls, the **cause
families** are:

| Family | Count | Share | Actionable by Soroeru? |
| --- | --- | --- | --- |
| `no-data` | 84 | 45.7% | **Yes** — see cause A |
| walls (incl. 21 skipped + 6 handoff) | ~27 | ~14.7% | No — walls are by-design human hand-offs, never bypassed |
| `unreachable` (dns / nav / timeout / cert) | 26 | 14.1% | Partly — timeout/transient yes (cause C); defunct hosts & LAN IPs no |
| `login-incomplete` | 11 | 6.0% | **Yes** — see cause B |

(A later analyzer improvement now attributes a cancel-preceded-by-wall to the
wall automatically, so future runs will show these as `wall:*` directly.)

## Top-3 actionable causes and remediation

The raw top counts include walls (by design: hand off to the human, never a
"fix") and `unreachable:dns-not-found` (defunct hosts / LAN devices like
`192.168.1.1` — nothing for Soroeru to fix). The three **actionable** causes
that would most raise the collection rate, each with a deterministic-only and a
deterministic+AI hybrid proposal:

### A. `no-data` — 84 sites (46%) → Issue #318 (filed)

Account/profile pages often render registered info as **read-only text**
(`<dt>/<dd>`, table rows, label + `<span>`), not form inputs, so the
form-centric collector finds nothing and records `no-data`. This is the biggest
recoverable gap.

- **Deterministic:** add a label↔value text extractor reusing the classifier
  keywords (氏名/住所/メール/電話/郵便番号…) over definition lists, table rows,
  and label-adjacent text; read the value text locally.
  - Pros: no AI cost, deterministic/inspectable, offline, values stay local.
  - Cons: brittle to markup variety, JP-only heuristics, false positives.
- **Hybrid:** deterministic first; on a page that clearly shows account info but
  yields nothing, fall back to the AiEngine with the **structural skeleton only
  (values masked)** to return a node→attribute mapping; read values locally.
  - Pros: robust to layout variety, higher recall.
  - Cons: AI cost/latency; masking must be airtight so no raw PII leaves;
    deterministic must remain the default.

### B. `login-incomplete` — 11 sites (6%) → Issue draft ready (not yet filed)

Credentials submitted but a password field remains: multi-step logins
(email → next → password), JS/alternate submit buttons, or too-short a
post-submit wait.

- **Deterministic:** model multi-step login as a small state machine; wait for
  navigation/network-idle after submit; Enter-key submit fallback; detect error
  vs. next-step messages.
  - Pros: cheap, deterministic, credentials never leave the machine.
  - Cons: many site-specific variants; multi-step coverage is hard.
- **Hybrid:** on pages the deterministic path can't resolve, ask the AiEngine to
  classify the post-submit page structure (values/credentials masked) as
  next-step / error / wall / success; act locally.
  - Pros: adapts to unknown flows.
  - Cons: AI cost; credentials must never be sent; deterministic stays default.

### C. Batch hang / `unreachable:timeout` — 8 sites + the run-stopping hang → Issue draft ready (not yet filed)

`VisibilityRunner.runSite` has **no per-site hard deadline**, so a hung
navigation or a wall waiting on an absent human can stall the whole queue
indefinitely (exactly what stopped this run). Some sites also hit navigation
timeouts.

- **Deterministic:** wrap each site run in a hard timeout (≈2–3 min) that falls
  through to a `timed-out` outcome and advances the batch; bounded retry for
  transient timeouts; guarantee forward progress on walls in unattended mode at
  the runner level, not only in the UI harness.
  - Pros: simple, guarantees progress, no AI, structurally prevents the hang.
  - Cons: choosing the limit; may cut off slow-but-valid sites.
- **Hybrid:** deterministic timeout plus optional AI triage of ambiguous stalls.
  - Pros: could avoid cutting off "almost done" pages.
  - Cons: low cost/benefit here; deterministic is expected to suffice.

## Causes ranked 4th and below (analysis only)

Per Issue #317, these are analyzed but not yet slated for remediation; revisit
if fixing A–C does not raise the collection rate.

- **Walls (`wall:*`, ~27 incl. skipped)** — CAPTCHA / MFA / identity / email
  verification. **By design** these are detected and handed off to the human,
  never bypassed; not a defect. The only product lever is smoothing the
  hand-off UX, not raising automated collection.
- **`unreachable:dns-not-found` (8)** — defunct hosts and LAN-only devices
  (e.g. router admin at a private IP) imported from the password manager.
  Nothing for Soroeru to collect; could be surfaced to the user as "likely dead
  entry, consider removing."
- **`unreachable:navigation-failed` (8) / `certificate-error` (2)** — generic
  navigation failures and TLS issues; partly overlaps with C (retry may help),
  partly genuinely unreachable.
- **`non-web-credential`** — `android://` app entries; correctly skipped.

## Re-running

Re-run `npm run diagnostics:collect` after A–C land and append a new run
section; compare the collection rate and the `no-data` share against Run 1.
