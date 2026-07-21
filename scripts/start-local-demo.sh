#!/usr/bin/env bash
# Starts the local Mesa service, wind Evidence Studio backend, and Vite UI.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"

WORKSPACE_ROOT_VALUE="${WORKSPACE_ROOT:-.riff-workspaces}"
if [[ "$WORKSPACE_ROOT_VALUE" != /* ]]; then
  WORKSPACE_ROOT_VALUE="$ROOT_DIR/$WORKSPACE_ROOT_VALUE"
fi
mkdir -p "$WORKSPACE_ROOT_VALUE"
export WORKSPACE_ROOT="$(cd "$WORKSPACE_ROOT_VALUE" && pwd -P)"
export MESA_PORT="${MESA_PORT:-8091}"
export MESA_SERVICE_URL="${MESA_SERVICE_URL:-http://127.0.0.1:$MESA_PORT}"
export PORT="${PORT:-8787}"
export VITE_API_BASE_URL="${VITE_API_BASE_URL:-http://127.0.0.1:$PORT}"
export WEB_PORT="${WEB_PORT:-5173}"

cleanup() {
  if [[ "$CLEANED_UP" == "1" ]]; then return; fi
  CLEANED_UP=1
  for child_pid in "${PIDS[@]:-}"; do
    kill "$child_pid" 2>/dev/null || true
  done
  for child_pid in "${PIDS[@]:-}"; do
    wait "$child_pid" 2>/dev/null || true
  done
}
PIDS=()
CLEANED_UP=0
trap cleanup EXIT
trap 'exit 0' INT TERM

(
  cd "$ROOT_DIR/mesa_service"
  exec uv run uvicorn mesa_service.app:app --host 127.0.0.1 --port "$MESA_PORT"
) &
PIDS+=("$!")

(
  cd "$ROOT_DIR/backend"
  exec npm start
) &
PIDS+=("$!")

(
  cd "$ROOT_DIR/web"
  exec npm run dev -- --host 127.0.0.1 --port "$WEB_PORT"
) &
PIDS+=("$!")

echo "Wind Evidence Studio: http://127.0.0.1:$WEB_PORT"

wait
