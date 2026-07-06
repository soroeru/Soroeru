---
name: collection-diagnostics
description: Run the packaged Soroeru app through a full unattended Visibility collection over the user's real password CSV, download/collect the diagnostics log, and rank collection-failure causes by frequency. Use when the user asks to measure or analyze why data collection fails across sites, to re-run the collection diagnostics, or to refresh the failure-cause ranking (Issue #317 workflow).
---

# Collection Diagnostics

Automates the repeatable loop from Issue #317: launch the packaged app, import
`tests/e2e/Google_Passwords.csv`, select every site, run a full Visibility
collection, obtain the diagnostics log, and rank the failure causes.

## Prerequisites

- The real password CSV at `tests/e2e/Google_Passwords.csv` (gitignored; real
  credentials — never commit, never print its contents).
- A packaged app build under `out/Soroeru-darwin-*/`. If it is missing or
  predates the current `main` (the diagnostics log needs Issue #314's logging),
  rebuild it first. `npm run package:dmg` builds the packaged app plus the DMG;
  it removes `out/` first and takes several minutes.
- The run drives a real, visible (headed) browser against real sites for a
  long time (337 sites ≈ multiple hours). Confirm the user expects that before
  starting a full run.

## Workflow

1. **Collect** (long-running — run it in the background and monitor its
   output):

   ```bash
   npm run diagnostics:collect
   ```

   Environment knobs:
   - `SOROERU_DIAG_APP` — packaged executable path, or `dev` for the dev build
     (default: newest `out/Soroeru-darwin-*/Soroeru.app/Contents/MacOS/Soroeru`).
   - `SOROERU_DIAG_CSV` — CSV path (default `tests/e2e/Google_Passwords.csv`).
   - `SOROERU_DIAG_MAX_SITES` — cap selected sites; use a small cap (e.g. 3)
     to smoke-test the harness before a full run.
   - `SOROERU_DIAG_TIMEOUT_MIN` — overall batch timeout (default 360).

   The script auto-skips wall hand-offs (CAPTCHA / MFA) via the UI skip button
   — the wall stays recorded as that site's failure cause; nothing is bypassed.
   It prints the per-run state root at start and the log path at the end:
   `state/soroeru-poc/collection-diagnostics/<timestamp>/logs/soroeru.log`.

2. **Analyze**:

   ```bash
   npm run diagnostics:analyze -- <stateRoot>/logs/soroeru.log
   ```

   Prints collected/failed totals and the failure causes ranked by count
   (`--json` for machine-readable output, `--no-sites` to omit domain lists).

3. **Report**: update `docs/collection-failure-analysis.md` with the new
   ranking (categories and counts only — never the domain list, which reveals
   which services the user uses) and compare against the previous run to see
   whether fixes moved the collection rate.

## Boundaries

- Fully local: no data leaves the machine beyond the collection's own
  target-site logins.
- Never print or commit credentials, collected values, or the user's domain
  list; committed docs carry cause categories and counts only.
- Never resolve a wall for the site (no CAPTCHA/MFA solving) — skip is the
  only unattended answer.
