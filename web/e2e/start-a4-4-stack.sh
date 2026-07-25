#!/usr/bin/env bash
set -euo pipefail

A4_4_E2E_ROOT="$(mktemp -d -t riff-a4-4-e2e-XXXXXX)"
A4_4_E2E_ROOT="$(cd "$A4_4_E2E_ROOT" && pwd -P)"
PIDS=()

cleanup() {
  for child_pid in "${PIDS[@]:-}"; do
    kill "$child_pid" 2>/dev/null || true
  done
  wait "${PIDS[@]:-}" 2>/dev/null || true
  if [[ "${KEEP_A4_4_E2E:-0}" == "1" ]]; then
    echo "KEEP_A4_4_E2E_ROOT=$A4_4_E2E_ROOT" >&2
  else
    rm -rf "$A4_4_E2E_ROOT"
  fi
}
trap cleanup EXIT INT TERM

WORKSPACE_ROOT="$A4_4_E2E_ROOT" PORT=8787 \
  node --experimental-strip-types e2e/a4-4-backend.ts &
PIDS+=("$!")
for _ in $(seq 1 240); do
  curl --noproxy '*' -fsS 'http://[::1]:8787/health' -H 'Host: localhost:8787' >/dev/null 2>&1 && break
  sleep 0.25
done

RIFF_PLATFORM_APP_PORT=8787 RIFF_VISUAL_BROKER_PORT=8788 \
  npm run dev -- --host 127.0.0.1 --port 5173 &
WEB_PID="$!"
PIDS+=("$WEB_PID")
wait "$WEB_PID"
