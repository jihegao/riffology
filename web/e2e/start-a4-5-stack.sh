#!/usr/bin/env bash
set -euo pipefail

A4_5_E2E_ROOT="$(mktemp -d -t riff-a4-5-e2e-XXXXXX)"
A4_5_E2E_ROOT="$(cd "$A4_5_E2E_ROOT" && pwd -P)"
PIDS=()

cleanup() {
  for child_pid in "${PIDS[@]:-}"; do
    kill "$child_pid" 2>/dev/null || true
  done
  wait "${PIDS[@]:-}" 2>/dev/null || true
  if [[ "${KEEP_A4_5_E2E:-0}" == "1" ]]; then
    echo "KEEP_A4_5_E2E_ROOT=$A4_5_E2E_ROOT" >&2
  else
    rm -rf "$A4_5_E2E_ROOT"
  fi
}
trap cleanup EXIT INT TERM

npm run build

RIFF_PRODUCT_ROOT="$A4_5_E2E_ROOT/product" RIFF_SKIP_OPENCODE=true \
  PORT=8792 RIFF_VISUAL_BROKER_PORT=8793 \
  node --experimental-strip-types e2e/a4-5-backend.ts &
PIDS+=("$!")

RIFF_A4_5_RECOVERY_ONLY=true PORT=8794 RIFF_VISUAL_BROKER_PORT=8795 \
  node --experimental-strip-types e2e/a4-5-backend.ts &
PIDS+=("$!")

for fixture_port in 8792 8794; do
  for _ in $(seq 1 240); do
    curl --noproxy '*' -fsS "http://[::1]:$fixture_port/health" \
      -H "Host: localhost:$fixture_port" >/dev/null 2>&1 && break
    sleep 0.25
  done
done

wait "${PIDS[0]}"
