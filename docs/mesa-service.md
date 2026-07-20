# Wind-turbine Mesa service contract

## Status and scope

Gate 1 implements this contract through the direct, backend-only Mesa `/v1`
surface. The reviewed wind bundle, deterministic model, worker, event paging,
artifact verification, and baseline runner exist in `mesa_service`. The current
backend and browser are not yet wind-integrated; their singular legacy queue
path remains reachable until Gate 4 removes it after the later cutover.

The internal FastAPI service is called only by the Riff backend. It owns the
reviewed `wind-turbine-maintenance` model bundle and immutable run directories.
It does not import arbitrary uploaded Python, call the network, interpret chat,
or determine business approval or scientific trust.

## Behavioural source and claim boundary

The mechanism source, exact hash, defaults, adaptations, exclusions, and
non-claims are authoritative in
[`wind-turbine-maintenance-gate-0.md`](wind-turbine-maintenance-gate-0.md).
This is an independent Mesa implementation of selected behaviour from a generic
AnyLogic Field Service example. It is not an AnyLogic runtime import, code copy,
event-by-event equivalence test, calibrated wind-farm model, or staffing
recommendation.

## Model protocol

Gate 1 provides a reviewed Mesa 3 `WindTurbineMaintenanceModel` with:

- `WindTurbineAgent`, `MaintenanceCrewAgent`, explicit `WorkOrder`, and one
  central `MaintenanceBase` in reproducible two-dimensional continuous space;
- turbine states `operating`, `failed_waiting`, `corrective_repair`,
  `planned_maintenance`, and `major_replacement`;
- crew states `idle`, `driving_to_work`, `working`, and `driving_home`;
- corrective-priority and planned-maintenance FIFO queues;
- one active work order per turbine/type and one turbine per crew;
- failure, maintenance-due, travel, work-completion, and return events;
- finite numeric `snapshot()` metrics and a complete domain-event stream.

The source samples failure time on entry to `Working`, using overdue-maintenance
and age factors at that moment. Gate 1 preserves this semantic. It does not
recalculate a hazard once per day. A failure request supersedes a pending
planned-maintenance request for that turbine. When corrective work finishes and
maintenance is overdue, the same crew continues that planned work before
release.

Proactive age replacement is outside Phase 1 and is not an editable parameter.
Probability-driven major replacement after an unrepairable failure remains.
All Phase 1 exposed experiment parameters are editable and resettable.

## Hybrid time and deterministic ordering

Internal time is a finite float in days; one hour is `1/24` day. The public
`step()` advances one natural-day boundary and processes every event through
that boundary in chronological order. Events exactly on a boundary are applied
before that day's snapshot.

The AnyLogic experiment selects simultaneous events LIFO. Gate 1 records an
intentional adaptation: at one timestamp it processes request-producing
triggers, work completions, arrivals/returns, and then one centralized dispatch
phase. A strictly increasing schedule sequence is consumed descending within a
phase. Dispatch selects corrective work first, FIFO within each queue, and
available crews in stable crew-ID order. Python object identity, unordered
collections, and AgentSet iteration are forbidden tie-breakers.

All stochastic choices use the request seed through named model-owned random streams.
The worker does not use module-global randomness, wall-clock time, or external
I/O. Same model revision, experiment revision, seed, and locked runtime profile
must produce the same semantic event digest. That digest excludes project/run
IDs, event UUIDs, wall-clock values, paths, logs, and worker process identity.

## Presets and revisions

Source-reference values and Riff demo defaults are separate files. The required
Riff preset is `wind-turbine-maintenance-demo-v1`:

- 100 turbines;
- 3 crews;
- 1095 simulated days;
- 365 warm-up days;
- seed 2;
- 95% minimum availability as a user-declared demo target.

All other numbers are labelled `synthetic_assumption`. Costs use synthetic
currency units unless a later source supplies a real currency and provenance.
Distribution families are fixed in a model revision: exponential failure and
triangular repair, maintenance, and replacement durations.

An immutable full-SHA model revision contains code, runtime profile, semantic
schema, defaults, metrics, spec, traceability, source provenance, and digests.
An immutable full-SHA experiment revision binds the model revision and complete
parameter values. Gate 1 materializes the bundled demo experiment with null
brief/alignment bindings, `workflow_policy_unmet`, and `draft_unverified`.
Gate 2 creates a distinct revision rather than mutating this one. A wind run
request accepts no parameter overrides:

```json
{
  "experiment_revision_id": "er_..."
}
```

The caller cannot select a review, trust, or execution label. The service
receives the backend-recorded workflow-policy snapshot and its derived
`workflow_policy_met | workflow_policy_unmet` fact for audit, but does not
compute or rename either as trust. Safe admission is independent, and every
Phase 1 run remains `draft_unverified` with private local visibility.

## Model revision bundle

```text
models/wind-turbine-maintenance/revisions/<model-revision-id>/
  manifest.json
  model.py
  model-spec.json
  parameter-schema.json
  metric-schema.json
  visualization.json
  traceability.json
  provenance.json
  defaults/source-field-service-reference.json
  defaults/wind-turbine-maintenance-demo-v1.json
  tests/
```

Stable IDs in code must cover entities, states, transitions, rules, parameters,
metrics, and event types. `model-spec.json` is exported from those IDs. A stale
hand-authored spec, missing source transition disposition, or traceability
digest mismatch fails the Gate 1 contract suite.

## Run artifacts

