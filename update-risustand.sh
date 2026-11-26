#!/usr/bin/env sh
# RisuStand updater launcher (macOS / Linux). Stop the relay server before running.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js is not installed. Please install Node.js LTS from https://nodejs.org"
  exit 1
fi
echo "======================================================"
echo "  RisuStand Updater"
echo "  * Stop the relay server window first."
echo "======================================================"
node risustand-updater.cjs --apply "$@"
