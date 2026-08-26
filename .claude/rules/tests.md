---
paths:
  - "tests/**"
  - "**/*.test.ts"
  - "**/*.e2e.ts"
---

# Tests

- Use fake personal data only. Never print or inspect the contents of the gitignored real-password
  CSV.
- Prefer behavior and observable outcomes over implementation details.
- Use condition-based waiting for asynchronous behavior. Use fixed sleeps only when elapsed time is
  itself the behavior under test.
- Mock code the repository owns at narrow boundaries; do not reproduce a third-party library in a
  large mock. Restore global state and isolate filesystem/network state per test.
- Apply the `writing-good-tests` skill when writing or reviewing tests.
