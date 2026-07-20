# Gate 1 wind-turbine model implementation design

## Status, authority, and exit boundary

This is the implementation design for
[#3](https://github.com/jihegao/riffology/issues/3). It refines, but does not
replace, the approved
[`wind-turbine-maintenance` Gate 0 contract](wind-turbine-maintenance-gate-0.md)
and the [Mesa service target contract](mesa-service.md). If this document and
Gate 0 conflict, Gate 0 wins until a reviewed contract change is merged.

Gate 1 is complete only when the reviewed Mesa model, deterministic micro-case,
fixed-seed baseline, revision bundle, run artifacts, and the tests named below
exist and pass. This design by itself is not implementation evidence.

The model is a behavioural reproduction of selected mechanisms in the local
AnyLogic Field Service example. It is not an AnyLogic runtime import, numerical
equivalence result, calibrated wind-farm model, uncertainty analysis, staffing
recommendation, or evidence fit for a consequential decision. All demo inputs
are synthetic, Phase 1 uses one seed, and the `95%` availability target is a
user-declared demo constraint rather than an industry benchmark.

## Frozen implementation decisions

- Runtime: Mesa 3 on Python 3.10+, with `WindTurbineMaintenanceModel` extending
  `mesa.Model` and turbine/crew objects extending `mesa.Agent`.
- Time: continuous fractional days internally; one public `step()` advances to
  the next natural-day boundary after processing boundary events.
- Event engine: a model-owned `heapq` scheduler, not Mesa's experimental event
  API. This keeps ordering stable across the supported Mesa 3 range.
- Simultaneous events: an intentional business-phase adaptation is used instead
  of raw AnyLogic global LIFO. At one `sim_time_days`, process request-producing
  triggers, then work completions, then arrivals/returns, then one centralized
  dispatch phase. Within a phase, use source-traceable LIFO.
- Work selection: corrective before planned; FIFO within each queue; stable
  crew ID when several crews become available together.
- Randomness: deterministic named streams derived from the run seed; no module
  global random state, clock, process ID, path, or network input.
- Evidence: all machine-readable specs are exported from stable definitions in
  model code. Committed JSON is checked byte-for-byte against a canonical
  export, so stale spec or traceability data fails tests.
- Public Gate 1 execution: add a direct Mesa-service wind path without changing
  the current backend or web application. The legacy queue endpoints remain
  reachable for those callers through Gate 3. Gate 4 switches the integrated
  product and performs the queue model's complete audited deletion.
- Experiment admission: model loading materializes the bundled demo preset as a
  content-addressed immutable experiment revision. A run accepts that revision
  ID only; it accepts no inline parameter overrides.

## Source boundary and transition disposition

The source is `Field Service.alp` at the path and SHA-256 recorded by Gate 0.
No AnyLogic Java, images, logo, or 3D asset is copied. The following stable
dispositions must appear in the code-exported `model-spec.json`; source IDs and
names are evidence references, not target identifiers.

### Equipment transitions

| AnyLogic transition | Target disposition |
| --- | --- |
| `Failure` | `failure_triggered`: leave `operating`, retain due state, supersede or convert planned work, enqueue corrective work, and invalidate the operating failure token. |
| `SCArrivedForRepair` | `crew_arrived` followed by `corrective_work_selected`; the replacement draw is made exactly once on arrival. |
| `FinishRepair` | `corrective_repair_completed`; add repair cost, then continue overdue maintenance with the same crew or re-enter operating. |
| `StartReplacement` | Combined into `corrective_work_selected`; proactive-age branch is excluded, while the configured unrepairable-failure probability selects replacement. |
| `FinishReplacement` | `major_replacement_completed`; add cost, set both last-replacement and last-maintenance time, reschedule maintenance due, and re-enter operating. |
| `FinishMaintenance` | `planned_maintenance_completed`; add cost, set last-maintenance time, reschedule due, and re-enter operating. |
| `SCArrivedForMtce` | `crew_arrived` followed by `planned_maintenance_started`. |
| `StartRepair` | Combined into `corrective_work_selected` when replacement is not selected. |
| unnamed `transition` after repair | `corrective_repair_completed` direct operating branch when maintenance is not overdue. |
| `MaintenanceDue` after repair | `corrective_repair_completed` same-crew continuation when maintenance is overdue. |
| `PlannedReplacement` | Explicitly `deferred`: proactive replacement is fixed off and absent from the experiment schema. |
| `StartMaintenance` | `planned_maintenance_started`. |

The source `MaintenanceTimer` becomes `maintenance_due_triggered`. Its due time
is retained even when a request is not queued because the same turbine already
has a corrective order or assigned crew.

### Crew transitions

| AnyLogic transition | Target disposition |
| --- | --- |
| `CheckRequestQueue` | A deduplicated centralized dispatch event at the same simulation time. |
| `Arrived` | `crew_arrived`; begin the assigned repair, replacement, or maintenance operation. |
| `Finished` | Work-completion handler releases or continues the crew, then requests centralized dispatch. |
| `ArrivedHome` | `crew_returned`; set crew `idle` at the depot, then request dispatch. |
| `RequestsWaiting` | Central dispatcher assigns the highest-priority FIFO order and starts travel. |
| `NoRequests` | Start `driving_home` only if both queues are empty. |
| `IAmOK` | Fixed run-start crew population makes this a normal post-work dispatch. |
| `IAmLaidOff` | `deferred`: no mid-run workforce resizing. |
| `CheckIfLaidOff` | `deferred`: crew count is immutable within one experiment revision. |

The raw source's global simultaneous-event LIFO is therefore **adapted**, not
claimed as direct equivalence. `traceability.json` must record the reason: all
same-time failures and maintenance-due triggers become visible before a newly
free crew is assigned, preserving the approved corrective-priority business
rule. Source LIFO remains observable inside each business phase.

## Exact code model

### Stable enums and records

`model.py` owns these values; JSON specs project them without renaming.

```text
TurbineState = operating | failed_waiting | corrective_repair |
               planned_maintenance | major_replacement
CrewState = idle | driving_to_work | working | driving_home
RequestKind = corrective | planned
OperationKind = repair | maintenance | replacement
WorkStatus = queued | assigned | in_progress | completed | superseded
EventPhase = request_trigger(10) | work_completion(20) |
             arrival_or_return(30) | dispatch(40) |
             daily_snapshot(50, projection only)
```

`ScheduledEvent` is an immutable record with:

```text
sim_time_days, phase, schedule_sequence, event_type,
turbine_id?, crew_id?, work_order_id?, token?, payload
```

Its heap key is `(sim_time_days, phase, -schedule_sequence)`. Sequence is a
strictly increasing model-owned integer. It is the final tie-breaker, so heap
comparison never reaches payloads, agents, or Python object identity. An event
with a stale generation token is consumed and logged only as an internal debug
counter; it does not emit a domain event.

`WorkOrder` has:

```text
work_order_id, request_kind, operation_kind?, turbine_id, correlation_id?,
requested_at_days, source_event_id,
enqueue_sequence, status, assigned_crew_id?, assigned_at_days?,
started_at_days?, completed_at_days?, superseded_by_order_id?
```

Queue keys are `(requested_at_days, enqueue_sequence, work_order_id)`. Separate
corrective and planned heaps make corrective priority explicit. Superseded
entries are removed lazily after status validation. IDs are deterministic:
`turbine-0001`, `crew-001`, `work-00000001`, `event-00000001`.

Request priority and the operation ultimately performed are separate concepts.
A corrective `WorkOrder` keeps the same ID from queue through dispatch,
arrival, replacement decision, work, and completion. At arrival its previously
null `operation_kind` becomes exactly `repair` or `replacement`; it is not
replaced by a second work order. A planned request becomes `maintenance` at
arrival. Same-crew overdue maintenance after a repair is a new planned work
order whose `source_event_id` is the original maintenance-due event and whose
`correlation_id` links the completed corrective order.

### `WindTurbineAgent`

Required fields:

```text
turbine_id, x_km, y_km, state,
time_last_maintenance_days, time_last_replacement_days,
maintenance_due_at_days, maintenance_due_event_id?,
failure_generation, maintenance_generation,
active_corrective_order_id?, active_planned_order_id?,
assigned_crew_id?
```

`maintenance_due_at_days <= now` is the sole overdue predicate. The turbine
may remain `operating` while overdue or while a planned crew is travelling.
It becomes unavailable only on failure or when on-site work starts.

### `MaintenanceCrewAgent`

Required fields:

```text
crew_id, x_km, y_km, state, current_work_order_id?,
destination_turbine_id?, state_entered_at_days,
travel_generation
```

All crews start `idle` at the central depot. A crew returning home cannot take
a new order until `crew_returned`, matching the source's lack of a request
transition from `DrivingHome`. If the next turbine is at the crew's exact
location, dispatch logs arrival and starts work in phase 40 without scheduling
a lower-phase event at the already-partly-processed timestamp.

### `WindTurbineMaintenanceModel`

The model owns agents, parameters, current time, natural-day index, scheduler,
queues, work-order registry, named random streams, metric accumulator, event
sink, and all counters. Required public methods are:

```python
step() -> None
snapshot() -> dict[str, int | float]
drain_domain_events() -> list[dict]
export_model_spec() -> dict
```

The worker supplies a streaming event sink; `drain_domain_events()` exists for
bounded unit tests only. Production does not retain the complete event log in
memory.

Initialization proceeds in stable turbine ID order:

1. validate the complete parameter object and seed;
2. create depot, turbines, and crews;
3. assign layout using the `layout` stream;
4. sample each initial last-maintenance time uniformly from
   `[-maintenance_period_days, 0]` using the `initial_maintenance` stream;
5. set every last-replacement time to exactly `0`;
6. schedule each maintenance-due trigger;
7. enter every turbine into operating and sample one failure delay;
8. process all time-zero events through phase 40;
9. expose the time-zero snapshot.

### Named random streams

Derive each stream seed as the first 64 bits of
`SHA-256("wind-turbine-maintenance-v1:<run-seed>:<stream-name>")`, then use a
dedicated `random.Random`. Stable stream names are `layout`,
`initial_maintenance`, `failure`, `repair_duration`, `maintenance_duration`,
`replacement_decision`, and `replacement_duration`. Adding a draw to one
mechanism cannot perturb another mechanism's stream.

Tests may inject a private `ScenarioFixture`/`ScriptedRandomSource` into the
same model class. This seam is not present in `parameter-schema.json` or the
HTTP API and may control locations, initial due/failure times, replacement
decisions, and durations. It replaces draws only; it does not replace the
scheduler, transitions, queues, metrics, or event writer.

## Transition and scheduling rules

### Operating entry and failure

On every entry to `operating`:

```text
overdue_factor = max(1, (now - time_last_maintenance) / maintenance_period)
age_factor = max(1, (now - time_last_replacement) / (3 * maintenance_period))
failure_rate = normal_failure_rate_per_day * overdue_factor * age_factor
failure_delay = Random.expovariate(failure_rate)
```

The delay must be finite and strictly positive. Increment `failure_generation`
and schedule one failure trigger with that token. Do not recalculate a daily
hazard. Leaving operating invalidates the token. Maintenance completion and
replacement completion re-enter operating and therefore resample.

At a valid failure trigger:

1. set the turbine to `failed_waiting` and emit `failure_occurred`;
2. if a planned order is queued, mark it `superseded`, emit
   `request_superseded`, and create a corrective order;
3. if a crew is already travelling for planned work on this turbine, supersede
   that planned order with an assigned corrective order for the same crew and
   destination rather than duplicating travel;
4. otherwise enqueue exactly one corrective order;
5. schedule the deduplicated phase-40 dispatcher.

### Maintenance due

At a valid due trigger, record the exact due time and emit `maintenance_due`.
If a corrective order/crew already owns the turbine, retain the due timestamp
without adding a planned queue entry and emit `request_suppressed` with reason
`corrective_order_active` or `crew_already_assigned`. Otherwise create at most
one planned order and emit `request_queued`. Maintenance completion or
replacement completion clears the due marker, increments the maintenance
generation, and schedules `now + maintenance_period_days`.

### Centralized dispatch

At most one phase-40 dispatch marker exists for a simulation timestamp. During
that event:

1. sort all available `idle` crews by `crew_id`;
2. repeatedly pop the first valid corrective order, otherwise the first valid
   planned order;
3. bind one crew and order atomically and emit `crew_dispatched`;
4. set the crew to `driving_to_work` and schedule arrival using
   `travel_days = distance_km / (crew_speed_km_per_hour * 24)`;
5. when no work remains, leave depot-idle crews idle; a just-released crew away
   from the depot starts `driving_home` and emits `crew_return_started`.

Dispatch never preempts a crew already travelling or working. Corrective
priority means priority at assignment time; it does not retroactively cancel a
different turbine's in-flight planned trip.

### Arrival, work, completion, and continuation

Arrival emits `crew_arrived` and begins exactly one operation:

- corrective arrival draws replacement once; select `major_replacement` when
  `major_replacement_enabled` and the draw is below the configured probability,
  otherwise select `corrective_repair`;
- planned arrival selects `planned_maintenance`;
- set both agent states, mark the work in progress, emit the matching start
  event, and schedule one positive-duration completion.

Repair completion adds corrective cost and emits `repair_completed`. If the
turbine is overdue, create an in-progress planned order for the same crew at
the same time, emit `maintenance_started`, and schedule its completion without
dispatch or travel. Otherwise release the crew and re-enter operating.

Maintenance completion adds planned cost, updates last maintenance, clears the
due marker, reschedules due, and re-enters operating. Replacement completion
adds replacement cost, updates both last-replacement and last-maintenance,
reschedules due, and re-enters operating. A released away-from-depot crew is
assigned queued work at phase 40 or starts its return home.

### Simultaneous-event fixpoint

For a time `t`, drain phases in numeric order. New events may be added to the
current or a later unprocessed phase. Scheduling into an already-finished lower
phase at `t` is a model error, except the documented zero-distance arrival that
is executed inline by dispatch. Within a phase, the most recently scheduled
event runs first. Central dispatch runs once after all other same-time effects
are visible. Tests cover:

- failure and maintenance due at the same instant;
- work completion concurrent with a new failure/request;
- two crews released simultaneously;
- two corrective orders requested simultaneously;
- a stale failure or due token;
- zero-distance dispatch.

## Parameter and preset contract

`parameter-schema.json` uses the exact IDs below. Distribution families and
metric formulas belong to the model revision and are not editable experiment
values. Cross-field validation enforces triangular low <= mode <= high, depot
inside the farm, warm-up < horizon, and finite values.

| Parameter ID | Type/range and unit | Source reference | Demo v1 default and provenance |
| --- | --- | ---: | ---: |
| `turbine_count` | integer `1..500`, count | `100` | `100`, `source_seeded_synthetic_assumption` |
| `crew_count` | integer `1..50`, count | `3` | `3`, `source_seeded_synthetic_assumption` |
| `maintenance_period_days` | number `1..3650`, day | `90` | `90`, `source_seeded_synthetic_assumption` |
| `normal_failure_rate_per_day` | number `0.000001..10`, 1/day | `0.03` | `0.03`, `source_seeded_synthetic_assumption` |
| `repair_low_hours` | number `0.01..720`, hour | `2.5` | `2.5`, `source_seeded_synthetic_assumption` |
| `repair_mode_hours` | number `0.01..720`, hour | `5` | `5`, `source_seeded_synthetic_assumption` |
| `repair_high_hours` | number `0.01..720`, hour | `12.5` | `12.5`, `source_seeded_synthetic_assumption` |
| `maintenance_low_hours` | number `0.01..720`, hour | `1.5` | `1.5`, `source_seeded_synthetic_assumption` |
| `maintenance_mode_hours` | number `0.01..720`, hour | `3` | `3`, `source_seeded_synthetic_assumption` |
| `maintenance_high_hours` | number `0.01..720`, hour | `4.5` | `4.5`, `source_seeded_synthetic_assumption` |
| `replacement_low_hours` | number `0.01..720`, hour | `6` | `6`, `source_seeded_synthetic_assumption` |
| `replacement_mode_hours` | number `0.01..720`, hour | `12` | `12`, `source_seeded_synthetic_assumption` |
| `replacement_high_hours` | number `0.01..720`, hour | `18` | `18`, `source_seeded_synthetic_assumption` |
| `major_replacement_enabled` | boolean | probability branch present | `true`, `synthetic_assumption` |
| `major_replacement_probability` | number `0..1`, fraction | `0.1` | `0.1`, `source_seeded_synthetic_assumption` |
| `farm_width_km` | number `0.1..100`, km | canvas reference only | `20`, `synthetic_assumption` |
| `farm_height_km` | number `0.1..100`, km | canvas reference only | `20`, `synthetic_assumption` |
| `depot_x_km` | number `0..farm_width_km`, km | canvas `(280,230)` | `10`, `synthetic_assumption` |
| `depot_y_km` | number `0..farm_height_km`, km | canvas `(280,230)` | `10`, `synthetic_assumption` |
| `crew_speed_km_per_hour` | number `0.1..200`, km/hour | `0.00057 m/s` | `50`, `synthetic_assumption` |
| `daily_revenue_per_operating_turbine` | number `0..1000000000`, synthetic currency/day | `400` | `400`, `source_seeded_synthetic_assumption` |
| `crew_cost_per_day` | number `0..1000000000`, synthetic currency/day | `1000` | `1000`, `source_seeded_synthetic_assumption` |
| `repair_cost` | number `0..1000000000`, synthetic currency/operation | `1000` | `1000`, `source_seeded_synthetic_assumption` |
| `maintenance_cost` | number `0..1000000000`, synthetic currency/operation | `600` | `600`, `source_seeded_synthetic_assumption` |
| `replacement_cost` | number `0..1000000000`, synthetic currency/operation | `10000` | `10000`, `source_seeded_synthetic_assumption` |
| `minimum_availability_fraction` | number `0..1`, fraction | none | `0.95`, `user_declared_demo_target` |

The AnyLogic duration signature is `triangular(minimum, mode, maximum)`, while
Python's signature is `random.triangular(low, high, mode)`. The implementation
must therefore call, for each operation family,
`random.triangular(low_hours / 24, high_hours / 24, mode_hours / 24)`. The
argument reorder and hours-to-days conversion are model semantics and have
focused tests; positional pass-through is forbidden.

`defaults/source-field-service-reference.json` is a non-executable provenance
fixture. It records the exact source values, canvas/scale, depot area, source
speed, proactive replacement flag `false`, `MtcePeriodsToReplace=5`, source
seed `2`, LIFO rule, and source horizon reference `18250` without relabelling
them as a wind-farm preset.

`defaults/wind-turbine-maintenance-demo-v1.json` is executable and contains all
parameters above plus:

```json
{
  "preset_id": "wind-turbine-maintenance-demo-v1",
  "horizon_days": 1095,
  "warmup_days": 365,
  "seed": 2,
  "claim_labels": [
    "synthetic_inputs",
    "single_seed",
    "behavioral_reproduction_not_runtime_equivalence",
    "draft_unverified",
    "no_staffing_recommendation"
  ]
}
```

Gate 1 permits exactly one integer `seed` per experiment revision, a horizon of
`1..3660` days, and `0 <= warmup_days < horizon_days`. Multi-seed experiments
and crew-count sweeps belong to Phase 2 even though the eventual protocol may
raise the seed limit without changing the model mechanism.

## Metrics and daily snapshots

State-time metrics use exact interval integration. Before every state change,
accumulate the prior state over `[last_change, event_time)`. Reported KPIs clip
all intervals to the half-open measurement window `[warmup_days,
horizon_days)`. Events and daily rows from warm-up are retained.

For a snapshot at time `t`, define `elapsed = max(0, min(t, horizon_days) -
warmup_days)`, `availability_numerator = operating_turbine_days`,
`availability_denominator = turbine_count * elapsed`,
`utilization_numerator = driving_to_work_crew_days + working_crew_days +
driving_home_crew_days`, and `utilization_denominator = crew_count * elapsed`.
Before the measurement window, both numerators and denominators are exactly
zero, `measurement_window_observed=0`, availability is the finite empty-window
identity `1.0`, and utilization is `0.0`. Once elapsed is positive,
`measurement_window_observed=1` and each ratio uses its explicit denominator.
The numerator and denominator fields are retained in CSV and summary; a ratio
alone is insufficient evidence.

Fixed crew cost is `crew_count * crew_cost_per_day * elapsed`, independent of
utilization. A repair, maintenance, or replacement cost enters the reported
measurement cost only when its completion time is in the half-open interval
`[warmup_days, horizon_days)`. Warm-up operation costs remain visible in events
and lifetime counters but not reported KPIs. Operating revenue is exactly
`availability_numerator * daily_revenue_per_operating_turbine`. No partial
operation cost is prorated across warm-up; costs are completion-posted as in the
source.

Wait cohorts are selected by the originating event time, not completion time:

- corrective response: `failure_occurred` in the measurement window to its
  repair/replacement start;
- maintenance overdue: `maintenance_due` in the measurement window to its
  maintenance start.

The run stops after processing the horizon boundary. An origin in
`[warmup_days, horizon_days)` is included only if its repair/replacement or
maintenance start occurs at or before the horizon boundary. An origin still
waiting at the horizon is reported as right-censored and excluded from
mean/P95. P95 is nearest rank:
`sorted_values[ceil(0.95 * n) - 1]`. Mean and P95 are `0` when `n=0`, with a
separate sample count preventing that sentinel from being mistaken for data.

The worker writes a time-zero daily row after all time-zero phases, then a row
after events at every natural-day boundary through the horizon. The baseline
therefore has `1096` rows for seed 2. Each row has a corresponding
`daily_snapshot` domain event in projection phase 50; it cannot schedule model
events or alter state. `snapshot()` contains only finite numeric values and
includes at least:

```text
sim_time_days; five turbine-state counts; four crew-state counts;
corrective_queue_length; planned_queue_length;
availability_fraction; crew_utilization_fraction;
crew_driving_fraction; crew_working_fraction; crew_returning_fraction;
failure_count; repair_count; maintenance_count; replacement_count;
corrective_wait_mean_days; corrective_wait_p95_days;
maintenance_overdue_mean_days; maintenance_overdue_p95_days;
work_cost; crew_cost; total_maintenance_cost; operating_revenue
```

The row also includes both ratio numerators/denominators,
`measurement_window_elapsed_days`, `measurement_window_observed`, wait sample
counts, censored counts, lifetime operation costs, and interval operation
counts. `work_cost`, `crew_cost`, `total_maintenance_cost`, and
`operating_revenue` are the measurement-window values defined above.

`summary.json` additionally reports annualized maintenance cost and source
traceability revenue/expense/profit diagnostics. Annualization is
`observed_value * 365 / measurement_window_days` when the denominator is
positive; before warm-up the finite displayed annualized value is `0` with
`measurement_window_observed=0`. It reports whether the one baseline run met
the declared 95% constraint but does not compare crew counts or produce a
recommendation.

## Deterministic three-turbine micro-case

The checked-in fixture uses the production scheduler and rules with scripted
draws only:

```text
horizon=4 days, warmup=0, seed=2, one crew, depot=(0,0)
T1=(1,0), T2=(2,0), T3=(3,0)
crew_speed_km_per_hour=1/6 (exactly 4 km/day)
maintenance due: T1=0, T2=0.1, T3=1.2 days
failures: T3=0.2, T2=0.3; T1 and subsequent failures are after horizon
repair duration=0.5 day, maintenance duration=0.25 day
major replacement disabled
repair cost=100, maintenance cost=40, crew cost=10/day
revenue=0, minimum availability target=0.95
```

Hand oracle:

| Time | Required result |
| ---: | --- |
| `0` | T1 maintenance due; crew dispatches from depot to T1. |
| `0.1` | T2 maintenance due and planned request queues. |
| `0.2` | T3 fails and corrective request queues ahead of T2. |
| `0.25` | Crew arrives T1; maintenance runs through `0.5`. |
| `0.3` | T2 fails; its queued planned request is superseded by corrective work. |
| `0.5` | T1 maintenance completes; crew dispatches to T3. |
| `1.0` | T3 repair starts and runs through `1.5`. |
| `1.2` | T3 maintenance becomes due while repair is active; emit `request_suppressed(reason=crew_already_assigned)`. |
| `1.5` | T3 repair completes; same crew starts overdue maintenance through `1.75`. |
| `1.75` | Crew dispatches from T3 to T2. |
| `2.0` | T2 repair starts and runs through `2.5`. |
| `2.5` | T2 repair completes; same crew starts overdue maintenance through `2.75`. |
| `2.75` | Work completes and crew returns home, arriving at `3.25`. |

At day 4 the queues are empty, all turbines operate, and the crew is idle at
the depot. Exact totals are:

```text
operating turbine-days = 7.75 of 12
availability = 7.75 / 12
driving crew-days = 1.5
working crew-days = 1.75
crew utilization = 3.25 / 4
corrective waits = [0.8, 1.7], mean=1.25, P95=1.7 days
maintenance overdue waits = [0.25, 0.3, 2.4],
  mean=0.9833333333333333, P95=2.4 days
repair operations=2, maintenance operations=3, replacements=0
work cost=320, crew cost=40, total maintenance cost=360
```

The filtered non-snapshot domain-event sequence is exactly these 29 events;
the five `daily_snapshot` projection events at days 0 through 4 are additional
and make the complete log 34 lines:

| Filtered mechanism-event ordinal | Time | Exact semantic event |
| ---: | ---: | --- |
| 1 | `0` | `maintenance_due T1` |
| 2 | `0` | `request_queued planned T1` |
| 3 | `0` | `crew_dispatched C1 -> T1, eta=0.25` |
| 4 | `0.1` | `maintenance_due T2` |
| 5 | `0.1` | `request_queued planned T2` |
| 6 | `0.2` | `failure_occurred T3` |
| 7 | `0.2` | `request_queued corrective T3` |
| 8 | `0.25` | `crew_arrived C1, T1` |
| 9 | `0.25` | `maintenance_started T1` |
| 10 | `0.3` | `failure_occurred T2` |
| 11 | `0.3` | `request_superseded planned T2` |
| 12 | `0.3` | `request_queued corrective T2` |
| 13 | `0.5` | `maintenance_completed T1, cost=40` |
| 14 | `0.5` | `crew_dispatched C1, T1 -> T3, eta=1` |
| 15 | `1` | `crew_arrived C1, T3` |
| 16 | `1` | `repair_started T3` |
| 17 | `1.2` | `maintenance_due T3` |
| 18 | `1.2` | `request_suppressed T3, reason=crew_already_assigned` |
| 19 | `1.5` | `repair_completed T3, cost=100` |
| 20 | `1.5` | `maintenance_started T3, same_crew=true` |
| 21 | `1.75` | `maintenance_completed T3, cost=40` |
| 22 | `1.75` | `crew_dispatched C1, T3 -> T2, eta=2` |
| 23 | `2` | `crew_arrived C1, T2` |
| 24 | `2` | `repair_started T2` |
| 25 | `2.5` | `repair_completed T2, cost=100` |
| 26 | `2.5` | `maintenance_started T2, same_crew=true` |
| 27 | `2.75` | `maintenance_completed T2, cost=40` |
| 28 | `2.75` | `crew_return_started C1, eta=3.25` |
| 29 | `3.25` | `crew_returned C1` |

The complete integrated state-time oracle is:

| Entity | Operating | Failed waiting | Repair | Maintenance | Replacement |
| --- | ---: | ---: | ---: | ---: | ---: |
| T1 | `3.75` | `0` | `0` | `0.25` | `0` |
| T2 | `1.55` | `1.70` | `0.50` | `0.25` | `0` |
| T3 | `2.45` | `0.80` | `0.50` | `0.25` | `0` |
| Aggregate | `7.75` | `2.50` | `1.00` | `0.75` | `0` |

The aggregate row sums to `12` turbine-days. Crew state-time is
`idle=0.75`, `driving_to_work + driving_home=1.50`, and `working=1.75`,
summing to four crew-days. Occupied time is `3.25` and utilization `0.8125`.

Exact daily rows are:

| Day | Interval state-time | Boundary state/queue | Cumulative availability | Cumulative utilization | Cumulative total cost |
| ---: | --- | --- | ---: | ---: | ---: |
| `0` | empty window | turbines `operating=3`; crew `driving_to_work=1`; queues `0/0` | `1.0` with numerator/denominator `0/0` and observed `0` | `0` | `0` |
| `1` | operating `1.25`, failed `1.50`, maintenance `0.25` | turbines `operating=1, failed_waiting=1, corrective_repair=1`; crew `working=1`; corrective queue `1` | `1.25/3` | `1/1` | `50` |
| `2` | operating `1.25`, failed `1.00`, repair `0.50`, maintenance `0.25` | turbines `operating=2, corrective_repair=1`; crew `working=1`; queues `0/0` | `2.50/6` | `2/2` | `200` |
| `3` | operating `2.25`, repair `0.50`, maintenance `0.25` | turbines `operating=3`; crew `driving_home=1`; queues `0/0` | `4.75/9` | `3/3` | `350` |
| `4` | operating `3.00` | turbines `operating=3`; crew `idle=1`; queues `0/0` | `7.75/12` | `3.25/4` | `360` |

## Deterministic replacement micro-oracle

A second focused fixture forces the corrective replacement branch without
changing scheduler or model code:

```text
one turbine, one crew, horizon=2, warmup=0, depot=(0,0), turbine=(1,0)
crew_speed_km_per_hour=1/6 (exactly 4 km/day)
failure=0.1, replacement decision=true
replacement duration=0.75 day, replacement cost=500, crew cost=10/day
maintenance due and subsequent failure occur after horizon
```

Its exact non-snapshot sequence is failure, corrective request, and dispatch at
`0.1` with ETA `0.35`; arrival and `replacement_started` at `0.35`;
`replacement_completed(cost=500)` and `crew_return_started(eta=1.35)` at
`1.10`; and `crew_returned` at `1.35`. It emits no `repair_started` or
`repair_completed` event. Turbine state-time is `operating=1.0`,
`failed_waiting=0.25`, `major_replacement=0.75`, so availability is `0.5`.
Crew state-time is `driving=0.5`, `working=0.75`, `idle=0.75`, giving occupied
time `1.25` and utilization `0.625`. Work cost is `500`, crew cost is `20`, and
total cost is `520`. At completion, both last-maintenance and last-replacement
are exactly `1.10`, next maintenance due is `91.10`, and operating re-entry
samples exactly one subsequent failure delay.

## Revision bundle and experiment identity

The reviewed repository source lives under
`mesa_service/src/mesa_service/models/wind_turbine_maintenance/`. A bundle
builder writes the Gate 0 layout:

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
  tests/microcase.json
  tests/source-transition-disposition.json
```

`manifest.json` lists SHA-256, byte length, and media type for every other file.
`model_revision_id` is `mr_` plus the full 64-hex canonical manifest-entry
SHA-256. Loading the same reviewed bundle is idempotent and must not mint a
random revision ID.

The bundled demo preset is normalized together with the model revision into an
immutable experiment document. Its ID is `er_` plus the full 64-hex canonical
JSON SHA-256. In Gate 1, brief/alignment revision IDs are `null`, workflow
policy is explicitly `workflow_policy_unmet`, and trust label is
`draft_unverified`. That document is never mutated or upgraded. Gate 2 creates
a distinct experiment revision with non-null authoritative project bindings
and its own content digest.

The manifest and every run metadata file include a locked runtime profile:

```text
python_implementation, python_major_minor, mesa_version,
model_protocol_version, canonical_json_version
```

Gate 1's release baseline is CPython 3.12 plus the exact Mesa version resolved
by `uv.lock`; the verifier records the concrete value rather than copying a
version string from this design. Semantic digest equality is required for
independent executions under the same locked runtime profile. A different
profile is separately identified and must not be presented as a failed or
passed same-profile reproducibility comparison.

## Run artifact contract

A successful run directory contains exactly the required Gate 0 files plus the
two declared view manifests:

```text
request.json
metadata.json
daily-kpis.csv
domain-events.jsonl
summary.json
replay-manifest.json
derived-views-manifest.json
run.log
```

Every JSON document, CSV row, and domain event carries or inherits the same
`project_id`, `run_id`, `model_id`, `model_revision_id`,
`experiment_revision_id`, preset ID, and seed. `metadata.json` records request,
bundle, experiment, event, KPI, summary, and view-manifest SHA-256 digests plus
limits and terminal status. It does not attempt a self-digest.

Each event JSON line has:

```text
event_id, sequence, sim_time_days, event_type, phase,
turbine_id?, crew_id?, work_order_id?, correlation_id?,
before_state?, after_state?, payload,
project_id, run_id, model_id, model_revision_id,
experiment_revision_id, preset_id, seed
```

Required event types are `failure_occurred`, `maintenance_due`,
`request_queued`, `request_superseded`, `request_suppressed`,
`crew_dispatched`, `crew_arrived`, `repair_started`, `repair_completed`, `maintenance_started`,
`maintenance_completed`, `replacement_started`, `replacement_completed`,
`crew_return_started`, `crew_returned`, and `daily_snapshot`.

The canonical event digest hashes ordered canonical JSON projections of:

```text
sequence, sim_time_days, event_type, phase, turbine_id, crew_id,
work_order_id, correlation_id, before_state, after_state, payload,
model_id, model_revision_id, experiment_revision_id, preset_id, seed,
runtime_profile
```

It excludes project/run IDs, wall-clock timestamps, filesystem paths, worker
PID, logs, and JSONL byte offsets. Floating-point values use the same canonical
JSON serializer as revision digests. Thus two separate runs of the same model,
experiment, seed, and locked runtime profile have identical semantic digests
while retaining different run IDs.

`replay-manifest.json` references the complete event-log digest and may declare
sampled frames; it cannot omit events from the source log. The derived-view
manifest references model-spec, traceability, event, KPI, and summary digests.
Rendered diagrams and UI state are projections, never reproduction sources.

## Gate 1 API coexistence and later cutover

Gate 1 implements the canonical target routes from `mesa-service.md`:

```text
PUT  /v1/projects/{project_id}/models/wind-turbine-maintenance
GET  /v1/projects/{project_id}/models/active
POST /v1/projects/{project_id}/runs
GET  /v1/projects/{project_id}/runs/{run_id}
POST /v1/projects/{project_id}/runs/{run_id}/cancel
GET  /v1/projects/{project_id}/runs/{run_id}/events?after=<sequence>&limit=<n>
GET  /v1/projects/{project_id}/runs/{run_id}/artifacts/{declared_name}
```

The PUT body is exactly
`{"preset_id":"wind-turbine-maintenance-demo-v1"}`. It verifies and
materializes the content-addressed model and default experiment revisions. The
run body is exactly `{"experiment_revision_id":"er_..."}`. Unknown or extra
keys fail with `422`; a stale/non-active experiment revision fails with `409`.

The shared `POST /runs` resolves the active model first and then applies that
model's exact request schema. For wind, only `experiment_revision_id` is valid.
The existing singular model/parameters/results endpoints and queue run schema
remain unchanged for the current backend and web application until Gate 4.
There is no implicit schema union and no fallback from an invalid wind request
to queue execution. Gate 1 acceptance exercises wind through the direct Mesa
API; it does not claim backend or browser wind integration.

The wind model runs in a new `wind_worker.py`. Existing `worker.py` remains the
legacy queue worker, preventing wind evidence changes from silently altering
the backend's still-current queue path. The service selects the worker from the
verified active model manifest, never from a caller-supplied module or path.
Gate 4 removes both the compatibility endpoints and all queue implementation
after integrated browser cutover and the required workspace audit.

The results endpoint may remain as a convenience projection of
`summary.json`/`daily-kpis.csv`; it is not authoritative over those artifacts.
Event pagination is ascending sequence, `after` is exclusive, and `limit` is
`1..1000`.

## Safety and finite execution limits

Gate 1 freezes these service limits:

| Limit | Value |
| --- | ---: |
| Active workers globally | `2` |
| Active workers per project | `1` |
| Seeds per Gate 1 experiment | `1` |
| Turbines / crews / horizon | `500 / 50 / 3660 days` |
| Parent wall timeout | `180 seconds` |
| Processed scheduled events | `2,000,000` |
| Emitted domain events | `2,000,000` |
| Pending scheduler events | `4096` |
| Domain event artifact | `256 MiB` |
| Daily KPI artifact | `16 MiB` |
| Run log | `4 MiB` |
| Total successful run artifacts | `300 MiB` |

The wind worker streams events and KPI rows, keeps bounded accumulators, polls the
cancel marker at least every 100 processed events and every day boundary, and
fails rather than truncates when a limit is reached. The parent keeps its
existing process-group termination behavior. Unknown IDs, traversal, symlinks,
arbitrary model paths, non-finite numbers, and undeclared artifacts fail closed.
The worker receives no network credentials and imports only the manifest-
verified reviewed bundle.

Successful outputs are written under `<run-id>.tmp/` with per-file atomic
replacement and `fsync`. The service validates the full required artifact set,
identities, declared digests, sizes, and schemas before atomically promoting
the directory. Failure, cancellation, and timeout remove partial evidence
outputs and retain only bounded `request.json`, `metadata.json`, and `run.log`.
The queue worker retains its existing 30-second default; wind runs use the
explicit 180-second finite limit rather than inheriting that likely-insufficient
default.

The fixed baseline must complete with all 100 turbines, 1095 days, and every
domain event under these limits. A limit may be increased in review if measured
baseline evidence requires it, but the run may never silently reduce turbines,
horizon, events, or metrics.

## Test matrix and required evidence

| Test layer | Required proof |
| --- | --- |
| Source/spec | All 12 equipment and 9 crew transitions have a direct, combined, adapted, or deferred disposition; source hash and exclusions match Gate 0. |
| Parameters | Exact keys, types, bounds, cross-field constraints, provenance tags, reset defaults, one-seed and horizon/warm-up limits. |
| Scheduler | Four phases, descending sequence inside phase, centralized dispatch, stable crew ID, zero-distance handling, stale-token invalidation. |
| Mechanisms | Failure sampled only on operating entry; overdue/age factors; corrective priority; FIFO; supersession/conversion; one order/type; one crew/turbine; same-crew overdue maintenance; return-home behavior; replacement branch. |
| Invariants | State counts conserve population; no turbine/crew double assignment; queues contain only queued valid orders; time/costs/counts non-negative and finite. |
| Micro-case | Ordered events and every hand oracle above match exactly. |
| Reproducibility | Two independent runs of the same revision/experiment/seed have the same canonical event digest and same KPI/summary semantic digest. |
| Drift | Editing stable code definitions without regenerating spec/schema/traceability fails; missing source disposition or digest mismatch fails. |
| Worker/API | Wind and legacy schemas selected strictly by active model; backend/web unchanged; immutable wind revisions, cancellation, timeout, bounded failure retention, pagination, traversal rejection, declared artifacts, validation before atomic promotion. |
| Identity/nonclaims | Every artifact agrees on IDs/seed/preset and retains all five claim labels; deliberate identity mutation fails validation. |
| Baseline | 100 turbines, 3 crews, 1095 days, warm-up 365, seed 2; 1096 daily rows; no event truncation; terminal success under finite limits. |

Required commands after implementation:

```bash
set -eu

uv sync --project mesa_service --extra test --frozen
uv run --project mesa_service pytest -q
uv run --project mesa_service python -m mesa_service.run_baseline \
  --preset wind-turbine-maintenance-demo-v1 \
  --output-dir .gate-1-evidence/wind-baseline

bundle_root=".gate-1-evidence/.gate1-reviewed-bundle/models/wind-turbine-maintenance/revisions"
if [ ! -d "$bundle_root" ]; then
  echo "bundle revision root is missing: $bundle_root" >&2
  exit 1
fi
bundle_count=$(
  find "$bundle_root" -mindepth 1 -maxdepth 1 -type d -name 'mr_*' -print |
    awk 'END { print NR + 0 }'
)
if [ "$bundle_count" -ne 1 ]; then
  echo "expected exactly one model revision under $bundle_root; found $bundle_count" >&2
  exit 1
fi
bundle_dir=$(
  find "$bundle_root" -mindepth 1 -maxdepth 1 -type d -name 'mr_*' -print
)

uv run --project mesa_service python -m mesa_service.verify_bundle "$bundle_dir"
uv run --project mesa_service python -m mesa_service.verify_run \
  .gate-1-evidence/wind-baseline
```

The PR records test output, baseline elapsed time, event count, artifact sizes,
canonical event digest, final identity tuple, and the summary non-claims. Raw
baseline evidence is generated/ignored unless the implementation PR explicitly
reviews a small immutable evidence fixture for tracking.

## Exact implementation ownership

Implementation agents must not edit another owner's files without handing the
file back to the governor and waiting for reassignment.

### Model-core owner

Owns only:

```text
mesa_service/src/mesa_service/models/wind_turbine_maintenance/__init__.py
mesa_service/src/mesa_service/models/wind_turbine_maintenance/model.py
mesa_service/src/mesa_service/models/__init__.py
mesa_service/tests/fixtures/wind_turbine_microcase.json
mesa_service/tests/fixtures/wind_turbine_replacement_microcase.json
mesa_service/tests/test_wind_turbine_model.py
```

Delivers agents, records, scheduler, rules, random streams, metrics, stable code
definitions, and the exact micro-case. It does not edit API, service, worker, or
bundle code.

### Bundle-and-contract owner

Owns only:

```text
mesa_service/src/mesa_service/wind_contracts.py
mesa_service/src/mesa_service/bundle.py
mesa_service/src/mesa_service/verify_bundle.py
mesa_service/src/mesa_service/model_assets/wind_turbine_maintenance/**
mesa_service/tests/test_wind_turbine_bundle.py
```

Delivers schema validation, defaults, code-exported JSON, provenance,
content-addressed revisions, drift checks, and source-transition disposition.
It consumes model-core exports but does not change model behavior.

### Worker-and-API owner

Owns only:

```text
mesa_service/src/mesa_service/app.py
mesa_service/src/mesa_service/service.py
mesa_service/src/mesa_service/wind_worker.py
mesa_service/src/mesa_service/run_baseline.py
mesa_service/src/mesa_service/verify_run.py
mesa_service/tests/test_wind_api.py
mesa_service/tests/test_wind_worker_evidence.py
mesa_service/README.md
docs/mesa-service.md
docs/test-plan.md
```

Delivers canonical routes, experiment materialization, isolated execution,
streamed artifacts, limits, pagination, identity validation, cancellation, and
baseline commands. It does not change model rules or generated schemas. It also
does not change `backend/`, `web/`, legacy `contracts.py`, legacy `worker.py`,
or legacy `test_api.py`; `service.py` dispatches to the new wind worker by
verified active model ID. Its documentation edits report achieved Gate 1
evidence while preserving the later Gate 2-4 boundaries.

### Integration verifier

Is read-only. It runs the complete matrix, independently checks the micro-case
arithmetic, mutates copied artifacts to prove drift/identity failures, audits
all source dispositions and non-claims, and reports blocking findings to the
governor. The governor alone coordinates file reassignment, resolves interface
conflicts, accepts evidence, and decides whether Gate 1 may proceed to PR.

## Remaining decisions

There are no unresolved mechanism or interface decisions blocking
implementation. The only review-tunable values are the finite worker resource
ceilings; changing them requires measured baseline evidence and explicit PR
review, not silent fallback or reduced experiment scope.
