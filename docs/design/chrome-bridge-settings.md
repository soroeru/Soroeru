# Chrome Extension Bridge Settings Design

Issue: #371
Dependency: #391 at `b070a5e`

## Goal and scope

Allow a packaged Soroeru app launched from Finder to configure the Chrome extension bridge without environment variables. The bridge remains off by default, the extension ID is entered explicitly, and the current migration/developer warning remains visible. This issue does not change extension commands, site permissions, collection behavior, Playwright behavior, or the never-bypass boundary.

Issue #391 selects the Chrome extension as the production browser direction, but its distribution and binding UX are still migration-stage. The settings copy will describe that state instead of implying that the architecture itself is merely experimental.

## Chosen approach

Persist a small non-sensitive settings document below Electron's `userData` directory and apply it at process startup. A settings change is saved immediately but runtime enablement and extension-ID changes require an application restart.

This is preferred to dynamic bridge replacement because `electron/main.ts` constructs the bridge once and `SoroeruSession` captures the bridge and native-host setup for its lifetime. Mutating those dependencies would introduce socket, handshake, in-flight collection, and teardown races. Keeping a listener alive while displaying OFF was rejected because OFF must actually mean that the listener is not running.

## Local settings and precedence

A focused main-process module owns `chrome-bridge-settings.json`:

```ts
interface ChromeBridgeStoredSettings {
  version: 1;
  enabled: boolean;
  extensionId: string;
}

interface ChromeBridgeResolvedSettings {
  enabled: boolean;
  extensionId: string;
  enabledSource: "environment" | "stored" | "default";
  extensionIdSource: "environment" | "stored" | "default";
}
```

Resolution is per field: a present environment variable overrides the stored value, which overrides the default (`false` and `""`). `SOROERU_ENABLE_CHROME_BRIDGE` accepts only `"1"` or `"0"`; another present value fails closed to disabled. `SOROERU_CHROME_EXTENSION_ID` must match Chrome's 32-character lowercase `a`–`p` ID alphabet. Stored IDs use the same validator. Invalid or malformed stored content is treated as default OFF/empty and is never partially trusted.

The ID is public configuration, not personal data or a secret. The document is nevertheless local-only, written atomically with mode `0600`, and never logged in full. It is available before vault unlock because listener creation happens at application startup.

## Runtime lifecycle and state transitions

At startup, `electron/main.ts` loads and resolves settings before bridge construction. The resolved values replace the current module-level environment-only constants. Enablement requires a valid effective extension ID; if it is empty or invalid, resolution fails closed to an effectively disabled bridge and reports the validation problem. The listener does not start, and Soroeru never guesses or installs an unallowlisted ID.

The typed IPC surface exposes a sanitized configuration view and one mutation:

```ts
interface ChromeBridgeConfigurationView {
  stored: { enabled: boolean; extensionId: string };
  effective: ChromeBridgeResolvedSettings;
  restartRequired: boolean;
  validationError?: "invalid-extension-id";
}

interface SetChromeBridgeConfigurationRequest {
  enabled: boolean;
  extensionId: string;
}
```

The session receives a narrow settings service rather than direct filesystem access. IPC validates exact booleans and strict extension IDs; unknown or invalid input returns a sanitized failure without writing.

Enabling or changing the ID persists the requested state and returns `restartRequired: true` when it differs from effective startup state. The bridge does not start dynamically.

Disabling follows strict ordering:

1. If the runtime bridge is registered or connected, run an extended disconnect path, including permission cleanup, listener close, and native-host unregister.
2. Extend `ChromeBridgeMutationResult` so listener-close or native-host-unregister failure returns `ok: false`, `error: "cleanup-failed"`, plus existing manual-cleanup metadata. An unknown permission state also prevents the settings mutation even though the standalone disconnect control may continue to report the manual cleanup guidance it provides today.
3. Only after successful cleanup atomically persist `enabled: false`.
4. Successful cleanup stops the current listener immediately. The startup configuration and injected session capability still describe an enabled process until restart, so return a configuration view whose accessible restart notice says the connection listener has stopped and OFF becomes the startup state after restart. No UI text claims the stored setting is already the effective startup configuration.

Environment overrides remain authoritative. The UI disables overridden fields (or marks them read-only), names the overriding variable, and does not claim a stored edit can change the effective value. Saving a non-effective value remains unnecessary.

## Renderer design

`ChromeBridgePanel` always renders the migration-stage configuration section, even when the runtime bridge is disabled. It includes:

- a labeled checkbox for enablement;
- a labeled, spellcheck-disabled extension-ID text input with inline validation;
- source/override text when an environment variable controls a field;
- a save button with busy state;
- a `role="status"` success message and a `role="alert"` validation/cleanup failure;
- an unmistakable restart notice that names whether the currently running process is still ON or OFF.

Existing registration, connection, permission revocation, and cleanup controls render only when the effective runtime is enabled. Keyboard focus and native label/control associations are preserved; no custom switch behavior is introduced.

## Failure handling and privacy

- Missing, unreadable, malformed, or unsupported-version settings fail closed to defaults.
- Atomic write failure leaves the prior file intact and returns a sanitized persistence error.
- Failed or uncertain cleanup leaves stored enablement unchanged. Listener-close and native-host-unregister failures are no longer swallowed by the disconnect result; the UI retains existing manual permission-cleanup details alongside the sanitized failure.
- The extension ID may appear in its settings input but is not added to diagnostics logs.
- No raw personal value, credential, page content, or permission token is added to IPC, logs, or network egress.
- CAPTCHA, MFA, bot detection, rate limits, and access controls remain hand-off boundaries; this feature changes no automation command.

## Test strategy

Use test-driven development for each behavior:

- unit tests for strict ID/boolean validation, malformed-file fail-closed behavior, per-field `env > stored > default` precedence, and atomic persistence/reload;
- session/IPC tests for sanitized configuration views, invalid request rejection, cleanup-before-disable ordering, no OFF persistence after failed or uncertain cleanup, and restart-required calculation;
- renderer helper/component tests for environment override presentation, validation, accessible status/alert copy, and current-vs-after-restart wording;
- existing bridge, IPC permission, renderer, typecheck, lint, formatting, unit, bypass, egress, persistence, audit, and release gates;
- manual packaged-app verification from Finder for persistence across restart and the existing registration → handshake → per-site permission → collection flow using fake data only.

## Acceptance mapping

- UI enablement and ID persistence: local settings module, typed IPC, and configuration form.
- Simpler reflection model: startup-only application with explicit restart state.
- Environment override compatibility: per-field resolution and source metadata.
- OFF behavior: cleanup succeeds before OFF is persisted; otherwise state stays enabled.
- Development documentation: update `docs/development.md` §3.2 for UI-first setup and environment overrides.
