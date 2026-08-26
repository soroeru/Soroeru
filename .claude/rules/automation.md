---
paths:
  - "src/agent/**"
  - "extension/**"
  - "native-host/**"
  - "electron/**/*session*"
---

# Browser automation

- Keep `PageDriver` browser-neutral; the owned extension and Native Messaging are the production
  front door. Playwright is for development tests after cutover.
- Keep field classification separate from wall detection. Japanese-only matching is current scope.
- Detect CAPTCHA, MFA/OTP, verification, bot detection, and rate limits conservatively. Pause and
  hand off; never solve, hide, bypass, or weaken them.
- AI may observe sanitized structure and propose a closed-schema plan. It must not receive raw
  personal values, gain a general browser tool, or treat page content as authorization.
- Validate proposed elements, same-site/read-only policy, budgets, and wall state locally before
  execution. Stored collection maps are encrypted candidates; stale maps fail safely.
