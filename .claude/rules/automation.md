---
paths:
  - "src/agent/**"
  - "extension/**"
  - "native-host/**"
  - "electron/**/*session*"
---

# Browser automation

- Keep `PageDriver` browser-neutral; the owned extension is the production target; Native Messaging is migration-only. Playwright is for development tests after cutover.
- Keep field classification separate from wall detection. Japanese-only matching is current scope.
- Detect CAPTCHA, MFA/OTP, verification, bot detection, and rate limits conservatively. Pause and
  hand off; never solve, hide, bypass, or weaken them.
- Follow the owning security policy for structure-only AI and the future consented read path.
  AI never receives secrets, gains a general browser tool, or treats page content as authorization.
- Validate proposed elements, same-site/read-only policy, budgets, and wall state locally before
  execution. Stored collection maps are encrypted candidates; stale maps fail safely.
