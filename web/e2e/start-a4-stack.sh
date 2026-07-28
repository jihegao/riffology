#!/usr/bin/env bash
set -euo pipefail

A4_E2E_ROOT="$(mktemp -d -t riff-a4-e2e-XXXXXX)"
A4_E2E_ROOT="$(cd "$A4_E2E_ROOT" && pwd -P)"
A4_PLATFORM_PORT="${A4_PLATFORM_PORT:-8787}"
A4_WEB_PORT="${A4_WEB_PORT:-5173}"
PIDS=()

cleanup() {
  for child_pid in "${PIDS[@]:-}"; do
    kill "$child_pid" 2>/dev/null || true
  done
  wait "${PIDS[@]:-}" 2>/dev/null || true
  if [[ "${KEEP_A4_E2E:-0}" == "1" ]]; then
    echo "KEEP_A4_E2E_ROOT=$A4_E2E_ROOT" >&2
  else
    rm -rf "$A4_E2E_ROOT"
  fi
}
trap cleanup EXIT INT TERM

WORKSPACE_ROOT="$A4_E2E_ROOT" RIFF_SKIP_OPENCODE=true PORT="$A4_PLATFORM_PORT" \
  node --experimental-strip-types e2e/a4-backend.ts &
PIDS+=("$!")
for _ in $(seq 1 160); do
  curl --noproxy '*' -fsS "http://[::1]:${A4_PLATFORM_PORT}/health" \
    -H "Host: localhost:${A4_PLATFORM_PORT}" >/dev/null 2>&1 && break
  sleep 0.25
done

RIFF_PLATFORM_APP_PORT="$A4_PLATFORM_PORT" \
  npm run dev -- --host 127.0.0.1 --port "$A4_WEB_PORT" --strictPort &
WEB_PID="$!"
PIDS+=("$WEB_PID")
wait "$WEB_PID"
