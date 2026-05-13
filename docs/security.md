# Security

This document owns security and privacy review notes for `formfill-assistant`.

Chrome extension permission usage belongs in [`extension.md`](extension.md).
This document explains why permissions and data handling choices are acceptable,
which boundaries must not be crossed, and how sensitive data is protected.

## 1. Security Principles

Write the security principles that must shape implementation and review.

- Least privilege
- Defense in depth
- Secure defaults
- No committed secrets

## 2. Threat Model

Write likely threats, impact, and mitigations for local profile data and page
interaction.

| Threat | Impact | Mitigation |
| --- | --- | --- |
|  |  |  |

## 3. Sensitive Data Handling

Write what data may be stored, what must not be stored, and how fake data should
be used in tests and docs.

## 4. Local Storage And Encryption Direction

Write local persistence expectations and future encryption considerations.

## 5. Extension Permissions Review

Write why requested permissions are acceptable, how host permissions stay
narrow, and which permissions are avoided.

## 6. Network And External Services

Write the default no-backend, no-telemetry, and no-profile-upload posture.

## 7. Human-Step Safety Boundaries

Write the prohibition on CAPTCHA bypass, MFA bypass, bot-detection bypass,
automatic terms acceptance, and automatic submission.

## 8. Input And DOM Safety

Write how page text, attributes, injected UI, and user-entered profile values
should be handled safely.

## 9. Dependency And Supply Chain

Write dependency, lockfile, update, and audit expectations once tooling exists.

## 10. Security Checklist

Write the checklist used before changing permissions, storage behavior, or form
filling behavior.

- [ ] Secrets are not committed
- [ ] Local state and logs are ignored by Git
- [ ] External inputs are validated
- [ ] Destructive operations require explicit confirmation
- [ ] Security-sensitive behavior is tested or manually verified