The isolated worker writes `<run-id>.tmp/`. That child directory and any child
`succeeded` claim remain private: only after the parent observes process exit,
closes the log, verifies the exact artifact set, and atomically renames the
directory does `<run-id>/` become public. Terminal failures, cancellations, and
timeouts retain only bounded request, metadata, and log evidence.

```text
runs/<run-id>/
  request.json
  metadata.json
  daily-kpis.csv
  domain-events.jsonl
  summary.json
  replay-manifest.json
  derived-views-manifest.json
  run.log
```

`metadata.json` binds `project_id`, `run_id`, model/experiment/brief/alignment
revision IDs, input digests, preset, seed, horizon, warm-up, workflow-policy
facts, timestamps, worker limits, terminal status, and artifact digests.

Each domain event has exactly:

```text
event_id, sequence, sim_time_days, event_type, phase,
turbine_id?, crew_id?, work_order_id?, correlation_id?,
before_state?, after_state?, payload,
project_id, run_id, model_id, model_revision_id,
experiment_revision_id, preset_id, seed
```

Required event families include failure, maintenance due, work-order queued or
superseded, dispatch, arrival, repair/maintenance/replacement start and finish,
return start and finish, and daily snapshot. Events are never dropped for UI
performance. Replay may sample frames, but references the full event log and
records its derivation.
The verifier rejects unknown or missing fields, event names outside the model
specification, and event/phase combinations outside the reviewed phase map.

## Metrics

Warm-up events are retained. Decision KPIs use the half-open interval
`[365, 1095)` and exact event-interval integration, not an average of daily
snapshots. The worker writes a post-time-zero row, then a post-boundary row
through day 1095, for 1096 rows total:

- availability = turbine time in `operating` / total turbine time;
- corrective response = failure to repair/replacement start;
- maintenance overdue = due time to maintenance start;
- crew utilisation, with driving and on-site work separately visible;
- operation counts and synthetic operation/crew costs;
- annualized revenue, expense, and profit only as source-traceability
  diagnostics.

Wait cohorts are selected by the originating failure/maintenance-due event in
the measurement window. Starts at or before the horizon complete an
observation; outstanding requests at the horizon are right-censored and counted
separately. P95 uses nearest rank. Before the measurement window, explicit zero
denominators accompany availability `1.0` and utilization `0.0`, preventing an
empty interval from being mistaken for evidence.

Mean and P95 waits/overdue values are diagnostics. The 95% target is the sole
Phase 1 hard business constraint. A single fixed seed is not uncertainty
analysis and supports no crew-count recommendation.

## APIs and execution limits

The plural wind routes coexist with the unchanged singular queue routes:

```text
PUT    /v1/projects/{project_id}/models/wind-turbine-maintenance
GET    /v1/projects/{project_id}/models/active
POST   /v1/projects/{project_id}/runs
GET    /v1/projects/{project_id}/runs/{run_id}
POST   /v1/projects/{project_id}/runs/{run_id}/cancel
GET    /v1/projects/{project_id}/runs/{run_id}/events?after=<sequence>&limit=<n>
GET    /v1/projects/{project_id}/runs/{run_id}/artifacts/{declared_name}
```

The wind PUT body is exactly the reviewed preset ID, and its run body is exactly
one `experiment_revision_id`. `POST /runs` resolves the active model before
validating that model's disjoint request schema; malformed wind requests never
fall back to queue execution. Gate 1 proves the wind path directly and makes no
backend/browser integration claim.

Immediately before creating a run directory, admission re-verifies every file
in the content-addressed model bundle, validates the experiment document, and
recomputes its `experiment_revision_id`. Drift under an existing revision ID is
rejected before a worker can spawn.

The worker does not rely on that parent check alone. The parent passes the
admitted model/experiment IDs and exact request-file SHA-256 outside the request
document. At process start the worker independently verifies the complete
bundle, captures all declared bytes, recomputes the model and experiment
content IDs, checks the request against the canonical experiment, and executes
the captured verified `model.py` bytes. Post-admission drift therefore fails
before model construction or evidence-file creation.

Unknown IDs, extra keys, non-finite values, traversal, symlinks, and unlisted
artifacts fail closed. One project has at most one active worker. Wind runs use
an isolated process, a 180-second parent timeout, caps of 2,000,000 processed
and emitted events, 256 MiB for the complete event log, 16 MiB for daily KPIs,
4 MiB for logs, and 300 MiB total successful output. Reaching a limit fails the
run; it never truncates evidence. The earlier 500-step queue cap is not reused.

Successful artifacts are fsynced and must be exactly the eight declared regular
files. Events are checked against the exact field/type/vocabulary/phase
contract; every KPI column and summary metric is checked against the exact
53-property metric schema. Identities, digests, sizes, financial derivations,
and completeness are verified before atomic promotion. Symlinks in any model,
experiment, run, artifact, or ancestor path fail closed. Failure, cancellation,
timeout, and resource-limit exits retain only bounded request, metadata, and log
evidence.

Browser playback density may be lowered. Computational events, requested
turbine count, and horizon may not be silently reduced. Any such experiment
change requires a new experiment revision.

## Gate 1 acceptance

- Three-turbine deterministic micro-case matches hand-checked event, queue,
  state-time, and cost oracles.
- Corrective priority, FIFO, supersession, continued overdue maintenance, work
  uniqueness, crew exclusivity, state conservation, and non-negative time/cost
  invariants pass.
- Simultaneous-event cases have stable documented ordering.
- Same revision/seed yields the same canonical event digest.
- Code/spec/traceability drift fails.
- Baseline artifacts all resolve to one exact run/model/experiment identity.
- Claim-boundary labels remain present in metadata and summaries.
