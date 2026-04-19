#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
VERSION_FILE="$ROOT/VERSION"
RELEASE_SCRIPT="$ROOT/Scripts/release.sh"
DEFAULT_BUMP="minor"

usage() {
  cat <<USAGE >&2
Usage: $0 [major|minor|patch|<version>] [build]

Without arguments the script bumps the '$DEFAULT_BUMP' version from the VERSION file.
Pass an explicit semantic version (e.g. 1.2.3) to override, or supply a build number as the second argument.
USAGE
}

require_semver() {
  local value="$1"
  if [[ ! $value =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "Invalid semantic version: $value" >&2
    exit 66
  fi
}

if [ ! -x "$RELEASE_SCRIPT" ]; then
  echo "Release script not found or not executable at $RELEASE_SCRIPT" >&2
  exit 64
fi

if [ ! -f "$VERSION_FILE" ]; then
  echo "Missing VERSION file at $VERSION_FILE" >&2
  exit 65
fi

CURRENT_VERSION="$(tr -d '\r\n' < "$VERSION_FILE")"
if [ -z "$CURRENT_VERSION" ]; then
  echo "VERSION file is empty" >&2
  exit 66
fi

require_semver "$CURRENT_VERSION"

NEW_VERSION=""
BUMP_TYPE="$DEFAULT_BUMP"
BUILD_NUMBER=""

if [ $# -gt 0 ]; then
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    major|minor|patch)
      BUMP_TYPE="$1"
      shift
      ;;
    *)
      if [[ $1 =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        NEW_VERSION="$1"
        shift
      elif [[ $1 =~ ^[0-9]+$ ]]; then
        BUILD_NUMBER="$1"
        shift
      else
        echo "Unknown argument: $1" >&2
        usage
        exit 64
      fi
      ;;
  esac
fi

if [ $# -gt 0 ]; then
  if [ -n "$BUILD_NUMBER" ]; then
    echo "Unexpected extra argument: $1" >&2
    usage
    exit 64
  fi
  BUILD_NUMBER="$1"
  shift
fi

if [ $# -gt 0 ]; then
  echo "Too many arguments" >&2
  usage
  exit 64
fi

if [ -z "$NEW_VERSION" ]; then
  IFS='.' read -r MAJOR MINOR PATCH <<<"$CURRENT_VERSION"
  case "$BUMP_TYPE" in
    major)
      ((MAJOR+=1))
      MINOR=0
      PATCH=0
      ;;
    minor)
      ((MINOR+=1))
      PATCH=0
      ;;
    patch)
      ((PATCH+=1))
      ;;
    *)
      echo "Unknown bump type: $BUMP_TYPE" >&2
      exit 66
      ;;
  esac
  NEW_VERSION="$MAJOR.$MINOR.$PATCH"
fi

require_semver "$NEW_VERSION"

echo "Current version: $CURRENT_VERSION"
if [ "$NEW_VERSION" != "$CURRENT_VERSION" ]; then
  echo "Next version:    $NEW_VERSION"
else
  echo "Next version:    $NEW_VERSION (unchanged)"
fi

if [ -n "$BUILD_NUMBER" ]; then
  echo "Build number:    $BUILD_NUMBER"
  "$RELEASE_SCRIPT" "$NEW_VERSION" "$BUILD_NUMBER"
else
  "$RELEASE_SCRIPT" "$NEW_VERSION"
fi
