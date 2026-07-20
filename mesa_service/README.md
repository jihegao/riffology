# Mesa execution service

This is the internal Mesa-only FastAPI service for the local Riff Demo. It is
not browser-facing: the demo backend owns browser routes, parameter drafts, and
the adapter that builds normalized Mesa run requests.

Gate 0 has approved `wind-turbine-maintenance` as the replacement target. The
current code and commands below still run the legacy `queue-network-v1`; they do
not prove that the target model, hybrid event log, presets, or evidence views
exist. See [`../docs/mesa-service.md`](../docs/mesa-service.md) and
[`../docs/wind-turbine-maintenance-gate-0.md`](../docs/wind-turbine-maintenance-gate-0.md).

From this directory:

```sh
uv run --extra test pytest
uv run uvicorn mesa_service.app:app --host 127.0.0.1 --port 8091
```

`WORKSPACE_ROOT` selects the workspace root (default: `./.riff-workspace`).
The service listens only where its caller configures it; production integration
should bind it to loopback and call it only from the demo backend.

The currently implemented legacy model is `queue-network-v1`. Load it with:

```sh
curl -X PUT http://127.0.0.1:8091/v1/projects/demo/model \
  -H 'content-type: application/json' \
  -d '{"model_id":"queue-network-v1"}'
```

Use the returned `model_revision`, the complete parameter defaults, explicit
`steps`, and explicit `seeds` to start a legacy run. This path is replaced and
then removed at Gate 4; it is not retained as a fallback or regression fixture.
