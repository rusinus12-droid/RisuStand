#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

if [ -z "$PORT" ] && [ -f ".risustand-port" ]; then
  PORT="$(tr -d '\r\n' < .risustand-port)"
fi
PORT="${PORT:-8787}"

echo "======================================================"
echo "  RisuStand Remote Relay Stop (macOS / Linux)"
echo "======================================================"

PIDS="$(pgrep -f 'risustand-relay-server\.js' || true)"
if [ -n "$PIDS" ]; then
  echo "[INFO] Stopping RisuStand relay server (PID: $PIDS)..."
  kill $PIDS 2>/dev/null || true
  sleep 1
  REMAINING="$(pgrep -f 'risustand-relay-server\.js' || true)"
  if [ -n "$REMAINING" ]; then
    kill -9 $REMAINING 2>/dev/null || true
    sleep 1
  fi
  echo "[OK] RisuStand 중계 서버 종료 완료 (port ${PORT})"
else
  echo "[INFO] 실행 중인 RisuStand 중계 서버가 없습니다."
fi
