#!/usr/bin/env bash
# Builds the Product shell and starts the Product-first local platform.
# Default mode is deterministic development mode; it is not live OpenCode proof.
# This script never deletes or migrates legacy workspaces, outputs, or local files.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # Local developer configuration only; never commit .env.
  source "$ROOT_DIR/.env"
  set +a
fi

export RIFF_PRODUCT_ROOT="${RIFF_PRODUCT_ROOT:-$ROOT_DIR/.riff-product}"
export RIFF_SKIP_OPENCODE="${RIFF_SKIP_OPENCODE:-true}"
export PORT="${PORT:-8787}"
export RIFF_VISUAL_BROKER_PORT="${RIFF_VISUAL_BROKER_PORT:-8788}"
export RIFF_MODEL_PYTHON="${RIFF_MODEL_PYTHON:-$ROOT_DIR/mesa_service/.venv/bin/python}"
export OPENCODE_EXPECTED_VERSION="${OPENCODE_EXPECTED_VERSION:-1.18.4}"

# OpenCode is a separately managed loopback service, so its process directory
# cannot be inferred from this script's caller. Resolve it once, after .env is
# loaded, and pass the canonical directory to the backend for /path readiness.
# Only an omitted value receives the developer repo-root default; a configured
# value must already be absolute so it cannot inherit the caller's $PWD.
OPENCODE_WORKDIR="${OPENCODE_WORKDIR:-$ROOT_DIR}"
if [[ "$OPENCODE_WORKDIR" != /* ]]; then
  echo "OPENCODE_WORKDIR must be an absolute directory: $OPENCODE_WORKDIR" >&2
  exit 1
fi
if [[ ! -d "$OPENCODE_WORKDIR" ]]; then
  echo "OPENCODE_WORKDIR must name an existing directory: $OPENCODE_WORKDIR" >&2
  exit 1
fi
export OPENCODE_WORKDIR="$(cd "$OPENCODE_WORKDIR" && pwd -P)"

if [[ ! -x "$RIFF_MODEL_PYTHON" ]]; then
  echo "Riff Demo requires an executable approved Model runtime at $RIFF_MODEL_PYTHON" >&2
  echo "Create mesa_service/.venv or set RIFF_MODEL_PYTHON explicitly." >&2
  exit 1
fi

(
  cd "$ROOT_DIR/web"
  npm run build
)

if [[ "$RIFF_SKIP_OPENCODE" == "true" ]]; then
  echo "Riffology: http://localhost:$PORT (deterministic development agent; not live OpenCode verification)"
else
  echo "Riffology: http://localhost:$PORT (requires a configured local OpenCode server)"
fi

cd "$ROOT_DIR/backend"
exec npm start
