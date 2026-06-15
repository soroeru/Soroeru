#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="Catashiro"
RELEASE_DIR="$ROOT_DIR/release"
APP_DIR="$RELEASE_DIR/$APP_NAME.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"
BUNDLE_APP_DIR="$RESOURCES_DIR/app"
ZIP_PATH="$RELEASE_DIR/$APP_NAME-mac-beta.zip"

cd "$ROOT_DIR"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "error: package:mac must run on macOS so the artifact can be smoke-tested on the beta target." >&2
  exit 1
fi

if [[ ! -d node_modules ]]; then
  echo "error: node_modules is missing. Run npm ci before packaging." >&2
  exit 1
fi

npm run build

rm -rf "$APP_DIR" "$ZIP_PATH"
mkdir -p "$MACOS_DIR" "$BUNDLE_APP_DIR/dist" "$BUNDLE_APP_DIR/node_modules" "$RESOURCES_DIR"

cp package.json package-lock.json "$BUNDLE_APP_DIR/"
cp -R dist/compiled "$BUNDLE_APP_DIR/dist/"
rsync -a --delete node_modules/ "$BUNDLE_APP_DIR/node_modules/"

cat > "$CONTENTS_DIR/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>Catashiro</string>
  <key>CFBundleExecutable</key>
  <string>Catashiro</string>
  <key>CFBundleIdentifier</key>
  <string>app.catashiro.beta</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Catashiro</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundleVersion</key>
  <string>0.1.0</string>
  <key>LSMinimumSystemVersion</key>
  <string>14.0</string>
</dict>
</plist>
PLIST

cat > "$MACOS_DIR/$APP_NAME" <<'LAUNCHER'
#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="$(cd "$(dirname "$0")/../Resources/app" && pwd)"
LOG_DIR="$HOME/Library/Logs/Catashiro"
mkdir -p "$LOG_DIR"

find_node() {
  if [[ -n "${CATASHIRO_NODE_BINARY:-}" && -x "$CATASHIRO_NODE_BINARY" ]]; then
    printf '%s\n' "$CATASHIRO_NODE_BINARY"
    return 0
  fi
  for candidate in \
    "$APP_ROOT/node/bin/node" \
    "/opt/homebrew/bin/node" \
    "/usr/local/bin/node" \
    "/usr/bin/node"; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

NODE_BINARY="$(find_node || true)"
if [[ -z "$NODE_BINARY" ]]; then
  /usr/bin/osascript -e 'display alert "Catashiro needs Node.js" message "Install Node.js 22 or newer, or set CATASHIRO_NODE_BINARY to a bundled Node executable, then open Catashiro again." as critical' >/dev/null 2>&1 || true
  exit 1
fi

export CATASHIRO_APP_BUNDLE=1
export CATASHIRO_OPEN_BROWSER="${CATASHIRO_OPEN_BROWSER:-1}"
export NODE_ENV=production
if [[ -d "$APP_ROOT/node_modules/playwright-core/.local-browsers" ]]; then
  export PLAYWRIGHT_BROWSERS_PATH="$APP_ROOT/node_modules/playwright-core/.local-browsers"
fi

cd "$APP_ROOT"
exec "$NODE_BINARY" "$APP_ROOT/dist/compiled/run/cli.js" ui deterministic 0 >> "$LOG_DIR/catashiro.log" 2>&1
LAUNCHER
chmod +x "$MACOS_DIR/$APP_NAME"

(
  cd "$RELEASE_DIR"
  /usr/bin/zip -qry "$(basename "$ZIP_PATH")" "$APP_NAME.app"
)

echo "created: $APP_DIR"
echo "created: $ZIP_PATH"
echo
echo "Beta packaging note: this artifact is unsigned/not notarized. See docs/development.md for distribution guidance."
