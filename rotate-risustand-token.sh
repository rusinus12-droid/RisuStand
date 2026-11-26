#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js is not installed. Install Node.js 18+ from https://nodejs.org"
  exit 1
fi

node risustand-admin.cjs token "$@"
