# Mesa execution service

This loopback-only FastAPI service contains the reviewed Gate 1
`wind-turbine-maintenance` model and its artifact-producing worker. A3-3 now
pins the reviewed mechanism and assets into a versioned backend manifest and
installs them as an ordinary Model, fixed-copy Project, and Experiment. The
historical `/v1` flow below remains direct Mesa-service evidence; it is not the
current Product API. No wind-specific backend/browser route was added. Nothing
here is a staffing recommendation or a calibrated real-wind-farm result.

See [`../docs/mesa-service.md`](../docs/mesa-service.md),
[`../docs/gate-1-wind-turbine-model-design.md`](../docs/gate-1-wind-turbine-model-design.md),
and the original
[`../docs/wind-turbine-maintenance-gate-0.md`](../docs/wind-turbine-maintenance-gate-0.md).

From this directory:

```sh
uv sync --extra test --frozen
uv run pytest -q
uv run uvicorn mesa_service.app:app --host 127.0.0.1 --port 8091
```

`WORKSPACE_ROOT` selects the workspace root (default: `./.riff-workspace`).
Bind the service to loopback; it is not a browser-facing API.

## Reviewed wind path

Load the one executable preset:

```sh
curl -X PUT http://127.0.0.1:8091/v1/projects/wind-demo/models/wind-turbine-maintenance \
  -H 'content-type: application/json' \
  -d '{"preset_id":"wind-turbine-maintenance-demo-v1"}'
```

The response contains content-addressed `model_revision_id` and
`experiment_revision_id`. Start a run using only the returned experiment ID:

```sh
curl -X POST http://127.0.0.1:8091/v1/projects/wind-demo/runs \
  -H 'content-type: application/json' \
  -d '{"experiment_revision_id":"er_<full-sha256>"}'
```

Wind runs produce `daily-kpis.csv`, the complete `domain-events.jsonl`, summary,
replay and derived-view manifests, metadata, request, and a bounded log. Events
are paged with `after` as an exclusive sequence cursor and `limit` from 1 to
1000. Artifact names are allowlisted. Run admission re-verifies the full model
bundle and recomputes the experiment content ID. A child `*.tmp` run is never
public; the parent exposes it only after process exit, strict verification, and
atomic promotion. Successful evidence contains exactly the declared files, and
all nested symlink paths fail closed.

The worker independently repeats bundle verification at startup. Parent-admitted
model/experiment IDs and the exact request SHA-256 are passed outside the
request document; execution uses an in-memory capture of the verified model
bytes. Drift between admission and process start fails with only bounded
request, metadata, and log diagnostics.

`summary.json` retains the single-seed non-claim boundary and reports
annualized operating revenue, maintenance expense, and their difference as a
source-traceability profit diagnostic, not as an optimization claim.

The A3-3 generic `riff-batch-v1` adapter publishes `summary.json`,
`daily-kpis.csv`, and `domain-events.ndjson`. With the exact baseline below it
produces 1,096 daily rows and 38,730 events within the server-owned 50,000-event
/ 64 MB generic limit; ordinary Project-run and restart tests verify the
indexed outputs and paged events.

Run and independently verify the exact 100-turbine, 3-crew, 1095-day,
365-day-warm-up, seed-2 baseline:

```sh
uv run python -m mesa_service.run_baseline \
  --preset wind-turbine-maintenance-demo-v1 \
  --output-dir ../outputs/gate1-wind-baseline
uv run python -m mesa_service.verify_run ../outputs/gate1-wind-baseline
```

## Legacy coexistence

The singular route still loads `queue-network-v1` for the current backend/web
path:

```sh
curl -X PUT http://127.0.0.1:8091/v1/projects/legacy-demo/model \
  -H 'content-type: application/json' \
  -d '{"model_id":"queue-network-v1"}'
```

Wind and queue run bodies are selected strictly from the project's active
model; an invalid wind request never falls back to queue execution. Gate 4
removes the compatibility endpoints, source, tests, and identified local queue
artifacts after the integrated browser cutover.
