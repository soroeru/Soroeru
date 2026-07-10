# Soroeru Chrome bridge prototype

This is a developer-only Manifest V3 prototype. It is not included in the MVP
DMG and has no Chrome Web Store distribution.

Build the unpacked directory with:

```bash
npm run build:extension
```

Load `dist/extension/` in Chrome's developer-mode **Load unpacked**
flow after the Electron/native-host setup from the bridge documentation. The
extension requests only the four static permissions in `manifest.json`; each
HTTPS origin is requested from the popup after the user clicks the permission
button. The service worker binds one explicit tab and rejects other tabs or
origins. It does not read cookies/history/bookmarks, make network requests, or
solve/bypass CAPTCHA, MFA, bot detection, or other access controls.

The content script reuses the structure-only scanner used by Playwright. Raw
field/display values are returned only for an explicit command and are not
persisted or logged by the extension.
