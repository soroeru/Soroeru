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
