# Mesa execution service contract (MVP)

## Purpose and scope

This document specifies the local service that executes Mesa experiments for the
demo. It is an internal FastAPI service, called by the demo backend; the browser
does not call it directly. The service owns a project's Mesa model revision and
its immutable run artifacts. The demo backend remains the sole owner of the
combined `ProjectState` exposed to the left conversation pane and right
workbench.

The MVP supports exactly one bundled example: `queue-network-v1`, a small
Mesa-based service-queue model. Its parameters are `arrival_rate`,
`service_capacity`, `service_time`, and `initial_backlog`; its numeric snapshot
metrics include `queue_length`, `completed_jobs`, and `mean_wait_time`. A
conversation may select the example and update its documented parameters, but
must not submit arbitrary Python, select another model, or add arbitrary model
parameters. Uploads are contextual inputs for the conversation in this stage;
they do not change the execution contract automatically.

This boundary intentionally supplies a credible Mesa execution loop, not
scientific model validation, a general model generator, remote execution,
parallel runs, or a Solara application.

## Runtime and model protocol

- Python 3.10+ and `mesa[rec]>=3,<4` are required by the runner environment.
- The bundled module exports `QueueNetworkModel`, a `mesa.Model` subclass.
- Its constructor accepts `seed: int | None = None` and every declared
  parameter as keyword-only-compatible values. Unknown parameters are rejected
  before the worker starts.
- `step()` advances exactly one simulation tick. The worker invokes it exactly
  `steps` times unless cancelled or timed out.
- `snapshot() -> dict[str, int | float]` returns a flat map of finite numeric
  metrics after each tick (including tick zero). Metrics named in the model
  schema must always be present.
- All stochastic choices are derived from the supplied seed. The model must not
  use unseeded module-global randomness, wall-clock time, or network I/O.

`queue-network-v1` is versioned as a bundled, reviewed asset. The service
copies that exact source and JSON schemas into a project revision before a run.
It never imports a model directly from a user-uploaded path or evaluates code
provided in a chat message.

## Versioned project layout

`WORKSPACE_ROOT/projects/<project-id>/` is the canonical workspace layout for
this demo. The demo backend and Mesa service are configured with the same
`WORKSPACE_ROOT`; other documents must use this layout rather than a separate
`workspaces/<project-id>` root. IDs are server-generated URL-safe UUIDs and are
never treated as filesystem paths.

```text
WORKSPACE_ROOT/
  projects/<project-id>/
    inputs/
      <upload-id>-<safe-original-name>       # owned by the demo backend
    model/
      active.json                            # points to one immutable revision
      revisions/<model-revision>/
        model.py                             # copied bundled queue-network-v1
        model_schema.json
        experiment_schema.json
        manifest.json                        # model id, protocol version, sha256
    runs/<run-id>/
      request.json                           # validated immutable run request
      metadata.json                          # status, timings, seed(s), model digest
      timeseries.csv                         # one row per seed/tick/metric set
      summary.json                           # per-seed and aggregate final metrics
      run.log                                # worker stdout/stderr, bounded in size
```

The demo backend owns file upload validation, attachment manifests, persisted
UI parameter drafts, public browser routes, and all mapping between browser
state and this service. The `inputs/` directory is therefore written by the
backend, not by a Mesa endpoint. The runner writes artifacts to
`<run-id>.tmp/` and atomically promotes that directory to `<run-id>/` only after
it has written terminal `metadata.json`. Terminal failures, cancellations, and
timeouts still produce `request.json`, `metadata.json`, and `run.log`;
successful runs additionally produce `timeseries.csv` and `summary.json`. API
responses expose artifact names and parsed JSON/CSV-derived data, never
arbitrary workspace paths.

## JSON contracts

### `model_schema.json`

This is the Mesa service's parameter definition. The demo-backend adapter turns
it into the UI's labelled field schema and holds persisted UI parameter drafts
in `ProjectState`; neither the browser nor the Mesa service treats a UI draft as
a runnable experiment. It uses a deliberately small JSON-Schema-like subset,
rather than accepting arbitrary schema features.

```json
{
  "protocol_version": "mesa-model-v1",
  "model_id": "queue-network-v1",
  "model_class": "QueueNetworkModel",
  "title": "Service queue",
  "parameters": [
    {"name": "arrival_rate", "type": "number", "minimum": 0.1, "maximum": 100, "default": 6},
    {"name": "service_capacity", "type": "integer", "minimum": 1, "maximum": 50, "default": 2},
    {"name": "service_time", "type": "number", "minimum": 0.1, "maximum": 100, "default": 1},
    {"name": "initial_backlog", "type": "integer", "minimum": 0, "maximum": 1000, "default": 0}
  ],
  "metrics": ["queue_length", "completed_jobs", "mean_wait_time"],
  "default_steps": 40,
  "maximum_steps": 500
}
```

Every parameter is required in a fully normalized run request assembled by the
demo-backend adapter after it applies the active schema defaults; a number must
be finite and within its inclusive bounds. Integer parameters cannot be supplied
as a float. No extra keys are accepted.

