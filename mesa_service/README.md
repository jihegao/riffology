# Mesa execution service

This is the internal Mesa-only FastAPI service for the local Riff Demo. It is
not browser-facing: the demo backend owns browser routes, parameter drafts, and
the adapter that builds normalized Mesa run requests.

From this directory:

```sh
uv run --extra test pytest
uv run uvicorn mesa_service.app:app --host 127.0.0.1 --port 8091
```

`WORKSPACE_ROOT` selects the workspace root (default: `./.riff-workspace`).
The service listens only where its caller configures it; production integration
should bind it to loopback and call it only from the demo backend.

The supported model is `queue-network-v1`. Load it with:

```sh
curl -X PUT http://127.0.0.1:8091/v1/projects/demo/model \
  -H 'content-type: application/json' \
  -d '{"model_id":"queue-network-v1"}'
```

Use the returned `model_revision`, the complete parameter defaults, explicit
`steps`, and explicit `seeds` to start a run. See `docs/mesa-service.md` for
the cross-component contract.
