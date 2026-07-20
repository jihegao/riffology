# Wind-turbine Mesa service target contract

## Status and scope

This is the Gate 0 target for Gate 1 implementation. The current service still
implements `queue-network-v1`; nothing in this document claims the target model,
schemas, events, or artifacts already run.

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

The AnyLogic experiment selects simultaneous events LIFO. The baseline either
preserves LIFO with a stable decreasing sequence key or records a deliberate
priority rewrite in the source map. Python heap accidents, object addresses,
unordered collections, and AgentSet iteration are forbidden tie-breakers.

All stochastic choices use the request seed through model-owned random streams.
The worker does not use module-global randomness, wall-clock time, or external
I/O. Same model revision, experiment revision, and seed must produce the same
canonical event digest.

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

An immutable model revision contains code, semantic schema, defaults, metrics,
spec, traceability, source provenance, and digests. An immutable experiment
revision binds the model revision and complete parameter values. A run request
accepts no parameter overrides:

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

The worker writes `<run-id>.tmp/`, fsyncs/validates required files, and atomically
promotes it to `<run-id>/`. Terminal failures, cancellations, and timeouts still
retain bounded request, metadata, and log evidence.

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

Each domain event has at least:

```text
event_id, sequence, sim_time_days, event_type,
turbine_id?, crew_id?, work_order_id?, correlation_id?,
before_state?, after_state?, payload,
project_id, model_revision_id, experiment_revision_id, run_id, seed
```

Required event families include failure, maintenance due, work-order queued or
superseded, dispatch, arrival, repair/maintenance/replacement start and finish,
return start and finish, and daily snapshot. Events are never dropped for UI
performance. Replay may sample frames, but references the full event log and
records its derivation.

## Metrics

Warm-up events are retained. Decision KPIs use `[365, 1095]` days and exact
event-interval integration, not an average of daily snapshots:

- availability = turbine time in `operating` / total turbine time;
- corrective response = failure to repair/replacement start;
- maintenance overdue = due time to maintenance start;
- crew utilisation, with driving and on-site work separately visible;
- operation counts and synthetic operation/crew costs;
- annualized revenue, expense, and profit only as source-traceability
  diagnostics.

Mean and P95 waits/overdue values are diagnostics. The 95% target is the sole
Phase 1 hard business constraint. A single fixed seed is not uncertainty
analysis and supports no crew-count recommendation.

## APIs and execution limits

Gate 1 may refine schemas without changing these semantics:

```text
PUT    /v1/projects/{project_id}/models/wind-turbine-maintenance
GET    /v1/projects/{project_id}/models/active
POST   /v1/projects/{project_id}/runs
GET    /v1/projects/{project_id}/runs/{run_id}
POST   /v1/projects/{project_id}/runs/{run_id}/cancel
GET    /v1/projects/{project_id}/runs/{run_id}/events?after=<sequence>&limit=<n>
GET    /v1/projects/{project_id}/runs/{run_id}/artifacts/{declared_name}
```

Unknown IDs, extra keys, non-finite values, traversal, symlinks, and unlisted
artifacts fail closed. One project has at most one active worker. Runs execute in
separate cancellable processes with finite CPU time, wall time, memory, output,
event, and log limits. The 1095-day baseline must fit declared finite limits;
the earlier 500-step queue cap is not reused.

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
