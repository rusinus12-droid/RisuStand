#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

echo "======================================================"
echo "  RisuStand Remote Relay Launcher (macOS / Linux)"
echo "======================================================"

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js is not installed. Install Node.js 18+ from https://nodejs.org"
  exit 1
fi

if [ ! -f ".risustand-token" ]; then
  node -e "console.log(require('crypto').randomBytes(12).toString('hex'))" > .risustand-token
fi

export RISU_REMOTE_TOKEN="$(cat .risustand-token | tr -d '\r\n')"
export PORT="${PORT:-8787}"

TS_IP=""
if command -v tailscale >/dev/null 2>&1; then
  TS_IP="$(tailscale ip -4 2>/dev/null | head -n 1 || true)"
fi

echo "  PC Bridge URL  : http://127.0.0.1:${PORT}"
echo "  Proxy Router   : http://127.0.0.1:${PORT}/v1/chat/completions"
if [ -n "$TS_IP" ]; then
  echo "  Mobile / iPad  : http://${TS_IP}:${PORT}"
fi
echo "  Security Token : ${RISU_REMOTE_TOKEN}"
echo "======================================================"
echo ""

node risustand-relay-server.js
