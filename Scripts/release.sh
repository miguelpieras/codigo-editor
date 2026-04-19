#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$ROOT"
APP_NAME="Codigo Editor.app"
DIST_DIR="$ROOT/dist"
VERSION_FILE="$ROOT/VERSION"
BUILD_FILE="$ROOT/BUILD"
RUN_SCRIPT="$ROOT/run-app.sh"
ZIP_PREFIX="CodigoEditor"

CODESIGN_IDENTITY="${CODIGO_CODESIGN_IDENTITY:-}"
NOTARY_PROFILE="${CODIGO_NOTARY_PROFILE:-}"
NOTARY_APPLE_ID="${CODIGO_NOTARY_APPLE_ID:-}"
NOTARY_PASSWORD="${CODIGO_NOTARY_PASSWORD:-}"
NOTARY_TEAM_ID="${CODIGO_NOTARY_TEAM_ID:-}"
RAW_DMG_VOLUME_NAME="${CODIGO_RELEASE_DMG_VOLUME_NAME:-Codigo Editor}"
DMG_VOLUME_NAME="$(printf '%s' "$RAW_DMG_VOLUME_NAME" | tr -s '[:space:]' '-' | sed 's/^-*//; s/-*$//')"
if [ -z "$DMG_VOLUME_NAME" ]; then
  DMG_VOLUME_NAME="Codigo-Editor"
fi

if [ $# -lt 1 ] || [ $# -gt 2 ]; then
  echo "Usage: $0 <version> [build]" >&2
  exit 64
fi

VERSION="$1"
BUILD="${2:-}"
if [ -z "$BUILD" ]; then
  BUILD="$(date +%Y%m%d%H%M)"
fi

for tool in swift npm ditto hdiutil; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Required tool '$tool' not found in PATH" >&2
    exit 69
  fi
done

SIGN_APP=0
NOTARIZE_APP=0
if [ -n "$CODESIGN_IDENTITY" ]; then
  SIGN_APP=1
  for tool in codesign xcrun; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      echo "Required tool '$tool' not found in PATH" >&2
      exit 69
    fi
  done
fi

if [ -n "$NOTARY_PROFILE" ] || { [ -n "$NOTARY_APPLE_ID" ] && [ -n "$NOTARY_PASSWORD" ]; }; then
  if [ "$SIGN_APP" != "1" ]; then
    echo "Notarization requires CODIGO_CODESIGN_IDENTITY to be set." >&2
    exit 70
  fi
  if [ -z "$NOTARY_TEAM_ID" ]; then
    echo "Notarization team ID must not be empty." >&2
    exit 70
  fi
  if ! xcrun --find notarytool >/dev/null 2>&1; then
    echo "Required tool 'notarytool' not available via xcrun" >&2
    exit 69
  fi
  if ! xcrun --find stapler >/dev/null 2>&1; then
    echo "Required tool 'stapler' not available via xcrun" >&2
    exit 69
  fi
  NOTARIZE_APP=1
fi

pushd "$ROOT" >/dev/null
swift test --scratch-path .build
npm run lint
popd >/dev/null

echo "$VERSION" > "$VERSION_FILE"
echo "$BUILD" > "$BUILD_FILE"

RUN_APP_BUILD_CONFIGURATION=release RUN_APP_SKIP_OPEN=1 "$RUN_SCRIPT"

if [ ! -d "$APP_DIR/$APP_NAME" ]; then
  echo "Expected app bundle not found at '$APP_DIR/$APP_NAME'" >&2
  exit 70
fi

if [ "$SIGN_APP" = "1" ]; then
  echo "Signing $APP_NAME with identity '$CODESIGN_IDENTITY'"
  codesign --deep --force --options runtime --timestamp --sign "$CODESIGN_IDENTITY" "$APP_DIR/$APP_NAME"
  codesign --verify --deep --strict "$APP_DIR/$APP_NAME"
fi

mkdir -p "$DIST_DIR"

if [ "$NOTARIZE_APP" = "1" ]; then
  NOTARIZE_ZIP_NAME="${ZIP_PREFIX}-${VERSION}-notarize.zip"
  NOTARIZE_ZIP_PATH="$DIST_DIR/$NOTARIZE_ZIP_NAME"
  rm -f "$NOTARIZE_ZIP_PATH"
  echo "Creating notarization archive at $NOTARIZE_ZIP_PATH"
  ditto -c -k --keepParent "$APP_DIR/$APP_NAME" "$NOTARIZE_ZIP_PATH"

  NOTARY_SUBMIT_ARGS=(--wait)
  if [ -n "$NOTARY_PROFILE" ]; then
    NOTARY_SUBMIT_ARGS+=(--keychain-profile "$NOTARY_PROFILE" --team-id "$NOTARY_TEAM_ID")
  else
    NOTARY_SUBMIT_ARGS+=(--apple-id "$NOTARY_APPLE_ID" --team-id "$NOTARY_TEAM_ID" --password "$NOTARY_PASSWORD")
  fi

  echo "Submitting archive for notarization"
  xcrun notarytool submit "$NOTARIZE_ZIP_PATH" "${NOTARY_SUBMIT_ARGS[@]}"
  echo "Stapling notarization ticket to $APP_NAME"
  xcrun stapler staple "$APP_DIR/$APP_NAME"
  xcrun stapler validate "$APP_DIR/$APP_NAME" >/dev/null
  rm -f "$NOTARIZE_ZIP_PATH"
fi

ZIP_NAME="${ZIP_PREFIX}-${VERSION}.zip"
ZIP_PATH="$DIST_DIR/$ZIP_NAME"
DMG_NAME="${ZIP_PREFIX}-${VERSION}.dmg"
DMG_PATH="$DIST_DIR/$DMG_NAME"
rm -f "$ZIP_PATH" "$DMG_PATH"

echo "Packaging app bundle to $ZIP_PATH"
ditto -c -k --keepParent "$APP_DIR/$APP_NAME" "$ZIP_PATH"

echo "Creating disk image at $DMG_PATH"
TMP_ROOT="${TMPDIR:-/tmp}"
DMG_STAGE_DIR="$(mktemp -d "$TMP_ROOT/codigo-editor-dmg-stage.XXXXXX")"
trap 'rm -rf "$DMG_STAGE_DIR"' EXIT
ditto "$APP_DIR/$APP_NAME" "$DMG_STAGE_DIR/$APP_NAME"
hdiutil create -volname "$DMG_VOLUME_NAME" -srcfolder "$DMG_STAGE_DIR" -ov -format UDZO "$DMG_PATH" >/dev/null
rm -rf "$DMG_STAGE_DIR"
trap - EXIT

ZIP_SHA256="$(shasum -a 256 "$ZIP_PATH" | awk '{print $1}')"
DMG_SHA256="$(shasum -a 256 "$DMG_PATH" | awk '{print $1}')"

cat <<SUMMARY
Release complete.
  Version:        $VERSION
  Build:          $BUILD
  Signed:         $( [ "$SIGN_APP" = "1" ] && printf 'yes' || printf 'no' )
  Notarized:      $( [ "$NOTARIZE_APP" = "1" ] && printf 'yes' || printf 'no' )
  Zip:            $ZIP_PATH
  Zip SHA256:     $ZIP_SHA256
  DMG:            $DMG_PATH
  DMG SHA256:     $DMG_SHA256
SUMMARY