### `experiment_schema.json` and run request

`experiment_schema.json` is the same supported request shape below, with the
parameter definitions copied from `model_schema.json`. Before calling Mesa, the
demo-backend adapter must resolve the active `model_revision`, all parameter
values, `steps`, and `seeds`; Mesa receives this fully normalized request and
records it unchanged in `request.json`. It has no parameter-draft or browser
command endpoint.

```json
{
  "model_revision": "mr_01J...",
  "steps": 40,
  "seeds": [20260719],
  "parameters": {
    "arrival_rate": 6,
    "service_capacity": 2,
    "service_time": 1,
    "initial_backlog": 0
  }
}
```

Rules:

- `model_revision` must equal the current project revision; stale revisions are
  rejected with `409 model_revision_not_active`.
- `steps` is an integer from 1 through the model maximum (500 for the example).
- `seeds` is required and contains one to five unique signed 32-bit integers.
  The demo backend generates and persists a seed before submission when a user
  did not choose one; Mesa does not generate a seed after accepting a run.
- A seed is a replication. The runner executes seeds serially in one isolated
  process and writes a `seed` column, so the result can be summarized without
  losing its raw series.

### Result artifacts

`timeseries.csv` has the fixed header:

```text
seed,tick,queue_length,completed_jobs,mean_wait_time
```

`summary.json` includes `model_id`, `model_revision`, `steps`, `seeds`, metric
names, `final_by_seed`, and an `aggregate_final` object with `mean`, `min`, and
`max` for each metric. `metadata.json` includes `run_id`, status, timestamps,
timeout setting, worker exit code, cancellation reason when relevant, the
normalized request digest, and model manifest digest. Timestamps and log text
are metadata, not reproducibility inputs.

## HTTP API

All endpoints are local demo-backend-to-service calls; there is no browser CORS
or public Mesa route in this contract. JSON errors use
`{"error":{"code":"...","message":"...","details":{}}}`. Unknown project,
revision, and run IDs return `404`; invalid JSON or contract violations return
`422`.

| Method and path | Request | Success response | Notes |
| --- | --- | --- | --- |
| `PUT /v1/projects/{project_id}/model` | `{"model_id":"queue-network-v1"}` | `200` active revision with `model_schema` | Materializes a new immutable bundled revision and makes it active. Any other ID is `422`. |
| `GET /v1/projects/{project_id}/model` | — | `200` active revision, manifest, model schema | `404` until the model is loaded. |
| `GET /v1/projects/{project_id}/parameters` | — | `200` `{model_revision, parameters, default_steps, maximum_steps}` | Convenience projection for the workbench. |
| `POST /v1/projects/{project_id}/runs` | run request | `202` `{run_id,status:"queued",model_revision}` | Validates and persists request before spawning. One active run per project; a second request is `409 run_already_active`. |
| `GET /v1/projects/{project_id}/runs/{run_id}` | — | `200` run metadata plus `status` | Status is `queued`, `running`, `succeeded`, `failed`, `cancelled`, or `timed_out`. |
| `POST /v1/projects/{project_id}/runs/{run_id}/cancel` | — | `202` current metadata | Idempotent for terminal runs; it never reports success as cancelled. |
| `GET /v1/projects/{project_id}/runs/{run_id}/results` | — | `200` normalized summary plus time-series rows | `409 run_not_complete` until `succeeded`; `404` when no successful artifacts exist. |
| `GET /v1/projects/{project_id}/runs/{run_id}/artifacts/{name}` | `name` in fixed allowlist | `200` downloaded artifact | Only `request.json`, `metadata.json`, `summary.json`, `timeseries.csv`, or `run.log`; log is capped and returned as text. |

The demo backend maps these responses into `ProjectState` and its public
SSE/WebSocket updates for both panes. The backend adapter maps UI `modelId` and
saved parameter drafts to the active `model_revision`, validated parameter
object, explicit `steps`, and explicit `seeds` required by `POST .../runs`.
Playwright may invoke the workbench buttons that cause those public backend
calls, but it must not call the Mesa API or infer run state from the DOM.

## Worker lifecycle, isolation, and cancellation

`POST .../runs` creates the artifact directory and launches a new Python worker
process with an argument list (never a shell command). The parent FastAPI
process only validates requests, tracks the process handle, and reads
artifacts; it never imports a project model itself. The worker receives the
revision directory, normalized request file, and temporary output directory.

- The worker has a new process group, `cwd` set to its temporary run directory,
  a fixed environment allowlist, unbuffered captured stdout/stderr, no inherited
  API keys, and no user-controlled executable or arguments.
- It applies a 30-second wall-clock timeout for the demo. Parent and worker
  both enforce it so a wedged worker cannot leave status as `running`.
- Cancellation changes status to `cancelling` internally, sends `SIGTERM` (or
  the platform equivalent) to the process group, waits up to five seconds, then
  kills the group. The final externally visible status is `cancelled` unless a
  timeout won first, in which case it is `timed_out`.
