// Preflight for the macOS DMG packaging path (`npm run package:dmg`).
//
// The DMG maker chain (@electron-forge/maker-dmg → electron-installer-dmg →
// appdmg) pulls in nan-based native modules (macos-alias, fs-xattr). Those do
// not compile against the V8 headers shipped with Node 23+, so on a too-new
// Node the OPTIONAL `appdmg` dependency is silently skipped at install time and
// the build later fails with a cryptic `Cannot find module 'appdmg'`.
//
// This repository targets Node 22 LTS (see .nvmrc / CI). Fail fast here with an
// actionable message instead of letting the packaging step surface the opaque
// module-not-found error.

const MIN_MAJOR = 20; // appdmg native deps build on 20–22
const MAX_MAJOR = 22; // …and break on 23+

const major = Number(process.versions.node.split(".")[0]);

if (major < MIN_MAJOR || major > MAX_MAJOR) {
  console.error(
    [
      "",
      `✗ DMG packaging requires Node ${MIN_MAJOR}–${MAX_MAJOR} (current: v${process.versions.node}).`,
      "",
      "  The DMG maker's native dependency `appdmg` (macos-alias / fs-xattr) does not",
      "  build on Node 23+, so it is silently skipped and the build fails with",
      "  `Cannot find module 'appdmg'`.",
      "",
      "  Use the project's Node version (matches .nvmrc and CI), then reinstall so the",
      "  native modules build, and retry:",
      "",
      "    nvm use            # or: nvm install 22 && nvm use 22",
      "    npm ci             # rebuilds appdmg's native modules under Node 22",
      "    npm run package:dmg",
      "",
    ].join("\n"),
  );
  process.exit(1);
}
