#!/usr/bin/env bash
# Starts the local Mesa service, demo backend, and Vite workbench together.
# Default mode is deterministic development mode; it is not live OpenCode proof.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # Local developer configuration only; never commit .env.
  source "$ROOT_DIR/.env"
  set +a
fi

export WORKSPACE_ROOT="${WORKSPACE_ROOT:-$ROOT_DIR/.riff-workspaces}"
export MESA_SERVICE_URL="${MESA_SERVICE_URL:-http://127.0.0.1:8091}"
export RIFF_SKIP_OPENCODE="${RIFF_SKIP_OPENCODE:-true}"
export PORT="${PORT:-8787}"
export RIFF_MODEL_PYTHON="${RIFF_MODEL_PYTHON:-$ROOT_DIR/mesa_service/.venv/bin/python}"
WEB_PORT="${WEB_PORT:-5173}"

if [[ ! -x "$RIFF_MODEL_PYTHON" ]]; then
  echo "Riff Demo requires an executable approved Model runtime at $RIFF_MODEL_PYTHON" >&2
  echo "Create mesa_service/.venv or set RIFF_MODEL_PYTHON explicitly." >&2
  exit 1
fi

cleanup() {
  for child_pid in "${PIDS[@]:-}"; do
    kill "$child_pid" 2>/dev/null || true
  done
}
PIDS=()
trap cleanup EXIT INT TERM

(
  cd "$ROOT_DIR/mesa_service"
  WORKSPACE_ROOT="$WORKSPACE_ROOT" uv run uvicorn mesa_service.app:app --host 127.0.0.1 --port 8091
) &
PIDS+=("$!")

(
  cd "$ROOT_DIR/backend"
  MESA_SERVICE_URL="$MESA_SERVICE_URL" WORKSPACE_ROOT="$WORKSPACE_ROOT" RIFF_SKIP_OPENCODE="$RIFF_SKIP_OPENCODE" RIFF_MODEL_PYTHON="$RIFF_MODEL_PYTHON" PORT="$PORT" npm start
) &
PIDS+=("$!")

(
  cd "$ROOT_DIR/web"
  npm run dev -- --host 127.0.0.1 --port "$WEB_PORT"
) &
PIDS+=("$!")

if [[ "$RIFF_SKIP_OPENCODE" == "true" ]]; then
  echo "Riff Demo: http://127.0.0.1:$WEB_PORT (deterministic development agent; not live OpenCode verification)"
else
  echo "Riff Demo: http://127.0.0.1:$WEB_PORT (requires a configured local OpenCode server)"
fi

wait
