# Dependency security

The [security policy](security.md#development-and-release-checks) owns dependency
risk handling; [development](development.md#quality-gates) owns executable gates.
Dependabot proposes updates and `scripts/audit-check.mjs` enforces the current
accepted-advisory policy. Review scope and expiry in
`scripts/accepted-advisories.json` before accepting an advisory; do not suppress
a failing gate with a broad permanent exception. CI configuration is in
`.github/workflows/ci.yml` and `.github/workflows/cloud.yml`.
