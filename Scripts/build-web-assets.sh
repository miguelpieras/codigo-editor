#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTPUT_DIR="${1:-}"

if ! command -v npm >/dev/null 2>&1; then
  echo "warning: npm not found; skipping web asset build" >&2
  exit 0
fi

if [ ! -d "$ROOT/node_modules" ]; then
  (cd "$ROOT" && npm install)
fi

(cd "$ROOT" && npm run build)
(cd "$ROOT" && npm run sync-assets)

if [ -n "$OUTPUT_DIR" ]; then
  mkdir -p "$OUTPUT_DIR"
  date > "$OUTPUT_DIR/last-build.txt"
fi
