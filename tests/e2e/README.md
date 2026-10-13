# Browser E2E

The extension fixture suites use fake data and disposable browser profiles.
See [test strategy](../../docs/testing.md) and
[commands](../../docs/development.md#quality-gates) for Tier 1/Tier 2 coverage.

`npm run e2e:extension-demo` runs a separate Playwright Test suite against the
built unpacked extension. It copies the extension into a disposable profile,
seeds only fake records through the production encrypted vault API, serves the
four pages in `sites/extension-demo/` at a fake HTTPS origin, and mocks only the
Cloud HTTP boundary. Unrecognized HTTPS traffic is blocked. The helper does
not call a real Cloud project or site. Browser profiles and fixture copies are
removed after each case.

Retained Electron/real-site harnesses are migration tools, never CI prerequisites.
Use the [collection-diagnostics skill](../../skills/collection-diagnostics/SKILL.md)
only for an explicitly requested diagnostics run. Reports belong in the requesting
Issue/PR as categories/counts; account domains and raw values stay out of reports.
Do not commit password CSVs, session files, screenshots or generated result JSON.
