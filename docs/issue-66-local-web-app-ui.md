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
5. Registration, bulk update, gate, missing-data prompt, and wall hand-off will
   be wired as background runs with in-memory pending steps. The browser UI
   resolves `Gate.decide`, missing-data prompts, and wall/final-submit
   hand-offs by POSTing explicit user decisions back to the local server.

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

Next workflow routes:

- `POST /registration/start`: create an in-memory background registration run.
- `GET /runs/:id`: show progress, logs, pending gate/missing-data/wall steps,
  and final result.
- `POST /runs/:id/gate`: resolve `Gate.decide`.
- `POST /runs/:id/missing-data`: resolve `promptUser`.
- `POST /runs/:id/handoff`: resume or abort wall hand-off.
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
2. **Registration run wiring**:
   - add in-memory run state and progress pages;
   - implement web `Gate`, missing-data prompt, wall hand-off, and final-submit
     hand-off resolvers;
   - launch headed Playwright sessions through `CatashiroApp.launchBrowser`;
   - show phase-progress notes from PERF-001 in the run page.
3. **Bulk-update execution**:
   - turn stale-field candidates into selected background update runs;
   - show before/after field labels and per-site progress;
   - preserve existing guard and wall behavior through `AppRunner.update`.
4. **Manual UX verification and polish**:
   - run the fake-data manual path: unlock -> add profile -> start local test
     registration -> approve gate -> complete -> see site record;
   - verify responsive layout on narrow and desktop widths;
   - update `docs/manual-test.md` once the registration run wiring is usable.

## Verification Plan

- `npm run typecheck`
- `npm test`
- `npm run poc -- check-egress`
- `npm run poc -- check-persistence`
- `npm run poc -- check-bypass`
- After run wiring lands: `npm run poc:matrix -- deterministic chromium` and a
  manual browser walkthrough using fake data only.

