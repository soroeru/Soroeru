# Soroeru Chrome extension

The developer build runs its vault and Visibility host in the Side Panel without
Electron or a Native Messaging host. Chrome Web Store distribution is pending.
Build/load instructions are in [development](../docs/development.md#run-the-extension).

The Side Panel (`sidepanel.html`) holds the encrypted vault: it
stores only the Vault v2 ciphertext document in IndexedDB (`soroeru-vault`),
keeps the unlocked master key as a non-extractable `CryptoKey` in the panel's
memory, and drops it on lock, panel close, or browser restart. One exclusive
Web Lock makes a single panel the writer; another window's panel shows "in use
elsewhere". Open it from Chrome's side panel menu. The manifest adds
`sidePanel`, `unlimitedStorage`, and a CSP allowing `wasm-unsafe-eval` (for the
Argon2id WebAssembly KDF) but never `unsafe-eval`.

Encrypted import accepts every record schema version this build can open and
preserves the original encrypted document. Requesting an import during unlock
cancels that unlock; a successful import leaves the panel locked. Unlock again
with the imported vault's passphrase or recovery key.

Once unlocked, the panel shows the screens shared with the Electron renderer
(Issue #569): the disclosure ledger with batch collection, insights, and
settings (CSV import, log export), plus the extension's own "collect in this
tab" panel with Tier 3 consent and Cloud settings. The shared screens call the
same `window.soroeru` API as Electron; in the panel it is an adapter over the
panel's vault and Visibility host. Batch collection asks once for host access to
all selected sites. Runs started from the ledger never open the Tier 3 consent
gate, so they send no values to Cloud. The saved-page import renders the file
in a hidden extension frame whose CSP blocks all network loads and page
scripts. The log export holds only this panel session's redacted operational
events and is discarded when the panel closes.

The content script reuses the structure-only scanner used by Playwright. Raw
field/display values are returned only for an explicit command and are not logged; accepted disclosures are encrypted in the panel vault.

## Tier 1 shared form schemas

Build with `VITE_SOROERU_CLOUD_API_URL` set to the reviewed HTTPS Cloud Run API
origin (no path, query, or credentials):

```bash
VITE_SOROERU_CLOUD_API_URL=<api-origin> npm run build:extension
```

After unlocking the Side Panel, enable **クラウドのフォーム知識と Gemini を使う** under
「クラウドと共有の設定」 to allow
lookup. Assistance defaults to off and the preference is encrypted in the vault.
Tier 1 lookup sends only the Site Account's normalized registrable domain, the structure-only fingerprint, and the client version. Configure the Site Account
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

## Tier 2 structure fallback

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
bounded feedback queue; telemetry off records none. The queue is flushed
automatically when cloud reachability is confirmed (Issue #567): items are delivered
with exponential backoff (30 s / 60 s / 120 s), discarded after 4 failures or 7
days, and idempotency keys are reused across retries so the server applies each
event at most once. Schema promotion on the server side remains follow-up work.
Gemini outages never trigger a raw-value fallback.
