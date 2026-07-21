# Wind-turbine Mesa execution service

This loopback-only FastAPI service executes the reviewed
`wind-turbine-maintenance` model and publishes immutable run evidence for the
Evidence Studio. It is not a browser-facing API, a staffing recommendation, or
a calibrated real-wind-farm result.

From this directory:

```sh
uv sync --extra test --frozen
PYTHONDONTWRITEBYTECODE=1 uv run pytest -q
uv run uvicorn mesa_service.app:app --host 127.0.0.1 --port 8091
```

`WORKSPACE_ROOT` selects the workspace root (default: `./.riff-workspace`). The
service acquires the shared workspace lifecycle and mutation locks before any
workspace access and reports the canonical root in `/health`.

## Runtime contract

The backend owns project creation, actor authority, immutable experiment
revisions, run admission, cancellation tombstones, and receipt identity. Mesa
accepts only the corresponding wind contracts:

- `PUT /v2/projects/{project_id}/models/wind-turbine-maintenance` materializes
  the reviewed preset for a committed indexed project;
- `POST /v2/projects/{project_id}/runs` dispatches an admitted wind run;
- `POST /v2/projects/{project_id}/runs/{run_id}/cancel` applies a committed
  backend cancellation tombstone;
- v2 evidence and receipt routes return digest-bound lifecycle records;
- v1 event and artifact reads remain because the backend's wind adapter calls
  those exact evidence routes;
- internal wind activation routes materialize, capture, compare-and-swap, and
  recover framed model candidates.

There is no generic model registry, generic execution dispatch, alternate
model fallback, or non-framed execution path. A private-draft run is admitted
only after the technical activation DAG is ready and the active bundle,
experiment, runtime profile, and activation-root authority all select the
exact reviewed framed contract. Unknown endpoints return 404.

Successful runs publish exactly the declared request, metadata, daily KPI,
domain-event, summary, replay, derived-view, and bounded-log artifacts. Parent
and worker independently verify model, experiment, request, policy, receipt,
lifecycle, and artifact identities before evidence becomes public.

## Deterministic evidence checks

Run and independently verify the direct framed diagnostic baseline for the
reviewed 100-turbine, 3-crew, 1,095-day, 365-day-warm-up, seed-2 scenario:

```sh
uv run python -m mesa_service.run_baseline \
  --preset wind-turbine-maintenance-demo-v1 \
  --output-dir ../outputs/gate1-wind-baseline
uv run python -m mesa_service.verify_run ../outputs/gate1-wind-baseline
```

The command materializes the exact framed reviewed bundle and emits the same
framed replay, metadata, and derived-view schemas used by ready activated
runs. It does not create project authority or bypass service admission. The
result remains synthetic, single-seed, private-draft evidence: it supports
inspection and behavioral reproduction only, not operational recommendation.
