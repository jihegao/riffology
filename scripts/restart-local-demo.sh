#!/usr/bin/env bash
# Restart the local Product app and, in live mode, its loopback OpenCode service.
# This script never deletes Product data, run artifacts, or local configuration.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ "${1:-}" == "--help" ]]; then
  cat <<'EOF'
Usage: bash scripts/restart-local-demo.sh

Stops only verified local Riff/OpenCode listeners, starts the configured
services in the background, and checks their loopback health endpoints.
Logs: /tmp/riff-demo-opencode.log and /tmp/riff-demo-backend.log
EOF
  exit 0
fi

if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  source "$ROOT_DIR/.env"
  set +a
fi

export RIFF_SKIP_OPENCODE="${RIFF_SKIP_OPENCODE:-true}"
export PORT="${PORT:-8787}"
export RIFF_VISUAL_BROKER_PORT="${RIFF_VISUAL_BROKER_PORT:-8788}"
OPENCODE_URL="${OPENCODE_URL:-http://127.0.0.1:4096}"
OPENCODE_LOG="${RIFF_LOG_DIR:-/tmp}/riff-demo-opencode.log"
BACKEND_LOG="${RIFF_LOG_DIR:-/tmp}/riff-demo-backend.log"

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Required command is unavailable: $1" >&2
    exit 1
  }
}

require_command curl
require_command lsof
require_command ps

if [[ "$RIFF_SKIP_OPENCODE" != "true" && "$RIFF_SKIP_OPENCODE" != "false" ]]; then
  echo "RIFF_SKIP_OPENCODE must be true or false." >&2
  exit 1
fi

OPENCODE_PORT=""
if [[ "$RIFF_SKIP_OPENCODE" == "false" ]]; then
  if [[ ! "$OPENCODE_URL" =~ ^http://127\.0\.0\.1:([0-9]{1,5})$ ]]; then
    echo "This restart script supports only an exact loopback OPENCODE_URL (http://127.0.0.1:<port>)." >&2
    exit 1
  fi
  OPENCODE_PORT="${BASH_REMATCH[1]}"
  (( OPENCODE_PORT >= 1 && OPENCODE_PORT <= 65535 )) || {
    echo "OPENCODE_URL has an invalid port." >&2
    exit 1
  }
  require_command opencode
fi

listener_pids() {
  lsof -nP -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null || true
}

assert_expected_listener() {
  local pid="$1"
  local kind="$2"
  local command
  command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  if [[ "$kind" == "riff" && "$command" == *"src/index.ts"* ]]; then
    return
  fi
  if [[ "$kind" == "opencode" && "$command" == *"opencode"*"serve"*"--port"*"$OPENCODE_PORT"* ]]; then
    return
  fi
  echo "Refusing to stop PID $pid: it is not the expected $kind listener." >&2
  exit 1
}

append_unique_pid() {
  local pid="$1"
  case " $TARGET_PIDS " in
    *" $pid "*) ;;
    *) TARGET_PIDS+=" $pid" ;;
  esac
}

collect_verified_listeners() {
  local port="$1"
  local kind="$2"
  local pid
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    assert_expected_listener "$pid" "$kind"
    append_unique_pid "$pid"
  done < <(listener_pids "$port")
}

wait_for_port_release() {
  local port="$1"
  local attempt
  for attempt in {1..50}; do
    [[ -z "$(listener_pids "$port")" ]] && return
    sleep 0.1
  done
  echo "Port $port did not stop within five seconds." >&2
  exit 1
}

wait_for_http() {
  local url="$1"
  local attempt
  for attempt in {1..100}; do
    if curl --noproxy '*' --fail --silent --max-time 1 "$url" >/dev/null 2>&1; then
      return
    fi
    sleep 0.1
  done
  echo "Service did not become healthy: $url" >&2
  exit 1
}

TARGET_PIDS=""
collect_verified_listeners "$PORT" riff
collect_verified_listeners "$RIFF_VISUAL_BROKER_PORT" riff
if [[ "$RIFF_SKIP_OPENCODE" == "false" ]]; then
  collect_verified_listeners "$OPENCODE_PORT" opencode
fi

for pid in $TARGET_PIDS; do
  kill "$pid"
done

wait_for_port_release "$PORT"
wait_for_port_release "$RIFF_VISUAL_BROKER_PORT"
if [[ "$RIFF_SKIP_OPENCODE" == "false" ]]; then
  wait_for_port_release "$OPENCODE_PORT"
  nohup opencode serve --hostname 127.0.0.1 --port "$OPENCODE_PORT" >>"$OPENCODE_LOG" 2>&1 &
  wait_for_http "$OPENCODE_URL/global/health"
fi

nohup bash "$ROOT_DIR/scripts/start-local-demo.sh" >>"$BACKEND_LOG" 2>&1 &
wait_for_http "http://localhost:$PORT/api/health"

echo "Riff demo is ready at http://localhost:$PORT"
if [[ "$RIFF_SKIP_OPENCODE" == "false" ]]; then
  echo "OpenCode is ready at $OPENCODE_URL"
  echo "Logs: $BACKEND_LOG and $OPENCODE_LOG"
else
  echo "Logs: $BACKEND_LOG"
fi
