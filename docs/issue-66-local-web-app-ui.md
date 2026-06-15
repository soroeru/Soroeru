# Issue #66: Local Web App UI Plan

Issue #66 replaces the terminal `npm run poc -- ui` menu with a local browser UI
for non-technical users. The UI change must preserve the RFC-001 v3 product
direction: local-first encrypted storage, no telemetry or cloud sync, no raw
personal values to AI providers, the review-and-confirm gate, the three guards,
and detect-only wall hand-off.

## Goals

- Make `npm run poc -- ui` start a browser-openable local web app instead of an
  interactive terminal menu.
- Keep the app local-only: bind to `127.0.0.1`, do not add telemetry, do not add
  a hosted backend, and do not upload the encrypted store.
- Provide an onboarding / unlock screen that explains the master passphrase,
  encrypted local storage, and recovery key in plain language.
- Provide browser forms for personal data, site inventory, bulk-update
  candidates, registration start, review-and-confirm gate, wall hand-off, and
  AI-provider settings.
- Keep sensitive values masked by default. Revealing card/CVV/password/API-key
  values requires master-passphrase re-entry.
- Reuse the existing `CatashiroApp`, `PocStore`, `AppRunner`, `Gate`, and
  `AppRunnerHooks` seams rather than changing agent or automation behavior.

## Non-Goals

- No cloud storage, hosted service, multi-user mode, telemetry, or sync.
- No change to encryption algorithms or store format.
- No change to registration safety behavior: the gate, three guards, payment
  stop, no auto-attestation, auto-creation-prohibited fill-only behavior, and
  wall hand-off remain owned by the existing agent layer.
- No CAPTCHA/MFA/bot-detection bypass or solving.
- No new frontend framework or runtime dependency for the first slice. A
  framework can be reconsidered only if the no-dependency server-rendered UI
  becomes the bottleneck.

## Product Decisions

1. `npm run poc -- ui [deterministic|ai] [port]` becomes the local web app
   launcher. It prints the `127.0.0.1` URL. The old CLI menu remains as
   `npm run poc -- ui:cli [deterministic|ai]` for developer fallback while the
   web workflow reaches parity.
2. The first implementation slice is server-rendered HTML/CSS over Node's
   built-in `http` module. This avoids adding a framework before the UI shape
   stabilizes and keeps the security review small.
3. The app binds to `127.0.0.1` only and rejects unsafe methods/routes. POST
   routes require an in-memory CSRF token embedded in server-rendered forms.
4. The web UI reads and writes personal data only through the unlocked
   `CatashiroApp.store`. Raw values are never logged or persisted outside the
   encrypted store. Display masking uses the existing `maskValue` policy.
