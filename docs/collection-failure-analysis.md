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

### Run: (pending — filled in by the first full run)

- Date:
- App: packaged build (commit)
- Sites analyzed: / collected: / not collected:
- Ranking:

## Top-3 causes and remediation Issues

Filled in after the first full run: each of the top 3 causes gets a GitHub
Issue proposing both a deterministic-only fix and a deterministic+AI hybrid
fix, with pros/cons (Issue #317's deliverable).

## Causes ranked 4th and below

Cause analysis only (no remediation plan yet — revisit if fixing the top 3
does not raise the collection rate; Issue #317 scope).