- `timed_out` is a distinct, terminal external run status, not an alias for
  `failed`. It has no successful results, but its metadata and bounded log
  remain available through the documented artifact/status endpoints.
- The worker checks a cancellation marker between ticks and between seed
  replications, writes terminal metadata in a `finally` path, and flushes logs.
- Only one active worker belongs to a project; different local projects may run
  concurrently if the service-level worker limit permits it. The initial
  service-level limit is two.
- A non-zero exit, malformed snapshot, non-finite metric, schema mismatch,
  timeout, or missing expected artifact makes the run terminally unsuccessful;
  no partial result is served as success.

The process boundary protects the FastAPI process from ordinary generated-model
errors. It is not a security sandbox. This MVP is local-only and executes only
the bundled reviewed module; a remote or arbitrary-model version requires an
OS/container sandbox and a separate security design.

## Seeded smoke run

The service distribution includes a deterministic smoke request for the one
supported model:

```json
{
  "model_id": "queue-network-v1",
  "steps": 12,
  "seeds": [20260719],
  "parameters": {
    "arrival_rate": 6,
    "service_capacity": 2,
    "service_time": 1,
    "initial_backlog": 0
  }
}
```

Before a build is accepted, execute this request through the same worker entry
point used by the API. It must finish within the configured timeout, write 13
rows (tick zero through 12) with the exact fixed header, and emit finite values
for all three metrics. Re-running it in a fresh project must produce identical
`timeseries.csv` and `summary.json` after excluding run IDs, timestamps, paths,
and log text. The smoke test proves service wiring and reproducibility only; it
does not validate the model against a real system.

## Required tests

### Unit tests

- Model protocol: the bundled class subclasses `mesa.Model`, accepts all
  declared parameters plus `seed`, exposes `step` and numeric `snapshot`, and
  produces identical series for the smoke seed.
- Schema validation: defaults, min/max, integer coercion rejection, unknown
  parameter rejection, duplicate/out-of-range seed rejection, and stale model
  revision rejection.
- Artifact writer: exact CSV header/order, tick-zero inclusion, finite metric
  guard, aggregate summary calculation, manifest/request digests, temporary
  directory promotion, and no path traversal through IDs or artifact names.
- Lifecycle reducer: allowed state transitions, terminal-state immutability,
  idempotent cancel, cancellation-versus-timeout precedence, and one-active-run
  project lock.

### API integration tests

Use FastAPI's test client with a disposable configured workspace and the real
worker entry point:

1. Load `queue-network-v1`; retrieve the same active revision and its
   parameter schema.
2. Start the seeded smoke request; poll until `succeeded`; retrieve results and
   each allowed artifact; assert run request/model digests and expected rows.
3. Submit invalid parameters, an invalid model ID, and a stale revision; assert
   `422`, `422`, and `409` respectively without starting a worker.
4. Start a deliberately slow test-double worker; request cancellation; assert a
   terminal `cancelled` status, process exit, persisted log and metadata, and
   unavailable successful results.
5. Start a blocking test-double worker under a short configurable timeout;
   assert `timed_out`, process-group cleanup, terminal metadata, and no result
   response.
6. While a worker is active, start another run for the same project and assert
   `409`; after terminal state, a new run is accepted.

### Cross-component and end-to-end checks

- The demo backend translates model and run responses into the shared
  `ProjectState`; both the conversation event stream and workbench read that
  state, not a worker PID or DOM scrape.
- The required Playwright scenario uploads a supported contextual file, selects
  the bundled example through the conversation, observes parameters on the
  right, changes `arrival_rate`, starts the run, waits for `succeeded`, and
  observes the three metrics plus a time-series rendering. The test also checks
  that the assistant summary cites the same `run_id` and summary values.
- Run the scenario at the target desktop viewport and retain screenshot/video
  evidence according to `docs/test-plan.md`. A UI success display alone is not
  enough: the test must retrieve the run result and match its displayed values.

## Interface assumptions for adjacent components

1. The demo backend creates project IDs and owns the canonical
   `WORKSPACE_ROOT/projects/<project-id>/` root, upload metadata, persisted UI
   parameter drafts, public browser command/event routes, and the adapter that
   normalizes a run request. This service does not accept multipart uploads,
   browser commands, or parameter-draft patches in MVP.
2. The OpenCode bridge may request only `queue-network-v1` and documented
   parameter updates through backend tools. It cannot supply a Python module,
   filesystem path, command line, or result body as an authority.
3. The right workbench receives parameter and result projections only from the
   demo backend. The backend may call `GET .../parameters` and must convert a
   saved UI draft into the full Mesa run request (active revision, parameters,
   steps, and seeds) before calling `POST .../runs`; it handles `409` and all
   distinct terminal states, including `timed_out`, visibly.
4. The integration owner supplies a worker entry point and service configuration
   matching this contract, including a test-only slow/blocking worker hook; this
   design does not prescribe the frontend framework or process library.
