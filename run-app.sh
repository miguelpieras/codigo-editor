#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
SCRIPTS_DIR="$ROOT/Scripts"
WEB_ASSETS_SCRIPT="$SCRIPTS_DIR/build-web-assets.sh"
BUILD_CONFIGURATION="${RUN_APP_BUILD_CONFIGURATION:-debug}"
case "$BUILD_CONFIGURATION" in
  debug|release) ;;
  *)
    echo "Unsupported build configuration: $BUILD_CONFIGURATION (expected 'debug' or 'release')" >&2
    exit 65
    ;;
esac

APP_NAME="Codigo Editor.app"
APP="$ROOT/$APP_NAME"
RESOURCES="$APP/Contents/Resources"
ICON_SOURCE="$ROOT/Sources/codigo-editor/Resources/AppIcon.icns"
VERSION_FILE="$ROOT/VERSION"
BUILD_FILE="$ROOT/BUILD"
BUNDLE_IDENTIFIER="${CODIGO_BUNDLE_IDENTIFIER:-dev.codigoeditor.app}"

if [ ! -f "$VERSION_FILE" ]; then
  echo "Missing VERSION file at $VERSION_FILE" >&2
  exit 1
fi

APP_VERSION="$(tr -d '\r\n' < "$VERSION_FILE")"
if [ -z "$APP_VERSION" ]; then
  echo "VERSION file at $VERSION_FILE is empty" >&2
  exit 1
fi

if [ -f "$BUILD_FILE" ]; then
  APP_BUILD="$(tr -d '\r\n' < "$BUILD_FILE")"
fi

if [ -z "${APP_BUILD:-}" ]; then
  APP_BUILD="1"
fi

if [ -x "$WEB_ASSETS_SCRIPT" ]; then
  "$WEB_ASSETS_SCRIPT"
else
  echo "warning: web asset build script not found at $WEB_ASSETS_SCRIPT; skipping web build" >&2
fi

export CLANG_MODULE_CACHE_PATH="$ROOT/.build/ModuleCache"
mkdir -p "$CLANG_MODULE_CACHE_PATH"
swift build --configuration "$BUILD_CONFIGURATION" --scratch-path "$ROOT/.build"
BIN_DIR="$(swift build --configuration "$BUILD_CONFIGURATION" --scratch-path "$ROOT/.build" --show-bin-path)"
BIN="$BIN_DIR/codigo-editor"

if [ ! -f "$BIN" ]; then
  echo "Build produced no binary at $BIN" >&2
  exit 1
fi

if [ ! -f "$ICON_SOURCE" ]; then
  echo "Missing app icon at $ICON_SOURCE" >&2
  exit 1
fi

mkdir -p "$APP/Contents/MacOS" "$RESOURCES"
cp "$BIN" "$APP/Contents/MacOS/codigo-editor"
chmod +x "$APP/Contents/MacOS/codigo-editor"

cp "$ICON_SOURCE" "$RESOURCES/AppIcon.icns"

cat <<PLIST > "$APP/Contents/Info.plist"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDisplayName</key><string>Codigo Editor</string>
    <key>CFBundleExecutable</key><string>codigo-editor</string>
    <key>CFBundleIdentifier</key><string>$BUNDLE_IDENTIFIER</string>
    <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
    <key>CFBundleName</key><string>Codigo Editor</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleVersion</key><string>$APP_BUILD</string>
    <key>CFBundleShortVersionString</key><string>$APP_VERSION</string>
    <key>CFBundleIconFile</key><string>AppIcon.icns</string>
    <key>CFBundleIconName</key><string>AppIcon</string>
    <key>CFBundleIcons</key>
    <dict>
        <key>CFBundlePrimaryIcon</key>
        <dict>
            <key>CFBundleIconFiles</key>
            <array>
                <string>AppIcon</string>
            </array>
            <key>CFBundleIconName</key><string>AppIcon</string>
        </dict>
    </dict>
    <key>LSMinimumSystemVersion</key><string>13.0</string>
    <key>NSPrincipalClass</key><string>NSApplication</string>
    <key>NSAppTransportSecurity</key>
    <dict>
        <key>NSAllowsLocalNetworking</key><true/>
    </dict>
</dict>
</plist>
PLIST

if [ "${RUN_APP_SKIP_OPEN:-0}" = "1" ]; then
  exit 0
fi

open "$APP"
