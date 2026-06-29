# Real Visibility E2E

This directory is for local-only E2E harness code. Do not commit exported
password-manager CSV files, session files, screenshots, or result JSON here.

Run the real-site Visibility check explicitly:

```bash
SOROERU_E2E_PASSWORD_CSV=tests/e2e/Google_Passwords.csv npm run e2e:real-visibility
```

The CSV contains real credentials, so it is gitignored. The test never runs in
CI and never prints usernames, passwords, notes, or collected raw values.

For faster local iteration, cap how many imported sites are run (defaults to
all):

```bash
SOROERU_E2E_MAX_SITES=20 SOROERU_E2E_PASSWORD_CSV=tests/e2e/Google_Passwords.csv npm run e2e:real-visibility
```

The artifact under `state/soroeru-poc/e2e-real-visibility/` records counts only.
Per-site `status` legend:

- `collected` — logged in and collected at least one disclosure (success).
- `login-failed` — a password field still remained and nothing was collected
  (login did not take; recorded as a `login-incomplete` constraint).
- `no-data` — reached the page but found no collectable form values (the page may
  show values as plain text; recorded as a `no-collectable-data` constraint).
- `unreachable` — navigation failed (DNS / timeout / TLS / connection; recorded as
  an `access-unreachable` constraint). Includes defunct hosts and LAN-only devices.
- `handoff` — a CAPTCHA / MFA / verification wall was detected. In this automated
  E2E the handoff aborts (no human); the app/runtime uses the real resume path.
- `skipped` — a non-web credential (e.g. an `android://` app entry); not collectable.

Zero disclosures is never reported as `collected`.
