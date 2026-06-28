# Real Visibility E2E

This directory is for local-only E2E harness code. Do not commit exported
password-manager CSV files, session files, screenshots, or result JSON here.

Run the real-site Visibility check explicitly:

```bash
CATASHIRO_E2E_PASSWORD_CSV=tests/e2e/Google_Passwords.csv npm run e2e:real-visibility
```

The CSV contains real credentials, so it is gitignored. The test never runs in
CI and never prints usernames, passwords, notes, or collected raw values.
