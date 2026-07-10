# Chrome Extension Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the Electron-main `ChromeExtensionBridge` for authenticated UNIX-socket communication with the native host described by Issue #336.

**Architecture:** Keep the existing dependency-free wire schema in `src/shared/chrome-bridge.ts` and reuse native-host token/framing helpers. Add a focused Electron-side bridge that owns the app-support socket lifecycle, authenticates the first `hello`, validates every subsequent message, relays valid messages, and emits only sanitized connection-state events through a new one-way typed IPC channel.

**Tech Stack:** TypeScript/Node.js `net.Server` and `net.Socket`, Electron IPC, Node test runner, existing native-host framing and token helpers.

## Global Constraints

- The prototype remains developer-only, feature-flagged, UI-hidden, and outside the MVP DMG.
- Never bypass CAPTCHA, MFA, bot detection, rate limits, or access controls; this bridge only transports already-authorized local messages.
- Reject token mismatch, unsupported schema/version, malformed messages, and unknown commands by closing the connection.
- Never log or persist message payloads; IPC events contain connection state, counts, or masked wording only.
- Keep the existing Playwright path unchanged and do not add dependencies.

### Task 1: Define and test the Electron bridge protocol boundary

**Files:**
- Create: `electron/chrome-extension-bridge.ts`
- Test: `tests/unit/soroeru-chrome-bridge.test.ts`

**Interfaces:**
- `ChromeExtensionBridgeOptions { socketPath: string; tokenPath: string; commandHandler?: (command: ChromeBridgeCommand) => Promise<ChromeBridgeMessage | undefined> | ChromeBridgeMessage | undefined; onEvent?: (event: ChromeBridgeEventView) => void }`
- `ChromeBridgeEventView = { type: "connecting" | "connected" | "disconnected" | "rejected"; reason?: "unauthorized" | "invalid-message" | "unknown-command" | "socket-error" }`
- `ChromeExtensionBridge.start(): Promise<void>` creates the listener and token, and `close(): Promise<void>` removes the listener, active socket, and token.
- The bridge accepts one authenticated socket at a time; a new connection replaces an old connection only after the old socket is destroyed.

- [x] **Step 1: Write failing tests** for a fake host that connects through a temporary UNIX socket, receives a `hello` with the generated token, and gets the `native-host-handshake` success result; add rejection tests for a wrong token and malformed/unknown messages; add disconnect cleanup assertions.
- [x] **Step 2: Run the focused test** with `npm test -- --test-name-pattern='ChromeExtensionBridge'` after compilation setup, and confirm it fails because the bridge module is missing.
- [x] **Step 3: Implement the minimal bridge** using `createHandshakeToken`, `removeHandshakeToken`, `decodeNativeMessages`, `encodeNativeMessage`, and `parseChromeBridgeMessage`; maintain per-socket framing remainder and authenticate before forwarding commands.
- [x] **Step 4: Run the focused test** and confirm the handshake, rejection, forwarding, and cleanup cases pass.
- [ ] **Step 5: Commit** with `feat: add electron chrome extension bridge`.

### Task 2: Add the masked typed IPC connection-status event

**Files:**
- Modify: `electron/ipc/contract.ts`
- Modify: `electron/preload-api.ts`
- Modify: `electron/preload.ts`
- Modify: `electron/main.ts`
- Test: `tests/unit/soroeru-ipc-permission.test.ts`

**Interfaces:**
- Add `CHROME_BRIDGE_EVENT_CHANNEL = "soroeru:chrome-bridge:event"`.
- Add `ChromeBridgeEventView` to the IPC contract with only the event type and safe reason code.
- Add `chromeBridge.onEvent(listener): () => void` to `SoroeruApi`; it subscribes only and never invokes an arbitrary renderer-supplied channel.
- Main creates the bridge behind an explicit developer-only environment/feature flag and forwards only `ChromeBridgeEventView` values to the renderer.

- [x] **Step 1: Extend the IPC test** to assert the new subscription exists, invokes no renderer channel, and that the existing invoke allowlist remains unchanged.
- [x] **Step 2: Run the IPC test** and confirm it fails because the API and event contract are absent.
- [x] **Step 3: Add the event contract and preload subscription** following the existing Visibility event pattern; do not expose raw bridge messages or payloads.
- [x] **Step 4: Add guarded main-process lifecycle wiring** so the bridge is not started by default and is closed during orderly shutdown when enabled.
- [x] **Step 5: Run the focused IPC tests and typecheck** and confirm they pass.
- [ ] **Step 6: Commit** with `feat: expose chrome bridge connection events`.

### Task 3: Run repository quality gates and prepare the PR

**Files:**
- Modify: `docs/superpowers/plans/2026-07-10-chrome-extension-bridge.md` only if task checkboxes need tracking.

- [x] **Step 1: Run** `npm run typecheck`, `npm test`, `npm run lint`, and `npm run format`.
- [x] **Step 2: Review the diff** for raw-value logging, unintended Playwright changes, generated files, and scope creep.
- [ ] **Step 3: Apply one focused fix pass** if a quality gate or review identifies an actionable defect, then rerun the affected checks.
- [ ] **Step 4: Commit any required fix** using a message that states the defect corrected.
- [ ] **Step 5: Push** `codex/issue-336-chrome-extension-bridge` and open a PR containing `Closes #336`, verification results, local AI review status, and residual risks.

## Self-review

- Scope coverage: socket lifecycle, per-start token authentication, schema validation, unknown-command rejection, cleanup, and sanitized IPC connection events are covered by Tasks 1–2.
- No new package or external service is needed.
- The existing shared schema and native-host framing/token signatures are reused exactly as defined above.
- The bridge is guarded and does not change the default Playwright path or expose a UI flow.
