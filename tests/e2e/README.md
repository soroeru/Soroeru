# Browser E2E

The extension fixture suites use fake data and disposable browser profiles.
See [test strategy](../../docs/testing.md) and
[commands](../../docs/development.md#quality-gates) for Tier 1/Tier 2 coverage.

Retained Electron/real-site harnesses are migration tools, never CI prerequisites.
Use the [collection-diagnostics skill](../../skills/collection-diagnostics/SKILL.md)
only for an explicitly requested diagnostics run. Reports belong in the requesting
Issue/PR as categories/counts; account domains and raw values stay out of reports.
Do not commit password CSVs, session files, screenshots or generated result JSON.
