# Soroeru Chrome bridge prototype

This is a developer-only Manifest V3 prototype. It is not included in the MVP
DMG and has no Chrome Web Store distribution.

Build the unpacked directory with:

```bash
npm run build:extension
```

Load `dist/extension/` in Chrome's developer-mode **Load unpacked**
flow after the Electron/native-host setup from the bridge documentation. The
extension requests only the static permissions in `manifest.json`; each
HTTPS origin is requested from the popup after the user clicks the permission
button. The service worker binds one explicit tab and rejects other tabs or
origins. It does not read cookies/history/bookmarks, make network requests, or
solve/bypass CAPTCHA, MFA, bot detection, or other access controls.

The Side Panel (`sidepanel.html`, Issue #557) holds the encrypted vault: it
stores only the Vault v2 ciphertext document in IndexedDB (`soroeru-vault`),
keeps the unlocked master key as a non-extractable `CryptoKey` in the panel's
memory, and drops it on lock, panel close, or browser restart. One exclusive
Web Lock makes a single panel the writer; another window's panel shows "in use
elsewhere". Open it from Chrome's side panel menu. The manifest adds
`sidePanel`, `unlimitedStorage`, and a CSP allowing `wasm-unsafe-eval` (for the
Argon2id WebAssembly KDF) but never `unsafe-eval`.

The content script reuses the structure-only scanner used by Playwright. Raw
field/display values are returned only for an explicit command and are not
persisted or logged by the extension.

## Tier 1 shared form schemas (#560)

Build with `VITE_SOROERU_CLOUD_API_URL` set to the reviewed HTTPS Cloud Run API
origin (no path, query, or credentials):

```bash
VITE_SOROERU_CLOUD_API_URL=<api-origin> npm run build:extension
```

After unlocking the Side Panel, enable **クラウド支援を使う** to allow
lookup. Assistance defaults to off and the preference is encrypted in the vault.
Tier 1 lookup sends only the Site Account's normalized registrable domain, the #518
structure-only fingerprint, and the client version. Configure the Site Account
with the registrable domain; do not configure a personalized subdomain as its domain.

The Content Script rechecks walls, automation-prohibiting terms, the page fingerprint,
and each field's unique anchor and deterministic classification before reading.
Values return directly to the Side Panel and stay local. A mismatch affects that
field alone. Unresolved mappings fall back to Tier 2 below; remaining unresolved
fields produce an unknown-state constraint. Tier 3 is a follow-up Issue. Password/CVV collection is not added by this path, and schemas
never authorize a fill or submission.

Resolved schemas and retrieval times are saved in the encrypted `formSchemaCache`.
When assistance is off or Cloud is unreachable, matching cached schemas remain
usable. A live `none` response does not reuse a potentially obsolete cache. A cache
or server schema with confidence below 0.8 is not used. Cache and deterministic
collection work even in builds without a configured Cloud origin.

## Tier 2 structure fallback (#561)

The cloud-assistance switch also enables structure-only Gemini mapping when the
schema service is reachable and Tier 1 leaves fields unresolved. Sanitization
runs in the leased Content Script. Only known structural name/id tokens and exact
field-label/heading vocabulary survive; pattern-redacted ambiguous prose is
omitted. Values, options, checked state and display text never leave the page.
Value shapes are included only for locally classified non-secret inputs; unknown
and secret items carry no value shape. This conservative vocabulary can leave
unusual labels unresolved.

Mappings are validated against sent IDs and then pass the same live local
classifier, wall and anchor checks as Tier 1. A changed page or lease discards the
proposal. Values are read locally; there is no fill, submit or Tier 3 path.
When telemetry sharing is enabled, successful mappings are saved in the encrypted
bounded feedback queue; telemetry off records none. Queue delivery and schema
promotion remain follow-up work. Gemini outages never trigger a raw-value fallback.
