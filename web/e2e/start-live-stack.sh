#!/usr/bin/env bash
set -euo pipefail
WEB_E2E_ROOT="$(mktemp -d -t riff-web-e2e-XXXXXX)"
WEB_E2E_ROOT="$(cd "$WEB_E2E_ROOT" && pwd -P)"
PIDS=()
cleanup() {
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  wait "${PIDS[@]:-}" 2>/dev/null || true
  if [[ "${KEEP_WEB_E2E:-0}" == "1" ]]; then echo "KEEP_WEB_E2E_ROOT=$WEB_E2E_ROOT" >&2; else rm -rf "$WEB_E2E_ROOT"; fi
}
trap cleanup EXIT INT TERM
(
  cd ../mesa_service
  WORKSPACE_ROOT="$WEB_E2E_ROOT" uv run uvicorn mesa_service.app:app --host 127.0.0.1 --port 8091
) & PIDS+=("$!")
for _ in $(seq 1 120); do curl --noproxy '*' -fsS http://127.0.0.1:8091/openapi.json >/dev/null 2>&1 && break; sleep 0.25; done
(
  cd ../backend
  WORKSPACE_ROOT="$WEB_E2E_ROOT" MESA_SERVICE_URL=http://127.0.0.1:8091 RIFF_SKIP_OPENCODE=true PORT=8787 npm start
) & PIDS+=("$!")
for _ in $(seq 1 120); do curl --noproxy '*' -fsS http://127.0.0.1:8787/health >/dev/null 2>&1 && break; sleep 0.25; done
curl --noproxy '*' -fsS -X POST http://127.0.0.1:8787/api/projects -H 'content-type: application/json' --data '{"command_id":"11111111-1111-4111-8111-111111111111","display_name":"Playwright Wind Evidence","initial_actor":{"actor_type":"human","display_name":"E2E Owner","declared_role":"project_owner"}}' >/dev/null
node e2e/bootstrap-live.mjs
npm run dev -- --host 127.0.0.1 --port 5173 & WEB_PID="$!"; PIDS+=("$WEB_PID")
wait "$WEB_PID"
