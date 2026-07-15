# Chrome Bridge Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Finder-launched packaged apps persist an opt-in Chrome bridge setting and strict extension ID, while environment variables remain authoritative.

**Architecture:** A focused main-process file store loads before bridge creation and exposes a narrow service to `SoroeruSession`. Typed IPC carries sanitized configuration state to the existing React panel; setting changes are startup-applied, while disabling first performs certain cleanup and stops the current listener.

**Tech Stack:** Electron 43, TypeScript 5.8, React 19, Node test runner, Node filesystem APIs.

## Global Constraints

- Branch starts at dependency #391 commit `b070a5e` and changes only Issue #371.
- Defaults are OFF/empty; resolution is `environment > stored > default` per field.
- Chrome IDs must match `/^[a-p]{32}$/`; malformed settings and environment values fail closed.
- No raw PII, credentials, tokens, or page content enter settings, IPC, logs, tests, or new egress.
- Never-bypass and existing Playwright/extension collection behavior remain unchanged.
- A failed or uncertain cleanup must not persist or report OFF.

---

### Task 1: Local settings resolution and persistence

**Files:**
- Create: `electron/chrome-bridge-settings.ts`
- Create: `tests/unit/soroeru-chrome-bridge-settings.test.ts`
- Modify: `electron/main.ts`

**Interfaces:**
- Produces: `ChromeBridgeSettingsStore.load()`, `.resolve(env)`, `.save(input)`, `isValidChromeExtensionId()` and typed stored/resolved settings.

- [ ] Write tests proving missing/malformed files default OFF, strict IDs, per-field environment precedence, invalid environment fail-closed, atomic `0600` save, and reload.
- [ ] Run `npm run build && node --test dist/compiled/tests/unit/soroeru-chrome-bridge-settings.test.js`; verify failures are caused by the missing module.
- [ ] Implement the minimal store with strict parsing and temp-file/rename replacement.
- [ ] Run the focused test and verify it passes.
- [ ] Update `electron/main.ts` to await resolved settings before constructing the bridge and use the effective validated ID.

### Task 2: Typed session and IPC configuration lifecycle

**Files:**
- Modify: `electron/ipc/contract.ts`
- Modify: `electron/ipc/bridge.ts`
- Modify: `electron/preload-api.ts`
- Modify: `electron/preload.ts`
- Modify: `electron/session.ts`
- Modify: `tests/unit/soroeru-ipc-permission.test.ts`

**Interfaces:**
- Produces: `ChromeBridgeConfigurationView`, `SetChromeBridgeConfigurationRequest`, `chromeBridge.configuration()` and `.setConfiguration(request)`.
- Consumes: the Task 1 settings service injected into `SoroeruSession`.

- [ ] Add failing IPC/session tests for sanitized configuration reads, invalid request rejection, restart calculation, cleanup-before-save ordering, close/unregister failures, and no save after unknown permission cleanup.
- [ ] Run the focused IPC test and verify expected assertion failures.
- [ ] Add allowlisted channels and preload methods with exact input normalization.
- [ ] Extend disconnect to surface listener/unregister cleanup failure; implement configuration mutation with cleanup-before-save.
- [ ] Run the focused test and existing bridge tests; verify green.

### Task 3: Accessible React settings UI

**Files:**
- Modify: `src/renderer/components/ChromeBridgePanel.tsx`
- Modify: `src/renderer/chrome-bridge-ui.ts`
- Modify: `tests/unit/soroeru-renderer-chrome-bridge.test.ts`

**Interfaces:**
- Consumes: Task 2 preload configuration API.
- Produces: always-visible labeled configuration form, override messaging, strict inline validation, and accurate current/after-restart status.

- [ ] Add failing helper tests for strict ID validation and restart copy that distinguishes current ON/OFF from stored next-start state.
- [ ] Run the focused renderer test and verify failures.
- [ ] Implement helpers and the native labeled checkbox/text input form with `role="status"` and `role="alert"` feedback.
- [ ] Keep existing connect/permissions/cleanup controls visible only for effective runtime enablement.
- [ ] Run focused renderer tests and typecheck; verify green.

### Task 4: Documentation and complete verification

**Files:**
- Modify: `docs/development.md`

**Interfaces:**
- Documents the UI-first packaged/dev setup, restart semantics, and environment override precedence.

- [ ] Replace environment-only setup with Settings-first instructions while retaining explicit developer override commands.
- [ ] Run `npm run format`, `npm run lint`, `npm run typecheck`, focused tests, `npm test`, and `npm run release:check`; read complete outputs.
- [ ] Review `git diff` against Issue #371 and dependency #391 for scope, privacy, never-bypass, and accessible restart-state coverage.
- [ ] Commit implementation; record that local review budget 2/2 was exhausted by design review attempts.
- [ ] Push and open a stacked PR targeting `issue-391-chrome-extension-primary` with `Closes #371` and review findings/fixes.