5. Registration, gate, missing-data prompt, and wall hand-off are wired as a
   background run with in-memory pending steps (#81). The browser UI resolves
   `Gate.decide`, missing-data prompts, and wall hand-offs by POSTing explicit
   user decisions back to the local server. Bulk update will follow the same
   pattern (#88).

## Architecture

```text
npm run poc -- ui
  -> run/cli.ts
  -> startWebUiServer()
  -> CatashiroApp (unlock/lock/store/browser lifecycle)
  -> AppRunner (registration/update automation boundary)
  -> existing agent/gate/guards/walls/store modules
```

The local web server is not an external service. It is an in-process UI facade
over the same app shell used by the CLI. It must not introduce new network
destinations beyond local browser requests to `127.0.0.1`; the automation layer
continues to be the only code that navigates to target sites and the AI provider
layer remains the only AI egress path.

## Route Plan

Current foundation routes:

- `GET /`: locked onboarding screen or unlocked dashboard.
- `POST /unlock`: unlock or create the encrypted store with the master
  passphrase.
- `POST /unlock-recovery`: unlock with a previously generated recovery key.
- `POST /lock`: drop decrypted values from memory.
- `POST /profile/save`: add or edit a known/custom profile field.
- `POST /profile/delete`: delete a local profile field.
- `POST /profile/reveal`: reveal a value after passphrase re-entry when
  required.
- `POST /settings/provider`: save provider/model/API key into the encrypted
  store.
- `POST /recovery/generate`, `POST /recovery/verify`, `POST /recovery/remove`:
  manage recovery keys locally.

Registration run routes (implemented, #81 — see
[`extension.md`](extension.md) §13 for the as-built description of
`RegistrationSession`):

- `POST /registration/start`: create the single in-memory background
  registration run and launch a headed Playwright session.
- The sites tab (`GET /?tab=sites`) renders the run's current
  `RegistrationSession` state (`running` / `awaiting-data` / `awaiting-gate` /
  `awaiting-handoff` / `done` / `error`) in place of `GET /runs/:id`, and
  auto-refreshes while `running`.
- `POST /registration/provide-data`: resolve `promptUser` (replaces
  `POST /runs/:id/missing-data`).
- `POST /registration/gate-decision`: resolve `Gate.decide` (replaces
  `POST /runs/:id/gate`).
- `POST /registration/handoff-resolve`: resume or abort wall hand-off
  (replaces `POST /runs/:id/handoff`).
- `POST /registration/dismiss`: close a finished (`done` / `error`) run.

Bulk-update routes (remaining, #88):

- `POST /bulk/start`: create an in-memory background bulk-update run over
  selected stale sites.

## UI Requirements

- First screen is the usable app state: onboarding/unlock before unlock,
  dashboard after unlock.
- Use plain labels and actions, not implementation terminology.
- Keep dense operational screens scannable: summary counters, profile list,
  site inventory, update candidates, settings, and next action panels.
- Avoid decorative-only UI. The UI should show real app state from the encrypted
  store and mandates.
- Provide empty states for no profile fields, no sites, no update candidates,
  and no provider settings.
- Render page-derived / site-derived text as escaped text only.

## Security Controls

- Bind to `127.0.0.1`; never `0.0.0.0` by default.
- Do not enable CORS.
- Require CSRF token on every POST route.
- Never include raw sensitive values in logs, query strings, or persisted
  files. Reveal responses are rendered directly only after successful
  passphrase verification.
- Keep API keys, cards, CVV, passwords, recovery keys, and profile values inside
  the encrypted store or one-time user-visible forms.
- Continue to run `npm run poc -- check-egress`, `npm run poc --
  check-persistence`, and `npm run poc -- check-bypass` for code changes.

## Implementation Slices

1. **Foundation web shell (this branch start)**:
   - add `startWebUiServer`;
   - make `npm run poc -- ui` launch the local web UI;
   - keep CLI fallback as `ui:cli`;
   - implement unlock/recovery unlock, lock, dashboard, profile add/edit/delete,
     reveal, provider settings, recovery-key controls, site inventory, and
     bulk-update candidate display;
   - add unit tests for local-only routing, CSRF protection, masking, profile
     persistence, and settings persistence.
2. **Registration run wiring (done, #81)**:
   - `RegistrationSession` (`src/app/registration-session.ts`) holds the
     in-memory run state and pause point;
   - the web `Gate`, missing-data prompt, and wall hand-off resolvers are the
     `/registration/*` routes above;
   - registration launches a headed Playwright session through
     `CatashiroApp.launchBrowser`;
   - `RegistrationSession.notes` carries the run's log messages, rendered on
     the sites tab.
3. **Bulk-update execution (done, #88)**:
   - stale-field candidates render as selected site/field checkboxes;
   - `BulkUpdateSession` turns those selections into background update runs;
   - the Web UI shows per-site progress, confirmation gates, wall hand-off, and
     per-site results;
   - existing guard and wall behavior is preserved through `AppRunner.update`.
4. **Manual UX verification and polish**:
   - run the fake-data manual path: unlock -> add profile -> start local test
     registration -> approve gate -> complete -> see site record (covered by
     `docs/manual-test.md` §2/§3 and `tests/unit/catashiro-poc-registration.test.ts`);
   - verify responsive layout on narrow and desktop widths;
  - keep `docs/manual-test.md` aligned as run pages grow beyond the MVP bulk
    update wiring.

## Verification Plan

- `npm run typecheck`
- `npm test`
- `npm run poc -- check-egress`
- `npm run poc -- check-persistence`
- `npm run poc -- check-bypass`
- After run wiring lands: `npm run poc:matrix -- deterministic chromium` and a
  manual browser walkthrough using fake data only.
