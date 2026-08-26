# Agent definition guidance

- Deterministic field classification remains the default; keep scanner and classifier logic
  isolated and testable.
- AI receives sanitized form structure only and returns a closed-schema mapping plan. Substitute
  personal values locally after validation.
- Keep wall detection separate. CAPTCHA, MFA/OTP, verification, bot detection, and rate limits are
  hand-off points and must never be bypassed.
- Japanese-only detection is current scope. Do not add multi-locale behavior incidentally.
