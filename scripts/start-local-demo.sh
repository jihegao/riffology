#!/usr/bin/env bash
# Starts the local Mesa service, wind Evidence Studio backend, and Vite UI.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

export WORKSPACE_ROOT="${WORKSPACE_ROOT:-$ROOT_DIR/.riff-workspaces}"
MESA_PORT="${MESA_PORT:-8091}"
export MESA_SERVICE_URL="${MESA_SERVICE_URL:-http://127.0.0.1:$MESA_PORT}"
export PORT="${PORT:-8787}"
WEB_PORT="${WEB_PORT:-5173}"

cleanup() {
  for child_pid in "${PIDS[@]:-}"; do
    kill "$child_pid" 2>/dev/null || true
  done
}
PIDS=()
trap cleanup EXIT INT TERM

(
  cd "$ROOT_DIR/mesa_service"
  WORKSPACE_ROOT="$WORKSPACE_ROOT" uv run uvicorn mesa_service.app:app --host 127.0.0.1 --port "$MESA_PORT"
) &
PIDS+=("$!")

(
  cd "$ROOT_DIR/backend"
  MESA_SERVICE_URL="$MESA_SERVICE_URL" WORKSPACE_ROOT="$WORKSPACE_ROOT" PORT="$PORT" npm start
) &
PIDS+=("$!")

(
  cd "$ROOT_DIR/web"
  npm run dev -- --host 127.0.0.1 --port "$WEB_PORT"
) &
PIDS+=("$!")

echo "Wind Evidence Studio: http://127.0.0.1:$WEB_PORT"

wait
